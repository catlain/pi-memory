/**
 * asset-catalog 单元测试 — L1/L2 记忆扫描 + spec 清单
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectMemoryAssets, collectSpecAssets } from "../lib/asset-catalog";
import { kwOf } from "../lib/keyword-routing";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assetcat-"));

describe("collectMemoryAssets", () => {
	beforeEach(() => {
		fs.rmSync(path.join(tmpRoot, "memory"), { recursive: true, force: true });
		fs.rmSync(path.join(tmpRoot, ".pi", "memory"), { recursive: true, force: true });
	});
	afterEach(() => {
		fs.rmSync(path.join(tmpRoot, "memory"), { recursive: true, force: true });
		fs.rmSync(path.join(tmpRoot, ".pi", "memory"), { recursive: true, force: true });
	});
	it("跳过 MEMORY.md 与非 md 文件", () => {
		fs.mkdirSync(path.join(tmpRoot, "memory"), { recursive: true });
		fs.writeFileSync(path.join(tmpRoot, "memory", "MEMORY.md"), "# idx");
		fs.writeFileSync(path.join(tmpRoot, "memory", "foo--a,b.md"), "# foo");
		fs.writeFileSync(path.join(tmpRoot, "memory", "note.txt"), "x");
		// L1 目录指向 tmp（覆盖 AGENT_DIR 语义：这里仅验证扫描行为，实际 L1 在 AGENT_DIR）
		// collectMemoryAssets 的 L1 源是 AGENT_DIR/memory（真实存在），断言只看 L2 相对部分
		const assets = collectMemoryAssets(tmpRoot);
		const entries = assets.map((a) => a.entry);
		expect(entries).not.toContain("memory/MEMORY.md");
		expect(entries).not.toContain("memory/note.txt");
	});
	it("L2 目录不存在时静默跳过", () => {
		expect(() => collectMemoryAssets(tmpRoot)).not.toThrow();
	});
});

describe("collectSpecAssets", () => {
	afterEach(() => {
		fs.rmSync(path.join(tmpRoot, "openspec"), { recursive: true, force: true });
	});
	it("读取 capability 名与 Purpose 首句", () => {
		fs.mkdirSync(path.join(tmpRoot, "openspec", "specs", "cap-a"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot, "openspec", "specs", "cap-a", "spec.md"),
			"# cap-a\n\n## Purpose\n做某事。更多说明。\n\n## Requirements\n",
		);
		const specs = collectSpecAssets(tmpRoot);
		const a = specs.find((s) => s.entry.includes("cap-a"));
		expect(a).toBeDefined();
		expect(a!.desc).toContain("做某事");
		expect(a!.desc).not.toContain("更多说明"); // 只取首句
	});
	it("openspec 目录不存在返回空数组", () => {
		expect(collectSpecAssets(tmpRoot)).toEqual([]);
	});
	it("frontmatter inline keywords 解析入 kws（小写化）", () => {
		fs.mkdirSync(path.join(tmpRoot, "openspec", "specs", "cap-kw"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot, "openspec", "specs", "cap-kw", "spec.md"),
			"---\nkeywords: [LLM-Judge, 串位, 漂移]\n---\n\n# Spec: x\n\n## Purpose\n做某事。\n",
		);
		const specs = collectSpecAssets(tmpRoot);
		const a = specs.find((s) => s.entry.includes("cap-kw"));
		expect(a?.kws).toEqual(["llm-judge", "串位", "漂移"]);
	});
	it("frontmatter block 列表式 keywords 解析", () => {
		fs.mkdirSync(path.join(tmpRoot, "openspec", "specs", "cap-bl"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot, "openspec", "specs", "cap-bl", "spec.md"),
			"---\nkeywords:\n  - Foo\n  - bar\n---\n\n# Spec: x\n\n## Purpose\n做某事。\n",
		);
		const specs = collectSpecAssets(tmpRoot);
		const a = specs.find((s) => s.entry.includes("cap-bl"));
		expect(a?.kws).toEqual(["foo", "bar"]);
	});
	it("无 frontmatter / 空字段 → kws 缺省（走 capability 回退）", () => {
		fs.mkdirSync(path.join(tmpRoot, "openspec", "specs", "cap-no"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot, "openspec", "specs", "cap-no", "spec.md"),
			"# Spec: 无 frontmatter\n\n## Purpose\n做某事。\n",
		);
		fs.mkdirSync(path.join(tmpRoot, "openspec", "specs", "cap-emp"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpRoot, "openspec", "specs", "cap-emp", "spec.md"),
			"---\ntitle: 别的字段\n---\n\n## Purpose\n做某事。\n",
		);
		const specs = collectSpecAssets(tmpRoot);
		expect(specs.find((s) => s.entry.includes("cap-no"))?.kws).toBeUndefined();
		expect(specs.find((s) => s.entry.includes("cap-emp"))?.kws).toBeUndefined();
	});
});

describe("kwOf spec frontmatter 优先级", () => {
	it("kws 存在时优先于 capability 回退", () => {
		expect(kwOf({ entry: "openspec/specs/cap-a/spec.md", desc: "", kws: ["foo", "bar"] })).toEqual([
			"foo",
			"bar",
		]);
	});
	it("kws 缺省回退 capability 小写化", () => {
		expect(kwOf({ entry: "openspec/specs/Cap-B/spec.md", desc: "" })).toEqual(["cap-b"]);
	});
});
