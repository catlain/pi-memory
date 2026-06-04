/**
 * index.ts — memory_update L1 scope 测试
 *
 * 通过 vi.mock("types") 重定向 AGENT_DIR 到临时目录，
 * 覆盖 L1 scope 的 targetDir / indexPath 分支。
 */

import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// ── 用 vi.hoisted 创建临时 AGENT_DIR ──────────────────────

const { TEST_AGENT_DIR } = vi.hoisted(() => {
	const mod_fs = require("node:fs");
	const mod_path = require("node:path");
	const mod_os = require("node:os");
	const base = mod_fs.mkdtempSync(mod_path.join(mod_os.tmpdir(), "mem-l1-up-"));
	mod_fs.mkdirSync(mod_path.join(base, "memory"), { recursive: true });
	return { TEST_AGENT_DIR: base };
});

// ── Mock types.ts ─────────────────────────────────────────

vi.mock("../lib/types", () => ({
	AGENT_DIR: TEST_AGENT_DIR,
	MAX_FILE_LINES: 200,
	MAX_MERGED_LINES: 400,
	HARD_FILE_LIMIT: 40,
	SOFT_FILE_LIMIT: 25,
	HINT_FILE_LIMIT: 20,
}));

// ── 导入 ──────────────────────────────────────────────────

import * as fs from "node:fs";

let memoryUpdateExecute: Function | null = null;

async function getMemoryUpdate(): Promise<Function> {
	if (memoryUpdateExecute) return memoryUpdateExecute;
	const registerTool = vi.fn();
	const on = vi.fn();
	const mod = await import("../index");
	mod.default({ registerTool, on } as any);
	memoryUpdateExecute = registerTool.mock.calls.find(
		(c: any[]) => c[0].name === "memory_update",
	)[0].execute;
	return memoryUpdateExecute;
}

afterAll(() => {
	try {
		const mod_fs = require("node:fs");
		mod_fs.rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("memory_update L1 scope", () => {
	it("L1 scope 写入 AGENT_DIR/memory", async () => {
		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "l1-test--a.md", content: "# L1 Test\n内容", scope: "L1" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		expect(result.content[0].text).toContain("✅");

		const l1File = path.join(TEST_AGENT_DIR, "memory", "l1-test--a.md");
		expect(fs.existsSync(l1File)).toBe(true);
		expect(fs.readFileSync(l1File, "utf-8")).toContain("L1 Test");

		const l1Index = path.join(TEST_AGENT_DIR, "MEMORY.md");
		expect(fs.existsSync(l1Index)).toBe(true);
	});

	it("L1 scope 覆盖已有文件", async () => {
		// 先创建一个
		const execute = await getMemoryUpdate();
		await execute(
			"id",
			{ fileName: "exist--b.md", content: "# Old\n旧", scope: "L1" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		// 覆盖
		const result = await execute(
			"id",
			{ fileName: "exist--b.md", content: "# Updated\n新", scope: "L1" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		expect(result.content[0].text).toContain("覆盖");
		const content = fs.readFileSync(
			path.join(TEST_AGENT_DIR, "memory", "exist--b.md"),
			"utf-8",
		);
		expect(content).toContain("Updated");
	});
});
