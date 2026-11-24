/**
 * SDK 消息形态防御测试（复盘对策落地）：
 * ① 形态矩阵——各 role × content 形态（string/array/null/缺失）不炸且行为正确
 * ② dump 钩子——dumpEvents=true 时事件落盘（fixture 抓取通道）
 * ③ 多会话热读迁移——会话 A off，会话 B 下一判定感知（跨会话配置一致性）
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { contentBlocksOf, roleOf } from "../lib/msg-shapes";

const { emitMock, patchSectionMock, settingsStore, appendMock } = vi.hoisted(() => ({
	emitMock: vi.fn(),
	patchSectionMock: vi.fn(),
	settingsStore: { settings: { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" } as Record<string, unknown> },
	appendMock: vi.fn(),
}));

vi.mock("node:fs", () => ({ appendFileSync: appendMock }));

vi.mock("@pi-atelier/shared-utils", () => ({
	getEffectiveConfig: () => ({ config: { ...settingsStore.settings } }),
	patchSettingsSection: (patchSectionMock as unknown as (s: string, p: Record<string, unknown>, d?: unknown) => unknown),
}));
vi.mock("@pi-atelier/shared-utils/judge", () => ({
	createJudge: () => ({ setContext: vi.fn(), judge: async () => null, resetContext: vi.fn() }),
}));

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(settingsStore.settings, { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
});

describe("msg-shapes helper：形态解析矩阵", () => {
	const cases: Array<[unknown, number, string | undefined]> = [
		[{ message: { role: "user", content: "纯字符串" } }, 0, "user"],
		[{ message: { role: "user", content: [{ type: "text", text: "x" }] } }, 1, "user"],
		[{ message: { role: "assistant", content: "意外 string 形态" } }, 0, "assistant"],
		[{ message: { role: "toolResult", content: [{ type: "text", text: "全文" }] } }, 1, "toolResult"],
		[{ message: { role: "assistant", content: null } }, 0, "assistant"],
		[{ message: { content: undefined } }, 0, undefined],
		[{}, 0, undefined],
		[null, 0, undefined],
	];
	for (const [evt, n, role] of cases) {
		it(`role=${role} → ${n} 块`, () => {
			expect(contentBlocksOf(evt)).toHaveLength(n);
			expect(roleOf(evt)).toBe(role);
		});
	}
});

describe("register：message_end 形态矩阵不炸（SDK 消息多样性）", () => {
	it.each([
		["user string", { role: "user", content: "文本" }],
		["user array", { role: "user", content: [{ type: "text", text: "t" }] }],
		["assistant string（意外形态）", { role: "assistant", content: "s" }],
		["assistant 混合块", { role: "assistant", content: [{ type: "thinking", text: "想" }, { type: "text", text: "叙述" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] }],
		["toolResult 全文块", { role: "toolResult", content: [{ type: "text", text: "read 文件全文……" }] }],
		["toolResult image 块", { role: "toolResult", content: [{ type: "image", source: {} }] }],
		["content null", { role: "assistant", content: null }],
		["缺 message", undefined],
		["空对象", {}],
	])("%s：handler 完成且不 throw", async (_label, msg) => {
		const { registerRouting } = await import("../lib/routing-register");
		const handlers: Record<string, Array<(e?: unknown, c?: unknown) => unknown>> = {};
		const pi = {
			events: { emit: emitMock },
			sendMessage: vi.fn(),
			on: (n: string, fn: (e?: unknown, c?: unknown) => unknown) => { (handlers[n] ??= []).push(fn); },
			__commands: {},
			registerCommand: vi.fn(),
		} as unknown as Parameters<typeof registerRouting>[0];
		registerRouting(pi);
		await expect(
			(handlers["message_end"] ?? [])[0]?.({ message: msg }),
		).resolves.toBeUndefined();
	});
});

describe("register：dumpEvents 钩子", () => {
	it("dumpEvents=true 时事件写入 jsonl（string content 截 300 字）", async () => {
		settingsStore.settings.dumpEvents = true;
		const { registerRouting } = await import("../lib/routing-register");
		const handlers: Record<string, Array<(e?: unknown, c?: unknown) => unknown>> = {};
		const pi = {
			events: { emit: emitMock },
			sendMessage: vi.fn(),
			on: (n: string, fn: (e?: unknown, c?: unknown) => unknown) => { (handlers[n] ??= []).push(fn); },
			__commands: {},
			registerCommand: vi.fn(),
		} as unknown as Parameters<typeof registerRouting>[0];
		registerRouting(pi);
		await (handlers["message_end"] ?? [])[0]?.({ message: { role: "user", content: "x".repeat(500) } });
		expect(appendMock).toHaveBeenCalled();
		const line = appendMock.mock.calls[0]?.[1] as string;
		expect(JSON.parse(line).hook).toBe("message_end");
		expect(JSON.parse(line).message.content).toHaveLength(300);
		delete settingsStore.settings.dumpEvents;
	});
});

describe("状态迁移：多会话热读（会话 A off → 会话 B 下一判定感知）", () => {
	it("B 的 maybeTrigger 热读到 enabled=false，不 emit（judge 不会被调到产出）", async () => {
		const { MemoryRouter } = await import("../lib/routing");
		const b = new MemoryRouter("/proj", { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
		b.accumulate({ message: { role: "assistant", content: [{ type: "text", text: "会话B的叙述".repeat(20) }] } });
		b.setJudgeContext({ fake: 1 });
		settingsStore.settings.enabled = false; // 会话 A 执行 /memory-routing off（写全局 settings）
		const pi = { events: { emit: emitMock }, sendMessage: vi.fn() } as unknown as Parameters<typeof b.maybeTrigger>[0];
		await b.maybeTrigger(pi);
		expect(emitMock).not.toHaveBeenCalled(); // 热读拦截：off 后零 emit（judge 内部行为由模块级 mock 固定为 null）
	});
});
