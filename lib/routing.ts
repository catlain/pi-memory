import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJudge, type JudgeInstance } from "@pi-atelier/shared-utils/judge";
import { collectMemoryAssets, collectSpecAssets, type KnowledgeAsset } from "./asset-catalog";
import { buildHintText, buildVocabulary, matchAssets, parseKeywords } from "./keyword-routing";
import { PromptedSet } from "./prompted-set";
import { loadConfig, type RoutingConfig } from "./routing-config";
import { createReadTracker } from "./read-tracker";

export { loadConfig, setRoutingConfig, DEFAULTS } from "./routing-config";

/** 单信号行截断 */
const LINE_CAP = 2000;

const SYSTEM_PROMPT =
	"你是主题路由标注器。你会收到一个主题词库和一段 AI 工作记录（含 [叙述]/[tool]/[tool✗] 三类标签行，报错信号已在行内）。" +
	"你的任务：【只能从词库中选出】与工作记录最相关的主题关键词，每行一个，最多 5 个。" +
	"禁止自创词库外的词；词库内确实无合适项时只输出：无。" +
	"只输出词本身，不要解释、不要编号、不要标点符号前后缀。";

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

/** 记忆路由核心：字符池（三信号源）→ 计满同步判定（词表路由）→ 倒排匹配 → 未读过滤 → ephemeral:hint + settle-continue */
export class MemoryRouter {
	config: RoutingConfig;
	private buffer: string[] = [];
	private charCount = 0;
	private judgedBatches = new Set<string>();
	private judgeInstance: JudgeInstance<string[]> | null = null;
	private pendingCtx: unknown = null;
	private prompted = new PromptedSet();
	/** 待注入计数：agent_before_settle 读到即消费（单次 continue），驱动下一 provider request */
	private pendingHintCount = 0;

	/** message_end 事件的 ExtensionContext —— judge 调 LLM 的必要通道，首个事件到达时注入 */
	setJudgeContext(ctx: unknown): void {
		this.pendingCtx = ctx;
		if (this.judgeInstance) (this.judgeInstance as unknown as { setContext(c: unknown): void }).setContext(ctx);
	}
	readonly readTracker = createReadTracker();

	constructor(private cwd: string, config: RoutingConfig) {
		this.config = { ...config };
	}

	setConfig(cfg: RoutingConfig): void {
		this.config = { ...cfg };
	}

	/** message_end：叙述（text 块）+ 工具摘要（toolCall 块）入池 */
	accumulate(event: unknown): void {
		if (!this.config.enabled) return; // 快照级；跨会话 off 感知靠 maybeTrigger 热读
		try {
			const msg = (event as { message?: { role?: string; content?: unknown } }).message;
			// 只判 assistant：toolResult 的 text 块是工具结果正文，入池即秒满门槛（D3：成功结果不入池）
			if (msg?.role !== "assistant") return;
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
			if (this.pendingCtx != null) (this.judgeInstance as unknown as { setContext(c: unknown): void }).setContext(this.pendingCtx);
		}
		return this.judgeInstance;
	}

	/** agent_before_settle：有待注入提醒时返回 true（调用即消费，单次 continue 驱动下一请求） */
	consumePendingHint(): boolean {
		if (this.pendingHintCount > 0) {
			this.pendingHintCount = 0;
			return true;
		}
		return false;
	}

	/** 可观测：已读计数 + 已提示集合数 */
	diagnostics(): { readPaths: number; prompted: number } {
		return { readPaths: this.readTracker.snapshot().length, prompted: this.prompted.size };
	}

	async maybeTrigger(pi: ExtensionAPI): Promise<void> {
		// 配置热读：跨会话立即感知 off/N 变更（写入层为全局 settings）
		this.config = loadConfig(this.cwd);
		if (!this.config.enabled) {
			this.buffer = [];
			this.charCount = 0;
			return;
		}
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
			const candidates = hits
				.filter((a) => !this.readTracker.hasRead(a.entry) && !this.prompted.has(a.entry))
				.slice(0, 3);
			if (candidates.length === 0) return;
			if (!this.config.enabled) return; // emit 前飞行拦截（off 后判定返回时拦截）

			for (const a of candidates) this.prompted.add(a.entry);

			pi.events.emit("ephemeral:hint", buildHintText(candidates, keywords, this.cwd));
			// settle-continue（对齐 shepherd ADR-025）：空 sendMessage 驱动 pendingCustomContext，settle 读计数 continue → 下一 request drain 注入
			this.pendingHintCount = 1;
			try {
				pi.sendMessage({ customType: "memory-routing-hint", display: false, content: "" }, { triggerTurn: false });
			} catch {
				/* 驱动失败时计数保留——下轮 settle 仍可消费 */
			}
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
