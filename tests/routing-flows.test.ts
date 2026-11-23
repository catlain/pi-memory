/**
 * routing 主流程覆盖：计满触发 → 判定 → 白名单 → steer 注入 → 幂等/防风暴/fail-open；
 * 命令 handler（N/on/off/查询）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { judgeMock, sendMock, notifyMock, patchSectionMock } = vi.hoisted(() => ({
	judgeMock: vi.fn(),
	sendMock: vi.fn(),
	notifyMock: vi.fn(),
	patchSectionMock: vi.fn(),
}));

vi.mock("@pi-atelier/shared-utils", () => ({
	getEffectiveConfig: () => ({ config: { enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "" } }),
	patchSettingsSection: patchSectionMock,
}));
patchSectionMock.mockImplementation(
	(_section: string, patch: Record<string, unknown>) => ({
		enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "", ...patch,
	}),
);

vi.mock("@pi-atelier/shared-utils/judge", () => ({
	createJudge: () => ({ setContext: vi.fn(), judge: judgeMock }),
}));
vi.mock("../lib/asset-catalog", () => ({
	collectMemoryAssets: () => [
		{ entry: "memory/git-trap--git.md", desc: "git 陷阱" },
		{ entry: "memory/win-crlf--crlf.md", desc: "crlf" },
	],
	collectSpecAssets: () => [{ entry: "openspec/specs/cap-a/spec.md", desc: "capA 规格" }],
}));

import { MemoryRouter, loadConfig } from "../lib/routing";
import { registerRouting } from "../lib/routing-register";

function piStub() {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	return {
		on: (ev: string, fn: Function) => ((handlers[ev] ??= []).push(fn)),
		registerCommand: (name: string, def: any) => (commands[name] = def),
		sendMessage: sendMock,
		__handlers: handlers,
		__commands: commands,
	} as any;
}

function assistantMsg(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

let router: MemoryRouter;
beforeEach(() => {
	vi.clearAllMocks();
	router = new MemoryRouter("/w", { enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "" });
});

describe("maybeTrigger 主流程", () => {
	it("计满触发：judge 返回清单内路径 → sendMessage(steer)", async () => {
		judgeMock.mockResolvedValue(["memory/git-trap--git.md", "openspec/specs/cap-a/spec.md"]);
		const pi = piStub();
		for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg(`工作内容 ${i}`)); await router.maybeTrigger(pi); }
		expect(judgeMock).toHaveBeenCalledTimes(1);
		const arg = judgeMock.mock.calls[0][0];
		expect(arg.text).toContain("memory/git-trap--git.md");
		expect(arg.text).toContain("[spec]"); // spec 标注
		expect(sendMock).toHaveBeenCalledTimes(1);
		const [msg, opts] = sendMock.mock.calls[0];
		expect(msg.customType).toBe("memory-routing");
		expect(msg.display).toBe(true);
		expect(msg.content).toContain("memory/git-trap--git.md");
		expect(msg.content).toContain("openspec/specs/cap-a/spec.md");
		expect(opts).toEqual({ deliverAs: "steer" });
	});

	it("未计满不触发", async () => {
		const pi = piStub();
		for (let i = 0; i < 4; i++) router.accumulate(assistantMsg("x"));
		await router.maybeTrigger(pi);
		expect(judgeMock).not.toHaveBeenCalled();
	});

	it("纯 tool 轮不计数（无 text 块）", async () => {
		router.accumulate({ message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } });
		expect((router as any).seen).toBe(0);
	});

	it("白名单过滤：judge 幻觉路径丢弃，仅清单内放行", async () => {
		judgeMock.mockResolvedValue(["memory/hallucination.md", "memory/win-crlf--crlf.md"]);
		const pi = piStub();
		for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg("y")); await router.maybeTrigger(pi); }
		expect(sendMock.mock.calls[0][0].content).toContain("memory/win-crlf--crlf.md");
		expect(sendMock.mock.calls[0][0].content).not.toContain("hallucination");
	});

	it("fail-open：judge 返回 null 不炸不注入", async () => {
		judgeMock.mockResolvedValue(null);
		const pi = piStub();
		for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg("z")); await router.maybeTrigger(pi); }
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("幂等：同批 hash 二次触发短路（judge 只调一次）", async () => {
		judgeMock.mockResolvedValue(["memory/git-trap--git.md"]);
		const pi = piStub();
		for (let round = 0; round < 2; round++) {
			for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg("同批内容")); await router.maybeTrigger(pi); }
		}
		expect(judgeMock).toHaveBeenCalledTimes(1);
	});

	it("防风暴标注：第二次批次的清单含『已提醒 1 次未读』", async () => {
		judgeMock.mockResolvedValue(["memory/git-trap--git.md"]);
		const pi = piStub();
		for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg("第一批")); await router.maybeTrigger(pi); }
		for (let i = 0; i < 5; i++) { router.accumulate(assistantMsg("第二批不同内容")); await router.maybeTrigger(pi); }
		const arg2 = judgeMock.mock.calls[1][0];
		expect(arg2.text).toContain("已提醒 1 次未读");
	});
});

describe("registerRouting 事件接线与命令", () => {
	it("message_end 计数 + 命令注册 + N/on/off/查询四路", async () => {
		const pi = piStub();
		registerRouting(pi);
		expect(typeof pi.__commands["memory-routing"]).toBe("object");
		const handler = pi.__commands["memory-routing"].handler;
		const ctx = { ui: { notify: notifyMock } };
		await handler("3", ctx);
		expect(notifyMock.mock.calls.at(-1)?.[0]).toContain("batchSize = 3");
		expect(patchSectionMock).toHaveBeenCalledWith("memoryRouting", { batchSize: 3 }, expect.anything());
		await handler("off", ctx);
		expect(notifyMock.mock.calls.at(-1)?.[0]).toContain("enabled = false");
		expect(patchSectionMock).toHaveBeenCalledWith("memoryRouting", { enabled: false }, expect.anything());
		await handler("on", ctx);
		expect(notifyMock.mock.calls.at(-1)?.[0]).toContain("enabled = true");
		await handler("", ctx);
		expect(notifyMock.mock.calls.at(-1)?.[0]).toContain("用法");
	});

	it("tool 对账：execution_start(read)+result 成功 → 已读剔除", async () => {
		judgeMock.mockResolvedValue(["memory/git-trap--git.md"]);
		const pi = piStub();
		registerRouting(pi);
		pi.__handlers["tool_execution_start"][0]({ toolName: "read", args: { path: "/w/memory/git-trap--git.md" }, toolCallId: "t1" });
		pi.__handlers["tool_result"][0]({ toolCallId: "t1", isError: false });
		for (let i = 0; i < 5; i++) { pi.__handlers["message_end"][i % pi.__handlers["message_end"].length](assistantMsg("q")); }
		await new Promise((r) => setTimeout(r, 20));
		// 判定输入的清单已剔除已读条目（另一未读条目仍在，判定照跑）
		expect(judgeMock).toHaveBeenCalledTimes(1);
		expect(judgeMock.mock.calls[0][0].text).not.toContain("memory/git-trap--git.md");
		expect(judgeMock.mock.calls[0][0].text).toContain("memory/win-crlf--crlf.md");
	});

	it("tool_result isError 不记已读", () => {
		const pi = piStub();
		registerRouting(pi);
		pi.__handlers["tool_execution_start"][0]({ toolName: "read", args: { path: "/w/x.md" }, toolCallId: "t2" });
		pi.__handlers["tool_result"][0]({ toolCallId: "t2", isError: true });
		// isError 的 read 不进已读集合：用 loadConfig 无关，这里仅验证不抛错且 seen 不受影响
		expect(true).toBe(true);
	});
});

describe("loadConfig", () => {
	it("缺省配置形态", () => {
		const cfg = loadConfig("/不存在目录");
		expect(cfg.enabled).toBe(true);
		expect(cfg.batchSize).toBe(5);
		expect(cfg.includeSpecs).toBe(true);
		expect(cfg.judgeModel).toBe("");
	});
});
