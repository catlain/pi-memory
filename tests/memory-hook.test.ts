/**
 * memory-hook.ts 测试 — before_agent_start hook 注册
 * 
 * 使用 vi.mock("node:fs") 控制文件存在性和内容。
 * 注意：vi.spyOn 对 ESM 模块（node:fs）不适用，必须用 vi.mock。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock node:fs ──────────────────────────────────────────

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	// 需要提供这些让 path 模块正常工作
	exists: vi.fn(),
	lstatSync: vi.fn(),
	realpathSync: vi.fn(),
}));

// ── 测试 ──────────────────────────────────────────────────

describe("registerMemoryHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("memory-prompt.md 存在时注册 before_agent_start hook", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("# Memory\n\n你有基于文件的持久记忆。");

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).toHaveBeenCalledTimes(1);
		expect(on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	it("memory-prompt.md 不存在时不注册 hook", async () => {
		mockExistsSync.mockReturnValue(false);

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).not.toHaveBeenCalled();
	});

	it("memory-prompt.md 为空时不注册 hook", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(""); // trim 后为空

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).not.toHaveBeenCalled();
	});

	it("memory-prompt.md 只含空白时不注册 hook", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("   \n  "); // trim 后为空

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).not.toHaveBeenCalled();
	});

	it("existsSync 抛异常时静默跳过", async () => {
		mockExistsSync.mockImplementation(() => {
			throw new Error("permission denied");
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).not.toHaveBeenCalled();
	});

	it("readFileSync 抛异常时静默跳过", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockImplementation(() => {
			throw new Error("read error");
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		expect(on).not.toHaveBeenCalled();
	});

	it("注册的 handler 正确拼接 systemPrompt", async () => {
		// memory-prompt.md 存在
		mockExistsSync.mockImplementation((p: string) => p.includes("memory-prompt.md"));
		mockReadFileSync.mockImplementation((p: string) => {
			if (p.includes("memory-prompt.md")) return "# Memory\n\n记忆说明文本。";
			return "";
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		const handler = on.mock.calls[0][1];
		const result = await handler({
			systemPrompt: "原始 system prompt",
			systemPromptOptions: { cwd: "/tmp" },
		});

		expect(result.systemPrompt).toContain("原始 system prompt");
		expect(result.systemPrompt).toContain("# Memory");
		expect(result.systemPrompt).toContain("\n\n");
	});

	it("handler 使用 event.systemPromptOptions.cwd", async () => {
		mockExistsSync.mockImplementation((p: string) => p.includes("memory-prompt.md"));
		mockReadFileSync.mockImplementation((p: string) => {
			if (p.includes("memory-prompt.md")) return "# Memory\n\n记忆说明。";
			return "";
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		const handler = on.mock.calls[0][1];
		const customCwd = "/custom/path";
		const result = await handler({
			systemPrompt: "prompt",
			systemPromptOptions: { cwd: customCwd },
		});

		expect(result.systemPrompt).toBeTruthy();
	});

	it("handler 在 systemPromptOptions 为空时用 process.cwd()", async () => {
		mockExistsSync.mockImplementation((p: string) => p.includes("memory-prompt.md"));
		mockReadFileSync.mockImplementation((p: string) => {
			if (p.includes("memory-prompt.md")) return "# Memory\n\n记忆说明。";
			return "";
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		const handler = on.mock.calls[0][1];
		const result = await handler({
			systemPrompt: "prompt",
			systemPromptOptions: {} as any,
		});

		expect(result.systemPrompt).toBeTruthy();
	});

	it("handler 在有记忆注入时正确拼接", async () => {
		// memory-prompt.md 和 MEMORY.md（L1/L2）都存在
		mockExistsSync.mockImplementation((p: string) =>
			p.includes("memory-prompt.md") || p.includes("MEMORY.md"),
		);
		mockReadFileSync.mockImplementation((p: string) => {
			if (p.includes("memory-prompt.md")) return "# Memory\n说明";
			if (p.includes("MEMORY.md")) return "# 记忆索引\n内容";
			return "";
		});

		const on = vi.fn();
		const mod = await import("../lib/memory-hook");
		mod.registerMemoryHook({ on } as any);

		const handler = on.mock.calls[0][1];
		const result = await handler({
			systemPrompt: "base",
			systemPromptOptions: { cwd: "/tmp" },
		});

		expect(result.systemPrompt).toContain("base");
		expect(result.systemPrompt).toContain("# Memory");
		expect(result.systemPrompt).toContain("# 记忆索引");
	});
});
