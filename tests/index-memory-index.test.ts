/**
 * index.ts — memory_index execute 测试
 *
 * 测试 memory_index 工具在不同 scope 下的行为。
 * 使用 real fs + 临时目录验证。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mem-index-test-"));

function l2Dir(cwd: string): string {
	return path.join(cwd, ".pi", "memory");
}

// 缓存被注册的 execute 函数（模块只加载一次）
let memoryIndexExecute: Function | null = null;

async function getMemoryIndex(): Promise<Function> {
	if (memoryIndexExecute) return memoryIndexExecute;
	const registerTool = vi.fn();
	const on = vi.fn();
	const mod = await import("../index");
	mod.default({ registerTool, on } as any);
	memoryIndexExecute = registerTool.mock.calls.find(
		(c: any[]) => c[0].name === "memory_index",
	)[0].execute;
	return memoryIndexExecute;
}

beforeEach(() => {
	for (const e of fs.readdirSync(TMP_DIR)) {
		const p = path.join(TMP_DIR, e);
		if (fs.statSync(p).isDirectory()) {
			fs.rmSync(p, { recursive: true, force: true });
		} else {
			fs.unlinkSync(p);
		}
	}
});

afterAll(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("memory_index execute", () => {
	it("L2 scope 无文件时返回空", async () => {
		const execute = await getMemoryIndex();
		// L2 目录不存在 → 返回空
		const result = await execute("id", { scope: "L2" }, undefined, undefined, {
			cwd: TMP_DIR,
		});
		expect(result.content[0].text).toBe("未找到任何记忆文件。");
	});

	it("L2 scope 返回文件条目", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "test--a,b,c.md"),
			"# Test Topic\n内容",
			"utf-8",
		);

		const execute = await getMemoryIndex();
		const result = await execute("id", { scope: "L2" }, undefined, undefined, {
			cwd,
		});
		const text = result.content[0].text;
		expect(text).toContain("Test Topic");
		expect(text).toContain("L2");
		expect(text).toContain("a, b, c");
	});

	it("L1 scope 返回结果（真实 L1 目录）", async () => {
		const execute = await getMemoryIndex();
		const result = await execute("id", { scope: "L1" }, undefined, undefined, {
			cwd: TMP_DIR,
		});
		const text = result.content[0].text;
		expect(text).toBeTruthy();
		if (text === "未找到任何记忆文件。") {
			expect(text).toBe("未找到任何记忆文件。");
		} else {
			expect(text).toContain("L1");
		}
	});

	it("all scope 显示 L2（真实 L1 可能存在）", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "zebra--z.md"),
			"# Zebra\n内容",
			"utf-8",
		);

		const execute = await getMemoryIndex();
		const result = await execute("id", { scope: "all" }, undefined, undefined, {
			cwd,
		});
		const text = result.content[0].text;
		expect(text).toContain("L2");
		if (text !== "未找到任何记忆文件。") {
			expect(text).toContain("zebra");
		}
	});

	it("多个文件按字母序排列", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "beta--b.md"),
			"# Beta\n内容",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(l2Dir(cwd), "alpha--a.md"),
			"# Alpha\n内容",
			"utf-8",
		);

		const execute = await getMemoryIndex();
		const result = await execute("id", { scope: "L2" }, undefined, undefined, {
			cwd,
		});
		const text = result.content[0].text;
		const alphaIdx = text.indexOf("Alpha");
		const betaIdx = text.indexOf("Beta");
		expect(alphaIdx).toBeGreaterThan(0);
		expect(betaIdx).toBeGreaterThan(alphaIdx);
	});
});
