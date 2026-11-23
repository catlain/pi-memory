/**
 * memory-routing 核心路由器：计数 → 批量判定 → 白名单校验 → 注入。
 * 事件接线与命令注册见 routing-register.ts。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getEffectiveConfig, patchSettingsSection } from "@pi-atelier/shared-utils";
import { createJudge } from "@pi-atelier/shared-utils/judge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectMemoryAssets,
	collectSpecAssets,
	type KnowledgeAsset,
} from "./asset-catalog";
import { ReadTracker, filterVerdictPaths } from "./read-tracker";

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
const JUDGE_LOG = join(AGENT_DIR, "logs", "memory-routing-llmjudge.log");
const lastBatchHashes: string[] = [];
const DEDUP_WINDOW = 3;

export interface RoutingConfig {
	enabled: boolean;
	batchSize: number;
	includeSpecs: boolean;
	judgeModel: string;
}

export function loadConfig(cwd: string): RoutingConfig {
	const { config } = getEffectiveConfig(
		"memoryRouting",
		{ enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "" },
		cwd,
	);
	return {
		enabled: config.enabled !== false,
		batchSize: Math.max(1, Number(config.batchSize) || 5),
		includeSpecs: config.includeSpecs !== false,
		judgeModel: String(config.judgeModel ?? ""),
	};
}

/** 持久化配置到 settings.json（全局层；读仍三层合并，与生态 /aging-config 同形态） */
export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
	return patchSettingsSection<RoutingConfig>(
		"memoryRouting",
		patch,
		{ enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "" },
	);
}

const SYSTEM_PROMPT =
	"你是知识资产路由判定器。根据会话最近的 AI 叙述，判断与哪些【未读】资产强相关。\n" +
	"输出格式：每行一个路径（逐字取自清单），最多 3 条；无相关则只输出「无」。\n" +
	"规则：只推荐未读条目；提醒 2+ 次仍未读的条目不再推荐；路径禁止构造，必须逐字来自清单。";

function parsePathList(raw: string): string[] | null {
	const lines = raw.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return null;
	if (lines.length === 1 && /^(无|none|n\/a)$/i.test(lines[0])) return [];
	const bad = lines.find((l) => l.includes(" ") || l.length > 200);
	if (bad) return null;
	return lines.slice(0, 3);
}

export const routingJudge = createJudge<string[]>({
	label: "memory-routing",
	systemPrompt: SYSTEM_PROMPT,
	parse: parsePathList,
	judgeLogPath: JUDGE_LOG,
	legacySectionKeys: ["memoryRouting", "shepherd"],
});

export class MemoryRouter {
	private buffer: string[] = [];
	private seen = 0;
	private remindedCount = new Map<string, number>();
	private config: RoutingConfig;
	private readTracker = new ReadTracker();
	private cwd: string;
	constructor(cwd: string, config?: RoutingConfig) {
		this.cwd = cwd;
		this.config = config ?? loadConfig(cwd);
	}
	get enabled(): boolean { return this.config.enabled; }
	setConfig(patch: Partial<RoutingConfig>): void {
		this.config = { ...this.config, ...patch };
	}
	/** message_end：积累 text 块（纯 tool 轮不计数） */
	accumulate(event: unknown): void {
		if (!this.config.enabled) return;
		const message = (event as { message?: { role?: string; content?: unknown[] } }).message;
		if (!message || message.role !== "assistant") return;
		const blocks = Array.isArray(message.content) ? message.content : [];
		const texts = blocks
			.filter((b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.filter((t) => t && t.trim().length > 0);
		if (texts.length === 0) return;
		this.seen += 1;
		this.buffer.push(texts.join("\n"));
	}
	/** 计满触发异步判定（fire-and-forget，异常静默 = fail-open） */
	async maybeTrigger(pi?: ExtensionAPI): Promise<void> {
		if (!this.config.enabled) return;
		if (this.seen < this.config.batchSize) return;
		const batch = this.buffer.splice(0, this.buffer.length);
		this.seen = 0;
		try {
			await this.runBatch(batch, pi);
		} catch {
			// fail-open：静默丢弃本批（specs §1.5）
		}
	}
	private async runBatch(batch: string[], pi?: ExtensionAPI): Promise<void> {
		const narrative = batch.join("\n---\n").slice(-6000);
		const hash = createHash("sha1").update(narrative).digest("hex");
		if (lastBatchHashes.includes(hash)) return; // 幂等
		lastBatchHashes.push(hash);
		if (lastBatchHashes.length > DEDUP_WINDOW) lastBatchHashes.shift();
		const assets = [
			...collectMemoryAssets(this.cwd),
			...(this.config.includeSpecs ? collectSpecAssets(this.cwd) : []),
		];
		const candidates = assets.filter((a) => !this.readTracker.hasRead(a.entry));
		if (candidates.length === 0) return;
		const catalog = candidates
			.map((a: KnowledgeAsset) => {
				const n = this.remindedCount.get(a.entry) ?? 0;
				const noted = n > 0 ? `（已提醒 ${n} 次未读）` : "";
				const kind = a.entry.startsWith("openspec/") ? "spec" : "memory";
				return `- ${a.entry}${noted} [${kind}] ${a.desc}`;
			})
			.join("\n");
		const paths = await routingJudge.judge({
			question: "判断这批 AI 叙述与哪些未读知识资产强相关，输出路径清单",
			text: `【最近 AI 叙述】\n${narrative}\n\n【未读资产清单】\n${catalog}`,
			contextLabel: `batch-${hash.slice(0, 8)}(${batch.length}条)`,
			model: this.config.judgeModel || undefined,
		});
		if (!paths || paths.length === 0) return;
		// 白名单校验：尾段容错匹配，仅留清单内路径，其余（幻觉）丢弃（specs §1.4）
		const validEntries = filterVerdictPaths(paths, candidates.map((a) => a.entry));
		if (validEntries.length === 0) return;
		const valid = candidates.filter((a) => validEntries.includes(a.entry));
		for (const a of valid) {
			this.remindedCount.set(a.entry, (this.remindedCount.get(a.entry) ?? 0) + 1);
		}
		if (pi) {
			const lines = valid
				.map((a) =>
					`- ${a.entry}（${a.entry.startsWith("openspec/") ? "规格" : "判例/记忆"}：${a.desc}）`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "memory-routing",
					content: `💡 记忆路由：本段工作与以下知识资产相关（你尚未读过）：\n${lines}\n如相关请 read；无关可忽略。`,
					display: true,
				},
				{ deliverAs: "steer" },
			);
		}
	}
	/** read 成功对账回调（routing-register 的 tool 双事件对账后调用） */
	recordRead(toolName: string, args: unknown, isError: boolean): void {
		this.readTracker.recordRead(toolName, args, isError);
	}
}
