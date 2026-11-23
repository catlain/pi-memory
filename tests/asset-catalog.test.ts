/**
 * asset-catalog 单元测试 — L1/L2 记忆扫描 + spec 清单
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectMemoryAssets, collectSpecAssets } from "../lib/asset-catalog";

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
});
