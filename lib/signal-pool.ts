/**
 * 信号池：三信号源（叙述 / 工具调用 / 工具报错）→ 行级缓冲 → 按字符阈值取批。
 * 纯状态机，不触 LLM；判定层（routing.ts）只消费 takeBatch()。
 */
import { contentBlocksOf, roleOf } from "./msg-shapes";

/** 单信号行截断 */
const LINE_CAP = 2000;
/** 池硬上限：超过则只留最近 10 行（防长回合无判定点时无限增长） */
const HARD_CAP = 6000;

/** 工具调用摘要：名称 + 关键参数（命令 / 路径 / 模式名等），截 300 字 */
export function summarizeToolCall(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const key = ["command", "path", "pattern", "query", "symbol_name", "file_path", "name", "action"].find((k) => typeof a[k] === "string" && (a[k] as string).length > 0);
	const detail = key ? `${key}=${String(a[key]).slice(0, 300)}` : JSON.stringify(a).slice(0, 200);
	return `${name}: ${detail}`;
}

/** 报错摘要：截 200 字头部（特征码区） */
export function summarizeError(result: unknown): string {
	const s = typeof result === "string" ? result : JSON.stringify(result);
	return String(s).slice(0, 200);
}

export interface SignalBatch {
	lines: string[];
	chars: number;
}

export class SignalPool {
	private buffer: string[] = [];
	private charCount = 0;

	/** 池内信号行数 */
	get size(): number {
		return this.buffer.length;
	}

	/** 池内累计字符数（取批门槛的度量） */
	get chars(): number {
		return this.charCount;
	}

	/** message_end：叙述（text 块）+ 工具摘要（toolCall 块）入池。只收 assistant——toolResult 的 text 块是工具结果正文，入池即秒满门槛 */
	accumulate(event: unknown): void {
		try {
			if (roleOf(event) !== "assistant") return;
			const blocks = contentBlocksOf(event) as Array<Record<string, unknown>>;
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
	observeToolResult(toolName: string, _args: unknown, isError: boolean, result: unknown): void {
		if (!isError) return;
		this.push([`[tool✗] ${toolName} → ${summarizeError(result)}`]);
	}

	/** 达阈值则取出并清空；不足返回 null */
	takeBatch(threshold: number): SignalBatch | null {
		if (this.charCount < threshold) return null;
		const lines = this.buffer.splice(0);
		const chars = this.charCount;
		this.charCount = 0;
		return { lines, chars };
	}

	clear(): void {
		this.buffer = [];
		this.charCount = 0;
	}

	private push(lines: string[]): void {
		for (const l of lines) {
			this.buffer.push(l);
			this.charCount += l.length;
		}
		if (this.charCount > HARD_CAP) this.buffer = this.buffer.slice(-10);
	}
}
