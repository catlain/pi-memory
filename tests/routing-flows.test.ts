/**
 * routing v2 主流程：字符池触发（三信号源入池）→ 判定 → 关键词匹配 → ephemeral 注入；
 * fail-open / 幂等 / 已读剔除 / 命令（N=字符阈值）持久化。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { judgeMock, emitMock, notifyMock, patchSectionMock } = vi.hoisted(() => ({
	judgeMock: vi.fn(),
	emitMock: vi.fn(),
	notifyMock: vi.fn(),
	patchSectionMock: vi.fn(),
}));

vi.mock("@pi-atelier/shared-utils", () => ({
	getEffectiveConfig: () => ({ config: { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" } }),
	patchSettingsSection: patchSectionMock,
}));
patchSectionMock.mockImplementation(
	(_section: string, patch: Record<string, unknown>) => ({ enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "", ...patch }),
);

vi.mock("@pi-atelier/shared-utils/judge", () => ({
	createJudge: () => ({ setContext: vi.fn(), judge: judgeMock }),
}));
vi.mock("../lib/asset-catalog", () => ({
	collectMemoryAssets: () => [
		{ entry: "memory/git-trap--git.md", desc: "git 陷阱判例" },
		{ entry: "memory/win-crlf--crlf.md", desc: "crlf" },
	],
	collectSpecAssets: () => [{ entry: "openspec/specs/cap-a/spec.md", desc: "capA 规格" }],
}));

import { MemoryRouter } from "../lib/routing";
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

const longText = "x".repeat(60);

function assistantMsg(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

let router: MemoryRouter;
beforeEach(() => {
	vi.clearAllMocks();
	router = new MemoryRouter("/w", { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
});

describe("字符池触发（三信号源）", () => {
	it("叙述入池计字符，满阈值触发判定", async () => {
		judgeMock.mockResolvedValue(["git 陷阱"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("短回复不刷频（不足阈值不判定）", async () => {
		router.accumulate(assistantMsg("好的。"));
		await router.maybeTrigger(piStub());
		expect(judgeMock).not.toHaveBeenCalled();
	});

	it("纯 toolCall 消息（无叙述）也入池（工具摘要计字符）", async () => {
		judgeMock.mockResolvedValue([]);
		router.accumulate({ message: { content: [{ type: "toolCall", name: "bash", arguments: { command: longText } }] } });
		await router.maybeTrigger(piStub());
		expect(judgeMock).toHaveBeenCalledTimes(1);
		expect(String(judgeMock.mock.calls[0][0].text)).toContain("[tool] bash:");
	});

	it("报错入池（isError=true），成功结果不入池", async () => {
		router.observeToolResult("bash", { command: "ls" }, true, `ETARGET No matching version ${"y".repeat(80)}`);
		router.observeToolResult("read", { path: "/a.md" }, false, "content...");
		await router.maybeTrigger(piStub());
		expect(judgeMock).toHaveBeenCalledTimes(1);
		const text = String(judgeMock.mock.calls[0][0].text);
		expect(text).toContain("[tool✗] ETARGET");
		expect(text).not.toContain("content...");
	});

	it("判定后池清零：第二批重新累计", async () => {
		judgeMock.mockResolvedValue([]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		router.accumulate(assistantMsg("短回复"));
		await router.maybeTrigger(piStub());
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});
});

describe("关键词匹配与 ephemeral 注入", () => {
	it("关键词命中 → 未读资产 → ephemeral:hint 发出", async () => {
		judgeMock.mockResolvedValue(["git 陷阱"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).toHaveBeenCalledTimes(1);
		expect(emitMock.mock.calls[0][0]).toContain("ephemeral:hint");
		expect(String(emitMock.mock.calls[0][1].text)).toContain("memory/git-trap--git.md");
	});

	it("关键词零命中 → 静默无提醒", async () => {
		judgeMock.mockResolvedValue(["量子纠缠"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("命中资产全部已读 → 无提醒", async () => {
		judgeMock.mockResolvedValue(["git 陷阱"]);
		router.readTracker.recordRead("read", { path: "/w/memory/git-trap--git.md" }, false);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("判定返回无/空 → 静默", async () => {
		judgeMock.mockResolvedValue([]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("判定抛错 → fail-open 不炸", async () => {
		judgeMock.mockRejectedValue(new Error("boom"));
		router.accumulate(assistantMsg(longText));
		await expect(router.maybeTrigger(piStub())).resolves.toBeUndefined();
	});
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

describe("registerRouting 事件接线", () => {
	it("message_end 五次接入后（长文本一次满池）判定发生", async () => {
		judgeMock.mockResolvedValue([]);
		const pi = piStub();
		registerRouting(pi);
		pi.__handlers["message_end"][0](assistantMsg(longText));
		await new Promise((r) => setTimeout(r, 10));
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("tool_execution_start + tool_result 对账：报错入池驱动判定", async () => {
		judgeMock.mockResolvedValue([]);
		const pi = piStub();
		registerRouting(pi);
		// 报错入池（tool_result 只入池不触发），message_end 短叙述补足阈值后触发判定
		pi.__handlers["tool_execution_start"][0]({ toolName: "bash", args: { command: "npm view x" }, toolCallId: "tc1" });
		pi.__handlers["tool_result"][0]({ toolCallId: "tc1", isError: true, result: `ETARGET ${"e".repeat(60)}` });
		pi.__handlers["message_end"][0](assistantMsg("短。"));
		await new Promise((r) => setTimeout(r, 10));
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("read 成功经 tool_result 记入已读集合", async () => {
		judgeMock.mockResolvedValue(["git 陷阱"]);
		const pi = piStub();
		registerRouting(pi);
		pi.__handlers["tool_execution_start"][0]({ toolName: "read", args: { path: "/w/memory/git-trap--git.md" }, toolCallId: "tc1" });
		pi.__handlers["message_end"][0](assistantMsg(longText));
		pi.__handlers["tool_result"][0]({ toolCallId: "tc1", isError: false, result: "ok" });
		await new Promise((r) => setTimeout(r, 10));
		expect(emitMock).not.toHaveBeenCalled();
	});
});
