/**
 * 路由状态持久化：readTracker 已读路径 + promptedSet 已推资产。
 *
 * 动机（R33）：两个集合原为进程内存态，死机/reload 后清零 → 首轮把上下文里
 * 已有大意的资产重推一遍（用户体感轰炸）。pi 恢复会话复用同 session id
 * （实证：死机重启 sid 不变），故按 sid 落盘 + 首事件惰性恢复即可。
 *
 * 文件：~/.pi/agent/logs/memory-routing-state/<sid>.json（与判定日志同域）。
 * 清理：绑定时顺扫 mtime 超 7 天的残留（死机场景不会触发 shutdown 钩子）。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(homedir(), ".pi/agent/logs/memory-routing-state");
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface RoutingState {
	readPaths: string[];
	prompted: string[];
	ts: number;
}

export function saveRoutingState(sid: string, state: RoutingState, dir = STATE_DIR): void {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${sid}.json`), JSON.stringify(state), "utf8");
	} catch {
		/* 持久化失败静默（内存态仍可用） */
	}
}

export function loadRoutingState(sid: string, dir = STATE_DIR): RoutingState | null {
	try {
		const raw = readFileSync(join(dir, `${sid}.json`), "utf8");
		const st = JSON.parse(raw) as RoutingState;
		if (!Array.isArray(st.readPaths) || !Array.isArray(st.prompted)) return null;
		return st;
	} catch {
		return null; // 无文件 / 损坏：从空开始
	}
}

/** 顺扫过期残留（绑定时调用，每 session 一次）——按状态内 ts 判期，非文件 mtime（刚写入的文件 mtime 永远新鲜） */
export function purgeStaleStates(dir = STATE_DIR, maxAgeMs = MAX_AGE_MS): number {
	let n = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			const p = join(dir, f);
			try {
				const st = JSON.parse(readFileSync(p, "utf8")) as { ts?: unknown };
				if (typeof st.ts === "number" && Date.now() - st.ts > maxAgeMs) {
					unlinkSync(p);
					n++;
				}
			} catch {
				/* 单文件损坏跳过（ts 缺失/不可解析 → 保守保留） */
			}
		}
	} catch {
		/* 目录不存在 */
	}
	return n;
}
