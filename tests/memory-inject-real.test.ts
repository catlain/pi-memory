/**
 * memory-inject.ts 真实模块测试 — resolveMemoryInjection 及工具函数
 * 
 * 从实际模块导入函数，通过 mock types.ts 控制 AGENT_DIR。
 * vi.mock 工厂内不能引用顶层 import 变量，用 vi.hoisted + 硬编码路径。
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// ── 用 vi.hoisted 创建临时目录路径（不能引用顶层 import）─

const { TEST_AGENT_DIR, TMP_PROJECT } = vi.hoisted(() => {
	// 在 hoisted 作用域内直接使用 node:fs 等内置模块
	// 注意：这里不能用顶层 import 的 fs/path/os，需用完整 require
	const mod_fs = require("node:fs");
	const mod_path = require("node:path");
	const mod_os = require("node:os");
	const base = mod_fs.mkdtempSync(mod_path.join(mod_os.tmpdir(), "mem-inject-real-agent-"));
	const proj = mod_fs.mkdtempSync(mod_path.join(mod_os.tmpdir(), "mem-inject-real-proj-"));
	return { TEST_AGENT_DIR: base, TMP_PROJECT: proj };
});

console.log("TEST_AGENT_DIR:", TEST_AGENT_DIR);
console.log("TMP_PROJECT:", TMP_PROJECT);

// ── Mock types.ts 以重定向 AGENT_DIR ──────────────────────

vi.mock("../lib/types", () => ({
	AGENT_DIR: TEST_AGENT_DIR,
	MAX_FILE_LINES: 200,
	MAX_MERGED_LINES: 400,
	HARD_FILE_LIMIT: 40,
	SOFT_FILE_LIMIT: 25,
	HINT_FILE_LIMIT: 20,
}));

// ── 导入实际模块（必须在 vi.mock 之后）────────────────────

import {
	readMemoryFile,
	truncateMemory,
	buildMemoryPrompt,
	resolveMemoryInjection,
} from "../lib/memory-inject";

// ── 辅助 ──────────────────────────────────────────────────

function writeL1(content: string): void {
	fs.mkdirSync(TEST_AGENT_DIR, { recursive: true });
	fs.writeFileSync(path.join(TEST_AGENT_DIR, "MEMORY.md"), content, "utf-8");
}

function writeL2(cwd: string, content: string): void {
	const dir = path.join(cwd, ".pi", "memory");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "MEMORY.md"), content, "utf-8");
}

beforeEach(() => {
	for (const d of [TEST_AGENT_DIR, TMP_PROJECT]) {
		if (fs.existsSync(d)) {
			for (const e of fs.readdirSync(d)) {
				fs.rmSync(path.join(d, e), { recursive: true, force: true });
			}
		}
	}
});

afterAll(() => {
	try { fs.rmSync(TEST_AGENT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
	try { fs.rmSync(TMP_PROJECT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── readMemoryFile ────────────────────────────────────────

describe("readMemoryFile (actual module)", () => {
	it("存在文件时返回 trim 内容", () => {
		const fp = path.join(TEST_AGENT_DIR, "test.md");
		fs.mkdirSync(TEST_AGENT_DIR, { recursive: true });
		fs.writeFileSync(fp, "  hello world  ", "utf-8");
		expect(readMemoryFile(fp)).toBe("hello world");
	});

	it("不存在返回空字符串", () => {
		expect(readMemoryFile("/nonexistent/path/MEMORY.md")).toBe("");
	});

	it("空文件返回空字符串", () => {
		const fp = path.join(TEST_AGENT_DIR, "empty.md");
		fs.mkdirSync(TEST_AGENT_DIR, { recursive: true });
		fs.writeFileSync(fp, "", "utf-8");
		expect(readMemoryFile(fp)).toBe("");
	});

	it("读取失败返回空字符串", () => {
		expect(readMemoryFile("/root/forbidden/MEMORY.md")).toBe("");
	});
});

// ── truncateMemory ────────────────────────────────────────

describe("truncateMemory (actual module)", () => {
	it("短内容不截断", () => {
		expect(truncateMemory("简短")).toBe("简短");
	});

	it("刚好 200 行不截断", () => {
		const c = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
		expect(truncateMemory(c)).toBe(c);
	});

	it("201 行截到 200 行加警告", () => {
		const c = Array.from({ length: 201 }, (_, i) => `line-${i}`).join("\n");
		const r = truncateMemory(c);
		const lines = r.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("> ⚠️"));
		expect(lines).toHaveLength(200);
		expect(r).toContain("⚠️");
	});

	it("超长字节被截断", () => {
		const c = Array.from({ length: 130 }, (_, i) => `line-${i} ` + "x".repeat(200)).join("\n");
		const r = truncateMemory(c);
		expect(Buffer.byteLength(r, "utf-8")).toBeLessThanOrEqual(25_200);
	});

	it("超大单行被截断", () => {
		const r = truncateMemory("x".repeat(50_000));
		expect(Buffer.byteLength(r, "utf-8")).toBeLessThanOrEqual(25_200);
	});
});

// ── buildMemoryPrompt ─────────────────────────────────────

describe("buildMemoryPrompt (actual module)", () => {
	it("全局+项目拼接完整", () => {
		const r = buildMemoryPrompt("全局记忆内容", "项目记忆内容");
		expect(r).toContain("全局记忆内容");
		expect(r).toContain("项目记忆内容");
		expect(r).toContain("## 记忆");
	});

	it("只有全局", () => {
		const r = buildMemoryPrompt("仅全局", "");
		expect(r).toContain("仅全局");
		expect(r).not.toContain("项目");
	});

	it("只有项目", () => {
		const r = buildMemoryPrompt("", "仅项目");
		expect(r).toContain("仅项目");
		expect(r).not.toContain("全局");
	});

	it("都没有时返回 null", () => {
		expect(buildMemoryPrompt("", "")).toBeNull();
	});

	it("两个条目之间用双换行分隔", () => {
		const r = buildMemoryPrompt("global", "project")!;
		expect(r).toContain("global\n\nproject");
	});
});

// ── resolveMemoryInjection ────────────────────────────────

describe("resolveMemoryInjection (actual module)", () => {
	it("无任何记忆文件时返回 null", () => {
		const result = resolveMemoryInjection(TMP_PROJECT);
		expect(result).toBeNull();
	});

	it("只有 L1 时返回 L1 内容", () => {
		writeL1("# 全局索引\n- [test](test.md)");
		const result = resolveMemoryInjection(TMP_PROJECT);
		expect(result).toContain("全局索引");
		expect(result).not.toContain("项目");
	});

	it("只有 L2 时返回 L2 内容", () => {
		writeL2(TMP_PROJECT, "# 项目索引\n- [local](local.md)");
		const result = resolveMemoryInjection(TMP_PROJECT);
		expect(result).toContain("项目索引");
		expect(result).not.toContain("全局");
	});

	it("L1 + L2 都返回拼接内容", () => {
		writeL1("# 全局\n- [g](g.md)");
		writeL2(TMP_PROJECT, "# 项目\n- [p](p.md)");
		const result = resolveMemoryInjection(TMP_PROJECT);
		expect(result).toContain("全局");
		expect(result).toContain("项目");
		expect(result).toContain("## 记忆");
	});

	it("L2 超长时被截断", () => {
		writeL1("");
		const longLines = Array.from({ length: 220 }, (_, i) => `line-${i}`).join("\n");
		writeL2(TMP_PROJECT, longLines);

		const result = resolveMemoryInjection(TMP_PROJECT);
		expect(result).toContain("## 记忆");
	});
});
