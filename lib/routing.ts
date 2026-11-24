import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getEffectiveConfig, patchSettingsSection } from "@pi-atelier/shared-utils";
import { createJudge, type JudgeInstance } from "@pi-atelier/shared-utils/judge";
import { collectMemoryAssets, collectSpecAssets, type KnowledgeAsset } from "./asset-catalog";
import { createReadTracker } from "./read-tracker";
import { buildVocabulary, matchAssets, parseKeywords } from "./keyword-routing";

/** 记忆路由配置（settings memoryRouting 段；judgeModel 缺省走共享三层链） */
export interface RoutingConfig {
	enabled: boolean;
	/** 判定触发字符阈值：叙述/工具摘要/报错共用字符池，满则判（tumbling window） */
	batchChars: number;
	/** openspec specs 目录的 capability 进判定资产池 */
	includeSpecs: boolean;
	/** 显式判定模型（缺省 = judgeModel 顶层/legacy/会话默认三层链） */
	judgeModel: string;
}

const DEFAULTS: RoutingConfig = { enabled: true, batchChars: 1200, includeSpecs: true, judgeModel: "" };

/** 单信号行截断 */
const LINE_CAP = 2000;

const SYSTEM_PROMPT =
	"你是主题路由标注器。你会收到一个主题词库和一段 AI 工作记录（含 [叙述]/[tool]/[tool✗] 三类标签行，报错信号已在行内）。" +
	"你的任务：【只能从词库中选出】与工作记录最相关的主题关键词，每行一个，最多 5 个。" +
	"禁止自创词库外的词；词库内确实无合适项时只输出：无。" +
	"只输出词本身，不要解释、不要编号、不要标点符号前后缀。";

export function loadConfig(cwd: string): RoutingConfig {
	const r = getEffectiveConfig("memoryRouting", { ...DEFAULTS }, cwd) as { config?: Partial<RoutingConfig> };
	return { ...DEFAULTS, ...(r.config ?? {}) };
}

export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
	return patchSettingsSection<RoutingConfig>("memoryRouting", patch, DEFAULTS);
}

/** 工具调用参数摘要：bash 取 command，read/edit 取 path，其余 JSON 截断 */
function summarizeToolCall(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.command === "string") return `${toolName}: ${a.command.slice(0, LINE_CAP)}`;
	if (typeof a.path === "string") return `${toolName}: ${a.path}`;
	try {
		return `${toolName}: ${JSON.stringify(a).slice(0, 150)}`;
	} catch {
		return toolName;
	}
}

/** 报错摘要：截 200 字头部（特征码区） */
function summarizeError(result: unknown): string {
	const s = typeof result === "string" ? result : JSON.stringify(result);
	return String(s).slice(0, 200);
}

/**
 * 记忆路由核心：字符池（三信号源）→ 计满批量判定（词表路由）→ 倒排匹配 →
 * 未读过滤 → shepherd ephemeral:hint（不进 session 历史，无勿荐降权）。
 */
export class MemoryRouter {
	config: RoutingConfig;
	private buffer: string[] = [];
	private charCount = 0;
	private judgedBatches = new Set<string>();
	private judgeInstance: JudgeInstance<string[]> | null = null;
	readonly readTracker = createReadTracker();

	constructor(private cwd: string, config: RoutingConfig) {
		this.config = { ...config };
	}

	setConfig(cfg: RoutingConfig): void {
		this.config = { ...cfg };
	}

	/** message_end：叙述（text 块）+ 工具摘要（toolCall 块）入池 */
	accumulate(event: unknown): void {
		try {
			const msg = (event as { message?: { content?: unknown } }).message;
			const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
			const lines: string[] = [];
			for (const b of blocks) {
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
					lines.push(`[叙述] ${b.text.slice(0, LINE_CAP)}`);
				} else if (b.type === "toolCall" && typeof b.name === "string") {
					lines.push(`[tool] ${summarizeToolCall(b.name, b.arguments).slice(0, LINE_CAP)}`);
				}
			}
			this.push(lines);
		} catch {
			/* 信号提取失败静默 */
		}
	}

	/** tool_result：报错（isError）入池（成功结果体积大信号弱不入） */
	observeToolResult(toolName: string, args: unknown, isError: boolean, result: unknown): void {
		if (!isError) return;
		this.push([`[tool✗] ${toolName} → ${summarizeError(result)}`]);
	}

	private push(lines: string[]): void {
		for (const l of lines) {
			this.buffer.push(l);
			this.charCount += l.length;
		}
		if (this.charCount > 6000) this.buffer = this.buffer.slice(-10);
	}

	private takeBatch(): { lines: string[]; chars: number } | null {
		if (this.charCount < this.config.batchChars) return null;
		const lines = this.buffer.splice(0);
		const chars = this.charCount;
		this.charCount = 0;
		return { lines, chars };
	}

	private ensureJudge() {
		if (!this.judgeInstance) {
			this.judgeInstance = createJudge<string[]>({
				label: "memory-routing",
				systemPrompt: SYSTEM_PROMPT,
				parse: parseKeywords,
				judgeLogPath: `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.pi/agent/logs/memory-routing-llmjudge.log`,
				legacySectionKeys: ["memoryRouting", "shepherd"],
			});
		}
		return this.judgeInstance;
	}

	async maybeTrigger(pi: ExtensionAPI): Promise<void> {
		const batch = this.takeBatch();
		if (!batch) return;
		const narrative = batch.lines.join("\n");
		const hash = sha1Lite(narrative);
		if (this.judgedBatches.has(hash)) return;
		this.judgedBatches.add(hash);
		if (this.judgedBatches.size > 50) this.judgedBatches.clear();
		try {
			const assets: KnowledgeAsset[] = collectMemoryAssets(this.cwd);
			if (this.config.includeSpecs) assets.push(...collectSpecAssets(this.cwd));
			if (assets.length === 0) return;
			const vocab = buildVocabulary(assets);
			if (vocab.length === 0) return;

			const keywords = await this.ensureJudge().judge({
				question:
					"从下方词库中【只能选不能创造】与本批工作记录最相关的主题关键词（每行一个，≤5 个，无合适输出“无”）。\n词库：" +
					vocab.join("、"),
				text: narrative,
				contextLabel: `batch-${hash}(${batch.chars}字)`,
				model: this.config.judgeModel || undefined,
			});
			if (!keywords || keywords.length === 0) return;

			const hits = matchAssets(keywords, assets);
			const candidates = hits.filter((a) => !this.readTracker.hasRead(a.entry)).slice(0, 3);
			if (candidates.length === 0) return;

			const lines = candidates.map((a) => `- ${a.entry}（${a.desc.slice(0, 60)}）`).join("\n");
			const stems = candidates.map((a) => (a.entry.split("/").pop() ?? "").split("--")[0]).join("、");
			pi.events.emit("ephemeral:hint", {
				text: `💡 记忆路由：本段工作与以下知识资产相关（你尚未读过）：\n${lines}\n如相关请 read；无关可忽略。`,
				short: `💡 记忆路由：${stems}`,
			});
		} catch {
			/* fail-open */
		}
	}
}

/** 轻量 sha1（幂等去重用，非安全场景） */
function sha1Lite(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}
