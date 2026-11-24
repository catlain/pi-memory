/**
 * 记忆路由核心：三信号源积累 → 字符池批式触发 → LLM 主题关键词标注 → 程序匹配资产 → ephemeral 提醒（不进 session 历史）
 * 方案：openspec/changes/memory-routing（v2.1 定稿）
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJudge } from "@pi-atelier/shared-utils/judge";
import { getEffectiveConfig, patchSettingsSection } from "@pi-atelier/shared-utils";
import { collectMemoryAssets, collectSpecAssets, type KnowledgeAsset } from "./asset-catalog";
import { createReadTracker, filterVerdictPaths } from "./read-tracker";

export interface RoutingConfig {
	enabled: boolean;
	batchChars: number;
	includeSpecs: boolean;
	judgeModel: string;
}

const DEFAULTS: RoutingConfig = { enabled: true, batchChars: 1200, includeSpecs: true, judgeModel: "" };

const NARRATIVE_CAP = 6000; // 叙事窗口上限（截尾防撑爆）
/** 单信号行截断 */
const LINE_CAP = 2000;

const SYSTEM_PROMPT =
	"你是主题标注器。阅读 AI 工作记录（含 [叙述]/[tool]/[tool✗] 三类标签行，报错信号已在行内），" +
	"提炼其涉及的核心主题关键词（技术域/工具名/问题类型/报错特征），每行一个，最多 5 个。" +
	"只输出关键词本身，不要解释、不要编号、不要路径、不要标点符号前后缀。" +
	"没有明确技术主题时只输出：无";

export function loadConfig(cwd: string): RoutingConfig {
	const r = getEffectiveConfig("memoryRouting", { ...DEFAULTS }, cwd) as { config?: Partial<RoutingConfig> };
	return { ...DEFAULTS, ...(r.config ?? {}) };
}



export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
	return patchSettingsSection<RoutingConfig>("memoryRouting", patch, DEFAULTS);
}

/** 判定输出解析：词级容错（分隔符拆分 + 短词过滤），返回 null=判定作废 */
export function parseKeywords(raw: string): string[] | null {
	const lines = raw.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 1 && /^(无|none|n\/a)$/i.test(lines[0])) return [];
	const out: string[] = [];
	for (const line of lines) {
		const toks = line.split(/[\s,，、;；|]+/).filter((t) => t.length >= 2 && t.length <= 40);
		for (const t of toks.slice(0, 3)) if (!out.includes(t)) out.push(t);
	}
	return out.length ? out.slice(0, 5) : null;
}

/** 关键词 × 资产元数据匹配（substring 双向：hay 含 kw，或 kw 含资产主词） */
export function matchAssets(keywords: string[], assets: KnowledgeAsset[]): KnowledgeAsset[] {
	const kws = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);
	const hits: KnowledgeAsset[] = [];
	for (const a of assets) {
		const stem = (a.entry.split("/").pop() ?? "").split("--")[0].toLowerCase();
		const hay = `${a.entry}\n${a.desc}`.toLowerCase();
		const hit = kws.some((k) => hay.includes(k) || (stem.length >= 3 && k.includes(stem)));
		if (hit && !hits.some((h) => h.entry === a.entry)) hits.push(a);
	}
	return hits;
}

/** 工具调用参数摘要：bash 取 command，read/edit 取 path，其余 JSON 截断 */
function summarizeToolCall(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.command === "string") return `${toolName}: ${a.command.slice(0, LINE_CAP)}`;
	if (typeof a.path === "string") return `${toolName}: ${a.path}`;
	try {
		return `${toolName}: ${JSON.stringify(a).slice(0, 150)}`;
	} catch {
		return `${toolName}: [unserializable args]`;
	}
}

