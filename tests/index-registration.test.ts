/**
 * index.ts 测试 — 工具注册
 * 
 * 验证 memoryToolsExtension 正确注册两个工具（memory_index / memory_update）。
 */

import { describe, it, expect, vi } from "vitest";

describe("工具注册", () => {
	it("注册 memory_index 和 memory_update 两个工具", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		const mockPi = { registerTool, on };

		const mod = await import("../index");
		mod.default(mockPi as any);

		expect(registerTool).toHaveBeenCalledTimes(2);
		const names = registerTool.mock.calls.map((c: any[]) => c[0].name);
		expect(names).toContain("memory_index");
		expect(names).toContain("memory_update");
	});

	it("工具 description 为字符串", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		const mockPi = { registerTool, on };

		const mod = await import("../index");
		mod.default(mockPi as any);

		for (const call of registerTool.mock.calls) {
			const tool = call[0];
			expect(typeof tool.label).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});

	it("工具参数 schema 正确", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		const mockPi = { registerTool, on };

		const mod = await import("../index");
		mod.default(mockPi as any);

		const indexTool = registerTool.mock.calls.find((c: any[]) => c[0].name === "memory_index")[0];
		expect(indexTool.parameters).toBeTruthy();

		const updateTool = registerTool.mock.calls.find((c: any[]) => c[0].name === "memory_update")[0];
		expect(updateTool.parameters).toBeTruthy();
	});
});
