/** routing-state：R33 重启清零修复——session 级状态持久化/恢复/过期清理 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingState, purgeStaleStates, saveRoutingState } from "../lib/routing-state";
import { MemoryRouter } from "../lib/routing";
import { DEFAULTS } from "../lib/routing-config";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "routing-state-test-"));
}

describe("routing-state 持久化", () => {
	it("save/load 往返：状态原样恢复", () => {
		const dir = tmpDir();
		try {
			saveRoutingState("sid-a", { readPaths: ["/a.md", "/b.md"], prompted: ["mem--x"], ts: 1 }, dir);
			const st = loadRoutingState("sid-a", dir);
			expect(st?.readPaths).toEqual(["/a.md", "/b.md"]);
			expect(st?.prompted).toEqual(["mem--x"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("load 不存在的 sid → null；损坏 JSON → null", () => {
		const dir = tmpDir();
		try {
			expect(loadRoutingState("sid-none", dir)).toBeNull();
			writeFileSync(join(dir, "sid-bad.json"), "{broken");
			expect(loadRoutingState("sid-bad", dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("purgeStaleStates 清理超期文件，保留新鲜文件", () => {
		const dir = tmpDir();
		try {
			const old = 9 * 24 * 3600 * 1000; // 9 天前（超过 7 天默认限）
			saveRoutingState("sid-old", { readPaths: [], prompted: [], ts: Date.now() - old }, dir);
			saveRoutingState("sid-new", { readPaths: [], prompted: [], ts: Date.now() }, dir);
			purgeStaleStates(dir, 7 * 24 * 3600 * 1000);
			expect(loadRoutingState("sid-old", dir)).toBeNull();
			expect(loadRoutingState("sid-new", dir)).not.toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("MemoryRouter bindSession/persistState（R33）", () => {
	it("未绑 sid 时 persistState no-op（不抛不写）", () => {
		const r = new MemoryRouter(process.cwd(), { ...DEFAULTS });
		expect(() => r.persistState()).not.toThrow();
	});

	it("恢复语义：load 失败（默认目录无此 sid）→ 集合为空", () => {
		const r = new MemoryRouter(process.cwd(), { ...DEFAULTS });
		r.bindSession("sid-nonexistent-xyz");
		expect(r.readTracker.snapshot()).toEqual([]);
		expect(r.prompted.snapshot()).toEqual([]);
	});

	it("幂等：同 sid 重复 bind 不重复恢复", () => {
		const r = new MemoryRouter(process.cwd(), { ...DEFAULTS });
		r.bindSession("sid-idem");
		r.bindSession("sid-idem");
		expect(r.prompted.size).toBe(0);
	});

	it("正路径：bindSession(stateDir) 恢复已读/已推（R33 主场景）", () => {
		const dir = tmpDir();
		try {
			saveRoutingState("sid-restore", { readPaths: ["/mem/x.md"], prompted: ["a--k1,k2"], ts: 1 }, dir);
			const r = new MemoryRouter(process.cwd(), { ...DEFAULTS });
			r.bindSession("sid-restore", dir);
			expect(r.readTracker.hasRead("/mem/x.md")).toBe(true);
			expect(r.prompted.has("a--k1,k2")).toBe(true);
			// 状态变更后 persistState 写回同目录
			r.readTracker.recordRead("read", { path: "/mem/y.md" }, false);
			r.persistState();
			const st = loadRoutingState("sid-restore", dir);
			expect(st?.readPaths).toContain("mem/y.md");
			expect(st?.prompted).toContain("a--k1,k2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
