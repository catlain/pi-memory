/**
 * conflict-detect.ts 测试 — 同目录中 topic 或关键词重叠检查
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectConflicts } from "../lib/conflict-detect";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-detect-test-"));

beforeEach(() => {
	for (const e of fs.readdirSync(TMP_DIR)) {
		fs.rmSync(path.join(TMP_DIR, e), { recursive: true, force: true });
	}
});

afterAll(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("detectConflicts", () => {
	it("空目录无冲突", () => {
		const result = detectConflicts(TMP_DIR, "new--a,b.md", { topic: "new", keywords: ["a", "b"] });
		expect(result).toEqual([]);
	});

	it("同 topic 检测为冲突", () => {
		fs.writeFileSync(path.join(TMP_DIR, "coding--git,lint.md"), "# Coding\nline1\nline2\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "coding--new.md", { topic: "coding", keywords: ["new"] });
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("coding--git,lint.md");
		expect(result[0].reason).toContain("同topic");
		expect(result[0].reason).toContain("4行");
	});

	it("关键词重叠 ≥ 3 检测为冲突", () => {
		fs.writeFileSync(path.join(TMP_DIR, "existing--a,b,c,d.md"), "# Existing\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "new--a,b,c.md", { topic: "new", keywords: ["a", "b", "c"] });
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("existing--a,b,c,d.md");
		expect(result[0].reason).toContain("3关键词重叠");
	});

	it("关键词重叠 < 3 不检测为冲突", () => {
		fs.writeFileSync(path.join(TMP_DIR, "existing--a,b,c.md"), "# Existing\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "new--a,b.md", { topic: "new", keywords: ["a", "b"] });
		expect(result).toEqual([]);
	});

	it("跳过 MEMORY.md", () => {
		fs.writeFileSync(path.join(TMP_DIR, "MEMORY.md"), "# Index\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "new--a.md", { topic: "new", keywords: ["a"] });
		expect(result).toEqual([]);
	});

	it("跳过自身文件名", () => {
		fs.writeFileSync(path.join(TMP_DIR, "me--a,b,c.md"), "# Me\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "me--a,b,c.md", { topic: "me", keywords: ["a", "b", "c"] });
		expect(result).toEqual([]);
	});

	it("跳过非 .md 文件", () => {
		fs.writeFileSync(path.join(TMP_DIR, "data.json"), "{}", "utf-8");
		const result = detectConflicts(TMP_DIR, "new--a.md", { topic: "new", keywords: ["a"] });
		expect(result).toEqual([]);
	});

	it("多个冲突同时检测", () => {
		fs.writeFileSync(path.join(TMP_DIR, "coding--git,lint.md"), "# A\nl1\nl2\n", "utf-8");
		fs.writeFileSync(path.join(TMP_DIR, "other--a,b,c.md"), "# B\nl1\n", "utf-8");
		const result = detectConflicts(TMP_DIR, "coding--a,b,c.md", { topic: "coding", keywords: ["a", "b", "c"] });
		expect(result).toHaveLength(2);
	});
});
