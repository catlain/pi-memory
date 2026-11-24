/**
 * 记忆路由核心（判定编排层）：信号池取批 → 两段判定（S1 领域名提取 → S2 词表映射）→ 倒排匹配 → 未读/未提示过滤 → ephemeral:hint + settle-continue。
 * 信号采集见 signal-pool.ts；判定器配置见 keyword-routing.ts。
 */
import { createJudge, type JudgeInstance } from "@pi-atelier/shared-utils/judge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectMemoryAssets, collectSpecAssets } from "./asset-catalog";
import { buildVocabulary, matchAssets, buildHintText, parseKeywords, parseTopics, MAP_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT } from "./keyword-routing";
import type { KnowledgeAsset } from "./asset-catalog";
import { createReadTracker } from "./read-tracker";
import { loadConfig, setRoutingConfig, type RoutingConfig } from "./routing-config";
import { SignalPool } from "./signal-pool";
import { PromptedSet } from "./prompted-set";

export { loadConfig, setRoutingConfig };

/** S2 词库匹配解析：parseKeywords 词库过滤后可能为 null（全部词表外），归一为空数组 */
const parseMap: (raw: string) => string[] = (raw) => parseKeywords(raw) ?? [];

/** S1 领域名提取解析：无可命名领域 → 空集（S2 不调用） */
const parseTopicList: (raw: string) => string[] = (raw) => parseTopics(raw) ?? [];

/** 幂等去重上限：超过则整表清空（防长会话无界增长） */
const JUDGED_CAP = 50;

export class MemoryRouter {
	config: RoutingConfig;
	private pool = new SignalPool();

	/** 只读可观测点：池内累计字符数（测试/诊断用，不外露池本身） */
	get poolChars(): number {
		return this.pool.chars;
	}
	private judgedBatches = new Set<string>();
	private judgeInstance: JudgeInstance<string[]> | null = null;
	private topicJudge: JudgeInstance<string[]> | null = null;
	private pendingCtx: unknown = null;
	private prompted = new PromptedSet();
	/** 待注入计数：agent_before_settle 读到即消费（单次 continue），驱动下一 provider request */
	private pendingHintCount = 0;

	readonly readTracker = createReadTracker();

	constructor(private cwd: string, config: RoutingConfig) {
		this.config = { ...config };
	}

	setConfig(cfg: RoutingConfig): void {
		this.config = { ...cfg };
	}

	/** message_end 事件的 ExtensionContext —— judge 调 LLM 的必要通道，首个事件到达时注入 */
	setJudgeContext(ctx: unknown): void {
		this.pendingCtx = ctx;
		if (this.judgeInstance) (this.judgeInstance as unknown as { setContext(c: unknown): void }).setContext(ctx);
		if (this.topicJudge) (this.topicJudge as unknown as { setContext(c: unknown): void }).setContext(ctx);
	}

	/** message_end：叙述 + 工具摘要入池 */
	accumulate(event: unknown): void {
		if (!this.config.enabled) return; // 快照级；跨会话 off 感知靠 maybeTrigger 热读
		this.pool.accumulate(event);
	}

	/** tool_result：报错入池 */
	observeToolResult(toolName: string, args: unknown, isError: boolean, result: unknown): void {
		this.pool.observeToolResult(toolName, args, isError, result);
	}

	/** agent_before_settle：消费待注入提醒——补发空消息保队列有货，continue 才合法 */
	consumePendingHint(pi: ExtensionAPI): boolean {
		if (this.pendingHintCount <= 0) return false;
		this.pendingHintCount = 0;
		try {
			pi.sendMessage({ customType: "memory-routing-hint", display: false, content: "" }, { triggerTurn: false });
			return true;
		} catch {
			return false; // 补发失败不 continue（fail-open）
		}
	}

	/** 可观测：已读计数 + 已提示集合数 */
	diagnostics(): { readPaths: number; prompted: number } {
		return { readPaths: this.readTracker.snapshot().length, prompted: this.prompted.size };
	}

