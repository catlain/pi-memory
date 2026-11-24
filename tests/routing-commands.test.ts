/**
 * /memory-routing 命令：数字参数 = batchChars 持久化 / on/off / 非法参数。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitMock, patchSectionMock, settingsStore } = vi.hoisted(() => ({
	emitMock: vi.fn(),
	patchSectionMock: vi.fn(),
	settingsStore: { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" } as Record<string, unknown>,
}));

vi.mock("@pi-atelier/shared-utils", () => ({
	getEffectiveConfig: () => ({ config: { ...settingsStore } }),
	patchSettingsSection: patchSectionMock,
}));
patchSectionMock.mockImplementation((_section: string, patch: Record<string, unknown>) => {
	Object.assign(settingsStore, patch);
	return { ...settingsStore } as any;
});
vi.mock("../lib/asset-catalog", () => ({
	collectMemoryAssets: () => [
		{ entry: "memory/git-trap--git.md", desc: "git 陷阱判例" },
		{ entry: "memory/win-crlf--crlf.md", desc: "crlf" },
	],
	collectSpecAssets: () => [{ entry: "openspec/specs/cap-a/spec.md", desc: "capA 规格" }],
}));

import { registerRouting } from "../lib/routing-register";

function piStub() {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	return {
		on: (ev: string, fn: Function) => (handlers[ev] ??= []).push(fn),
		registerCommand: (name: string, def: any) => (commands[name] = def),
		events: { emit: emitMock },
		__handlers: handlers,
		__commands: commands,
	} as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(settingsStore, { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
});

describe("命令（字符阈值语义 + 持久化）", () => {
	it("数字参数 = batchChars 持久化", async () => {
		const pi = piStub();
		registerRouting(pi);
		const notify = vi.fn();
		await pi.__commands["memory-routing"].handler("1500", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("batchChars = 1500"), "info");
		expect(patchSectionMock).toHaveBeenCalledWith("memoryRouting", { batchChars: 1500 }, expect.anything());
	});

	it("on/off 持久化并即时生效", async () => {
		const pi = piStub();
		registerRouting(pi);
		const notify = vi.fn();
		const ctx = { ui: { notify } };
		await pi.__commands["memory-routing"].handler("off", ctx);
		expect(patchSectionMock).toHaveBeenCalledWith("memoryRouting", { enabled: false }, expect.anything());
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("enabled = false"), "info");
		await pi.__commands["memory-routing"].handler("", ctx);
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("enabled=false"), "info");
	});

	it("非法参数报错（含范围提示）", async () => {
		const pi = piStub();
		registerRouting(pi);
		const notify = vi.fn();
		await pi.__commands["memory-routing"].handler("abc", { ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("无效参数"), "info");
	});
});
