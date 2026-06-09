/**
 * memory-parser.ts 测试 — 文件名解析与目录扫描
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	buildFileName,
	parseFileName,
	scanMemoryDir,
} from "../lib/memory-parser";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memory-parser-test-"));

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

// ── parseFileName ──────────────────────────────────────────

describe("parseFileName", () => {
	it("解析标准格式 topic--kw1,kw2.md", () => {
		const result = parseFileName("coding--git,lint,格式.md");
		expect(result.topic).toBe("coding");
		expect(result.keywords).toEqual(["git", "lint", "格式"]);
	});

	it("解析无关键词的文件名 topic--.md", () => {
		const result = parseFileName("mytopic--.md");
		expect(result.topic).toBe("mytopic");
		expect(result.keywords).toEqual([]);
	});

	it("无 -- 时 topic = basename", () => {
		const result = parseFileName("oldformat.md");
		expect(result.topic).toBe("oldformat");
		expect(result.keywords).toEqual([]);
	});

	it("null 输入返回空", () => {
		const result = parseFileName(null as any);
		expect(result.topic).toBe("");
		expect(result.keywords).toEqual([]);
	});

	it("5 个关键词（上限）", () => {
		const result = parseFileName("test--a,b,c,d,e.md");
		expect(result.topic).toBe("test");
		expect(result.keywords).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("中文 topic 和关键词", () => {
		const result = parseFileName("编码规范--git,格式,安全.md");
		expect(result.topic).toBe("编码规范");
		expect(result.keywords).toEqual(["git", "格式", "安全"]);
	});
});

// ── buildFileName ──────────────────────────────────────────

describe("buildFileName", () => {
	it("生成标准格式", () => {
		expect(buildFileName("coding", ["git", "lint"])).toBe(
			"coding--git,lint.md",
		);
	});

	it("无关键词时不带 --", () => {
		expect(buildFileName("mytopic", [])).toBe("mytopic.md");
	});

	it("parseFileName ↔ buildFileName 往返", () => {
		const original = "test--a,b,c.md";
		const parsed = parseFileName(original);
		const rebuilt = buildFileName(parsed.topic, parsed.keywords);
		expect(rebuilt).toBe(original);
	});
});

// ── scanMemoryDir ──────────────────────────────────────────

describe("scanMemoryDir", () => {
	it("空目录返回空数组", () => {
		const result = scanMemoryDir(TMP_DIR, "L2");
		expect(result).toEqual([]);
	});

	it("跳过 MEMORY.md", () => {
		fs.writeFileSync(path.join(TMP_DIR, "MEMORY.md"), "# Index\n", "utf-8");
		const result = scanMemoryDir(TMP_DIR, "L2");
		expect(result).toEqual([]);
	});

	it("扫描 .md 文件并解析", () => {
		fs.writeFileSync(
			path.join(TMP_DIR, "coding--git,lint.md"),
			"# 编码规范\n\n关键词：`git` `lint`\n\n## 规则1\n\n不要用 any",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(TMP_DIR, "debug--uvicorn,缓存.md"),
			"# 调试反模式\n\n关键词：`uvicorn` `缓存`",
			"utf-8",
		);

		const result = scanMemoryDir(TMP_DIR, "L2");
		expect(result).toHaveLength(2);
		expect(result[0].topic).toBe("coding");
		expect(result[0].keywords).toEqual(["git", "lint"]);
		expect(result[0].description).toBe("编码规范");
		expect(result[0].scope).toBe("L2");
		expect(result[1].topic).toBe("debug");
	});

	it("不存在的目录返回空数组", () => {
		const result = scanMemoryDir("/nonexistent/path", "L1");
		expect(result).toEqual([]);
	});

	it("L1 scope 正确传递", () => {
		fs.writeFileSync(
			path.join(TMP_DIR, "global--test.md"),
			"# Test\n",
			"utf-8",
		);
		const result = scanMemoryDir(TMP_DIR, "L1");
		expect(result[0].scope).toBe("L1");
	});

	it("无标题行时 description 为空字符串", () => {
		fs.writeFileSync(
			path.join(TMP_DIR, "notitle--x.md"),
			"没有标题行",
			"utf-8",
		);
		const result = scanMemoryDir(TMP_DIR, "L2");
		expect(result[0].description).toBe("");
	});

	it("readFileSync 抛出异常时用 (读取失败) 降级", () => {
		// 创建一个目录名为 foo.md 的目录
		// readdirSync 会返回它（endsWith .md），但 readFileSync 会抛出 EISDIR
		fs.mkdirSync(path.join(TMP_DIR, "broken--x.md"), { recursive: true });

		const result = scanMemoryDir(TMP_DIR, "L2");
		expect(result).toHaveLength(1);
		expect(result[0].description).toBe("(读取失败)");
		expect(result[0].lines).toBe(0);
	});
});
