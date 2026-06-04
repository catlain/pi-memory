/**
 * index.ts — memory_update execute 测试
 *
 * 测试 memory_update 工具的各种场景：
 * 新建/覆盖、安全检查（路径/大小/行数）、文件限制、冲突检测。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mem-update-test-"));

function l2Dir(cwd: string): string {
	return path.join(cwd, ".pi", "memory");
}

function l2Index(cwd: string): string {
	return path.join(l2Dir(cwd), "MEMORY.md");
}

// 缓存被注册的 execute 函数
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

beforeEach(() => {
	for (const e of fs.readdirSync(TMP_DIR)) {
		fs.rmSync(path.join(TMP_DIR, e), { recursive: true, force: true });
	}
});

afterAll(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("memory_update execute — 基本写入", () => {
	it("新建文件成功", async () => {
		const cwd = TMP_DIR;
		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "test--a,b,c.md", content: "# Test\n内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("✅");
		expect(result.content[0].text).toContain("新建");

		const filePath = path.join(l2Dir(cwd), "test--a,b,c.md");
		expect(fs.existsSync(filePath)).toBe(true);
		expect(fs.readFileSync(filePath, "utf-8")).toContain("内容");
		expect(fs.existsSync(l2Index(cwd))).toBe(true);
	});

	it("覆盖已有文件", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "test--a.md"),
			"# Old\n旧内容",
			"utf-8",
		);

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "test--a.md", content: "# New\n新内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("✅");
		expect(result.content[0].text).toContain("覆盖");
		expect(
			fs.readFileSync(path.join(l2Dir(cwd), "test--a.md"), "utf-8"),
		).toContain("新内容");
	});
});

describe("memory_update execute — 安全检查", () => {
	it("拒绝路径遍历", async () => {
		const cwd = TMP_DIR;
		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "../../etc/passwd.md", content: "# hack\n", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("不允许包含路径分隔符");
	});

	it("拒绝超过 50KB 的内容", async () => {
		const cwd = TMP_DIR;
		const execute = await getMemoryUpdate();
		const bigContent = "x".repeat(60_000);
		const result = await execute(
			"id",
			{ fileName: "big--file.md", content: bigContent, scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("超过");
	});

	it("拒绝超过 200 行的内容", async () => {
		const cwd = TMP_DIR;
		const execute = await getMemoryUpdate();
		const longContent = Array.from({ length: 250 }, (_, i) => `line-${i}`).join(
			"\n",
		);
		const result = await execute(
			"id",
			{ fileName: "long--file.md", content: longContent, scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("超过");
	});
});

describe("memory_update execute — 文件数限制", () => {
	it("拒绝超过文件数硬限制", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		for (let i = 0; i < 40; i++) {
			fs.writeFileSync(
				path.join(l2Dir(cwd), `file${i}--a.md`),
				`# File ${i}\n`,
				"utf-8",
			);
		}

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "overflow--new.md", content: "# New\n内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("硬限制");
	});

	it("覆盖已有文件不触发文件数硬限制", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		for (let i = 0; i < 40; i++) {
			fs.writeFileSync(
				path.join(l2Dir(cwd), `file${i}--a.md`),
				`# File ${i}\n`,
				"utf-8",
			);
		}

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "file0--a.md", content: "# Updated\n新内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("✅");
	});
});

describe("memory_update execute — 冲突检测", () => {
	it("同 topic 冲突并拒绝", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "coding--git.md"),
			"# Coding\n内容",
			"utf-8",
		);

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{
				fileName: "coding--new.md",
				content: "# Coding v2\n新内容",
				scope: "L2",
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("冲突");
	});

	it("3+ 关键词重叠冲突并拒绝", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "existing--a,b,c,d.md"),
			"# Existing\n内容",
			"utf-8",
		);

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "new--a,b,c.md", content: "# New\n新内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("❌");
		expect(result.content[0].text).toContain("冲突");
	});

	it("不超过 2 个关键词重叠不会冲突", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		fs.writeFileSync(
			path.join(l2Dir(cwd), "existing--a,b,c,d.md"),
			"# Existing\n内容",
			"utf-8",
		);

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "new--a,b.md", content: "# New\n新内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("✅");
	});
});

describe("memory_update execute — scope 与警告", () => {
	it("默认 scope 为 L2", async () => {
		const cwd = TMP_DIR;
		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "default--scope.md", content: "# Default\n内容" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("✅");
		expect(fs.existsSync(l2Dir(cwd))).toBe(true);
	});

	it("文件数接近软限制时提示", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		for (let i = 0; i < 22; i++) {
			fs.writeFileSync(
				path.join(l2Dir(cwd), `file${i}--x.md`),
				`# File ${i}\n`,
				"utf-8",
			);
		}

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "hinttest--a.md", content: "# Hint\n内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("💡");
	});

	it("文件数超过软限制时严重警告", async () => {
		const cwd = TMP_DIR;
		fs.mkdirSync(l2Dir(cwd), { recursive: true });
		for (let i = 0; i < 26; i++) {
			fs.writeFileSync(
				path.join(l2Dir(cwd), `file${i}--x.md`),
				`# File ${i}\n`,
				"utf-8",
			);
		}

		const execute = await getMemoryUpdate();
		const result = await execute(
			"id",
			{ fileName: "softlimit--test.md", content: "# Soft\n内容", scope: "L2" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(result.content[0].text).toContain("⚠️");
		expect(result.content[0].text).toContain("接近");
	});
});