	async maybeTrigger(pi: ExtensionAPI, opts?: { endOfTurn?: boolean }): Promise<void> {
		// 配置热读：跨会话立即感知 off/N 变更（写入层为全局 settings）
		this.config = loadConfig(this.cwd);
		if (!this.config.enabled) {
			this.pool.clear();
			return;
		}
		const batch = this.pool.takeBatch(this.config.batchChars);
		if (!batch) return;
		const narrative = batch.lines.join("\n");
		const hash = sha1Lite(narrative);
		if (this.judgedBatches.has(hash)) return;
		this.judgedBatches.add(hash);
		if (this.judgedBatches.size > JUDGED_CAP) this.judgedBatches.clear();
		try {
			const keywords = await this.judgeBatch(narrative, `batch-${hash}(${batch.chars}字)`);
			if (!keywords || keywords.length === 0) return;

			const assets: KnowledgeAsset[] = collectMemoryAssets(this.cwd);
			if (this.config.includeSpecs) assets.push(...collectSpecAssets(this.cwd));
			const candidates = matchAssets(keywords, assets)
				.filter((a) => !this.readTracker.hasRead(a.entry) && !this.prompted.has(a.entry))
				.slice(0, 3);
			if (candidates.length === 0) return;
			if (!this.config.enabled) return; // emit 前飞行拦截（off 后判定返回时拦截）

			for (const a of candidates) this.prompted.add(a.entry);
			pi.events.emit("ephemeral:hint", buildHintText(candidates, keywords, this.cwd));
			// 回合末才 settle-continue；工具循环中间的注入由下一循环请求自然 drain
			if (opts?.endOfTurn !== false) this.pendingHintCount = 1;
		} catch {
			/* fail-open */
		}
	}

	/** 两段判定：S1 提取领域名（无词表、不判断新不新）→ S2 领域名→词表原样词（纯映射，不给批） */
	private async judgeBatch(narrative: string, contextLabel: string): Promise<string[]> {
		const assets: KnowledgeAsset[] = collectMemoryAssets(this.cwd);
		if (this.config.includeSpecs) assets.push(...collectSpecAssets(this.cwd));
		const vocab = buildVocabulary(assets);
		if (vocab.length === 0) return [];
		const { topic, map } = this.ensureJudges();
		const judgeOpts = { contextLabel, model: this.config.judgeModel || undefined };
		const topics = await topic.judge({
			question: "列出这段工作记录正在处理的知识领域名称（每行一个，最多 5 个，无可命名领域输出“无”）。",
			text: narrative,
			...judgeOpts,
		});
		if (!topics || topics.length === 0) return [];
		const mapped = await map.judge({
			question: "为下列领域名称在词库中找出最相关的词（只输出词库原样词，每行一个，最多 5 个，均不相关输出“无”）。\n词库：" + vocab.join("、"),
			text: topics.join("\n"),
			...judgeOpts,
		});
		return mapped ?? [];
	}

	private ensureJudges() {
		const logDir = `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.pi/agent/logs/`;
		const mk = (label: string, systemPrompt: string, parse: (raw: string) => string[]): JudgeInstance<string[]> => {
			const inst = createJudge<string[]>({
				label,
				systemPrompt,
				parse,
				judgeLogPath: `${logDir}memory-routing-llmjudge.log`,
				legacySectionKeys: ["memoryRouting", "shepherd"],
			});
			if (this.pendingCtx != null) (inst as unknown as { setContext(c: unknown): void }).setContext(this.pendingCtx);
			return inst;
		};
		this.topicJudge ??= mk("memory-routing-topics", TOPIC_SYSTEM_PROMPT, parseTopicList);
		this.judgeInstance ??= mk("memory-routing-map", MAP_SYSTEM_PROMPT, parseMap);
		return { topic: this.topicJudge, map: this.judgeInstance };
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