/** 报错内容摘要（头部特征码） */
export function summarizeToolError(result: unknown): string {
	let text = "";
	if (typeof result === "string") text = result;
	else if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.error === "string") text = r.error;
		else if (typeof r.output === "string") text = r.output;
		else {
			try {
				text = JSON.stringify(result);
			} catch {
				text = "[unserializable]";
			}
		}
	}
	return text.slice(0, LINE_CAP);
}

export class MemoryRouter {
	readonly cwd: string;
	readonly readTracker = createReadTracker();
	config: RoutingConfig;
	private buffer: string[] = [];
	private charCount = 0;
	private judgedBatches = new Set<string>();
	private judge: ReturnType<typeof createJudge<string[]>> | null = null;

	constructor(cwd: string, config?: Partial<RoutingConfig>) {
		this.cwd = cwd;
		this.config = { ...DEFAULTS, ...config };
	}

	/** message_end：叙述 + 工具调用摘要入池（D3 三信号源） */
	accumulate(event: { message?: { content?: unknown } }): void {
		if (!this.config.enabled) return;
		const blocks = Array.isArray(event.message?.content) ? (event.message!.content as Array<Record<string, unknown>>) : [];
		for (const b of blocks) {
			if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
				this.push(`[叙述] ${b.text.slice(0, LINE_CAP)}`);
			} else if (b.type === "toolCall") {
				const name = typeof b.name === "string" ? b.name : "tool";
				this.push(`[tool] ${summarizeToolCall(name, b.arguments)}`);
			}
		}
	}

	/** tool_result：仅报错入池（成功结果体积大信号弱不进） */
	observeToolResult(toolName: string, args: unknown, isError: boolean, result: unknown): void {
		if (!this.config.enabled || !isError) return;
		this.push(`[tool✗] ${summarizeToolError(result)}`);
	}

	private push(line: string): void {
		this.buffer.push(line);
		this.charCount += line.length;
	}

	private takeBatch(): { lines: string[]; chars: number } | null {
		if (this.charCount < this.config.batchChars) return null;
		const lines = this.buffer.splice(0);
		const chars = this.charCount;
		this.charCount = 0;
		return { lines, chars };
	}

	private ensureJudge() {
		if (this.judge) return this.judge;
		this.judge = createJudge<string[]>({
			label: "memory-routing",
			systemPrompt: SYSTEM_PROMPT,
			parse: parseKeywords,
			judgeLogPath: "C:/Users/Administrator/.pi/agent/logs/memory-routing-llmjudge.log",
			legacySectionKeys: ["memoryRouting", "shepherd"],
		});
		return this.judge;
	}

	async maybeTrigger(pi: ExtensionAPI): Promise<void> {
		if (!this.config.enabled) return;
		const batch = this.takeBatch();
		if (!batch) return;
		try {
			const narrative = batch.lines.join("\n").slice(-NARRATIVE_CAP);
			const hash = Buffer.from(narrative).toString("base64").slice(0, 8);
			if (this.judgedBatches.has(hash)) return;
			this.judgedBatches.add(hash);
			if (this.judgedBatches.size > 50) this.judgedBatches.clear();

			const assets: KnowledgeAsset[] = collectMemoryAssets(this.cwd);
			if (this.config.includeSpecs) assets.push(...collectSpecAssets(this.cwd));
			if (assets.length === 0) return;

			const keywords = await this.ensureJudge().judge({
				question: "标注这批工作记录的主题关键词（每行一个，≤5 个）",
				text: narrative,
				contextLabel: `batch-${hash}(${batch.chars}字)`,
				model: this.config.judgeModel || undefined,
			});
			if (!keywords || keywords.length === 0) return;

			const hits = matchAssets(keywords, assets);
			const validEntries = filterVerdictPaths(hits.map((a) => a.entry), assets.map((a) => a.entry));
			const candidates = hits
				.filter((a) => validEntries.includes(a.entry))
				.filter((a) => !this.readTracker.hasRead(a.entry))
				.slice(0, 3);
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

	setEnabled(v: boolean): void {
		this.config.enabled = v;
	}
}
