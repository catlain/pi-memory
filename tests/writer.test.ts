/**
 * writer.ts 测试 — 索引重建与行数检查
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { rebuildIndex, checkLineCount } from "../lib/writer";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memory-writer-test-"));
const INDEX_PATH = path.join(TMP_DIR, "MEMORY.md");

beforeEach(() => {
	for (const e of fs.readdirSync(TMP_DIR)) {
		fs.rmSync(path.join(TMP_DIR, e), { recursive: true, force: true });
	}
});

afterAll(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("rebuildIndex", () => {
	it("空目录不写索引文件", () => {
		rebuildIndex(TMP_DIR, INDEX_PATH, "L2");
		expect(fs.existsSync(INDEX_PATH)).toBe(false);
	});

	it("空目录 + 已有索引文件 → 清空", () => {
		fs.writeFileSync(INDEX_PATH, "old content", "utf-8");
		rebuildIndex(TMP_DIR, INDEX_PATH, "L2");
		expect(fs.readFileSync(INDEX_PATH, "utf-8")).toBe("");
	});

	it("生成正确格式的索引", () => {
		fs.writeFileSync(
			path.join(TMP_DIR, "coding--git,lint.md"),
			"# 编码规范\n\n内容",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(TMP_DIR, "debug--uvicorn.md"),
			"# 调试反模式\n\n内容",
			"utf-8",
		);

		rebuildIndex(TMP_DIR, INDEX_PATH, "L2");
		const content = fs.readFileSync(INDEX_PATH, "utf-8");

		expect(content).toContain("# Memory Index");
		expect(content).toContain("## 文件清单 (2)");
		expect(content).toContain("| coding | git, lint |");
		expect(content).toContain("| debug | uvicorn |");
		expect(content).toContain("[coding](coding--git,lint.md)");
		expect(content).toContain("[debug](debug--uvicorn.md)");
	});

	it("跳过 MEMORY.md 文件", () => {
		fs.writeFileSync(
			path.join(TMP_DIR, "MEMORY.md"),
			"# Index\n",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(TMP_DIR, "real--data.md"),
			"# Real\n\n内容",
			"utf-8",
		);

		rebuildIndex(TMP_DIR, INDEX_PATH, "L2");
		const content = fs.readFileSync(INDEX_PATH, "utf-8");

		expect(content).toContain("## 文件清单 (1)");
		expect(content).toContain("| real | data |");
	});

	it("自动创建父目录", () => {
		const nestedPath = path.join(TMP_DIR, "sub", "dir", "MEMORY.md");
		fs.writeFileSync(path.join(TMP_DIR, "test--a.md"), "# Test\n", "utf-8");
		rebuildIndex(TMP_DIR, nestedPath, "L1");
		expect(fs.existsSync(nestedPath)).toBe(true);
	});
});

describe("checkLineCount", () => {
	it("文件不存在返回 null", () => {
		expect(checkLineCount("/nonexistent/file.md")).toBeNull();
	});

	it("正常行数返回 null", () => {
		const fp = path.join(TMP_DIR, "normal.md");
		fs.writeFileSync(fp, "line1\nline2\nline3\n", "utf-8");
		expect(checkLineCount(fp)).toBeNull();
	});

	it("超限行数返回警告", () => {
		const fp = path.join(TMP_DIR, "big.md");
		// MAX_FILE_LINES 在 types.ts 中定义为 200
		const lines = Array(201).fill("line content").join("\n");
		fs.writeFileSync(fp, lines, "utf-8");
		const warning = checkLineCount(fp);
		expect(warning).toContain("超过 200 行");
		expect(warning).toContain("201 行");
	});
});
