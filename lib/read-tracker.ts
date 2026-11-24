/**
 * Read Tracker — 会话内 read 路径跟踪 + 白名单校验
 *
 * 数据源：tool_result 钩子（toolName === "read" 且非 error）
 * 用途：
 *   1. 判定时剔除已读条目（防重复提醒）
 *   2. 判定输出的路径白名单校验（幻觉路径丢弃）
 *
 * 路径归一化：全部转小写、正斜杠，便于跨形态匹配（C:\a\b.md vs c:/a/b.md）。
 */

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/** 归一化后按尾段匹配（清单条目可能是相对路径，判定输出可能是绝对路径或反之） */
export function pathEndsWith(candidate: string, entry: string): boolean {
	const c = normalizePath(candidate);
	const e = normalizePath(entry);
	return c === e || c.endsWith("/" + e) || e.endsWith("/" + c);
}

export class ReadTracker {
	private readPaths = new Set<string>();
	private readonly sessionStart: number;

	constructor() {
		this.sessionStart = Date.now();
	}

	/** 记录一次成功 read（tool_result：toolName === "read" 且非 error） */
	recordRead(toolName: string, args: unknown, isError: boolean): void {
		if (toolName !== "read" || isError) return;
		const p =
			(args as { path?: unknown; file_path?: unknown } | null)?.path ??
			(args as { file_path?: unknown } | null)?.file_path;
		if (typeof p === "string" && p.length > 0) {
			this.readPaths.add(normalizePath(p));
		}
	}

	/** 条目是否已被 read（尾段匹配，容忍绝对/相对差异） */
	hasRead(entry: string): boolean {
		for (const p of this.readPaths) {
			if (pathEndsWith(p, entry)) return true;
		}
		return false;
	}

	/** 快照（诊断用） */
	snapshot(): readonly string[] {
		return [...this.readPaths];
	}

	get startedAt(): number {
		return this.sessionStart;
	}
}

/** 判定输出行 → 白名单内条目映射；白名单外（幻觉）丢弃；上限 max 条 */
export function filterVerdictPaths(
	lines: string[],
	whitelist: string[],
	max = 3,
): string[] {
	const out: string[] = [];
	for (const raw of lines) {
		const line = raw.trim().replace(/^[-*\d.\s"']+|["']+$/g, "");
		if (!line || line.length > 260) continue;
		const hit = whitelist.find((w) => pathEndsWith(line, w));
		if (hit && !out.some((o) => pathEndsWith(o, hit))) {
			out.push(hit);
			if (out.length >= max) break;
		}
	}
	return out;
}

/** 工厂（v3 routing 接口形态）：等价 new ReadTracker() */
export function createReadTracker(): ReadTracker {
	return new ReadTracker();
}
