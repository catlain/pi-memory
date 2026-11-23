/**
 * ReadTracker 单元测试 — 路径归一化 / 尾段匹配 / 剔除逻辑
 */
import { describe, it, expect } from "vitest";
import { ReadTracker, normalizePath, pathEndsWith } from "../lib/read-tracker";

describe("normalizePath", () => {
	it("反斜杠转正斜杠 + 小写", () => {
		expect(normalizePath("C:\\Users\\X\\a.MD")).toBe("c:/users/x/a.md");
	});
	it("去前导斜杠", () => {
		expect(normalizePath("/a/b.md")).toBe("a/b.md");
	});
});

describe("pathEndsWith", () => {
	it("绝对 vs 相对（尾段匹配）", () => {
		expect(pathEndsWith("C:/x/y/memory/foo--a,b.md", "memory/foo--a,b.md")).toBe(true);
	});
	it("完全相等", () => {
		expect(pathEndsWith("memory/x.md", "memory/x.md")).toBe(true);
	});
	it("不同文件不匹配", () => {
		expect(pathEndsWith("memory/x.md", "memory/y.md")).toBe(false);
	});
});

describe("ReadTracker", () => {
	it("read 成功记录路径 + hasRead 尾段命中（specs §1.3 已读剔除）", () => {
		const t = new ReadTracker();
		t.recordRead("read", { path: "C:/Users/u/.pi/agent/memory/git--x.md" }, false);
		expect(t.hasRead("memory/git--x.md")).toBe(true);
	});
	it("非 read 工具不记录", () => {
		const t = new ReadTracker();
		t.recordRead("bash", { path: "x" }, false);
		expect(t.snapshot()).toHaveLength(0);
	});
	it("error 的 read 不记录", () => {
		const t = new ReadTracker();
		t.recordRead("read", { path: "x" }, true);
		expect(t.snapshot()).toHaveLength(0);
	});
	it("file_path 别名也识别", () => {
		const t = new ReadTracker();
		t.recordRead("read", { file_path: "a/b.md" }, false);
		expect(t.hasRead("a/b.md")).toBe(true);
	});
});
