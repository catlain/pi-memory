/**
 * v3.4：enabled 三处检查（热读/快照/emit 前）+ 已提示集合 + settle-continue 消费语义。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { judgeMock, emitMock, notifyMock, patchSectionMock, settingsStore } = vi.hoisted(() => ({
	judgeMock: vi.fn(),
	emitMock: vi.fn(),
	notifyMock: vi.fn(),
	patchSectionMock: vi.fn(),
	// 模拟磁盘 settings：patch 写入 → loadConfig 热读回看（读写对称）
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

function piStub() {
	return { events: { emit: emitMock }, sendMessage: vi.fn() } as any;
}

const longText = "x".repeat(60);

function assistantMsg(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

let router: MemoryRouter;
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(settingsStore, { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" }); // 磁盘模拟重置
	router = new MemoryRouter("/w", { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
});

describe("v3.4：enabled 三处检查 + 已提示集合 + settle-continue", () => {
	it("off 后：热读拦截——零累积零 emit，池被清空", async () => {
		router.accumulate(assistantMsg(longText)); // 先积累（enabled=true 快照）
		settingsStore.enabled = false; // 模拟另一会话 off（磁盘变更）
		judgeMock.mockResolvedValue(["git"]);
		await router.maybeTrigger(piStub()); // 热读到 off → 清池 return，不判定
		expect(judgeMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("off 后 accumulate 不入池（快照级拦截）", async () => {
		router.setConfig({ ...router.config, enabled: false });
		router.accumulate(assistantMsg(longText));
		expect((router as any).charCount).toBe(0);
	});

	it("已提示集合：同资产二次命中不重弹", async () => {
		judgeMock.mockResolvedValue(["git"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).toHaveBeenCalledTimes(1);
		// 第二批同关键词：git-trap 已提示过 → 剔除（win-crlf 剩下仍 emit 但内容不含 git-trap）
		router.accumulate(assistantMsg("y".repeat(60) + " git git"));
		await router.maybeTrigger(piStub());
		const second = emitMock.mock.calls[1]?.[0] as { text: string } | undefined;
		if (second) expect(second.text).not.toContain("git-trap"); // 若仍命中其他资产，不含已提示者
	});

	it("settle-continue：emit 后计数可消费一次，二次消费为 false", async () => {
		judgeMock.mockResolvedValue(["git"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(emitMock).toHaveBeenCalledTimes(1);
		expect(router.consumePendingHint(piStub())).toBe(true); // settle 读到 → 补发空消息 → continue
		expect(router.consumePendingHint(piStub())).toBe(false); // 单次消费 → 收敛
	});

	it("回归：工具循环中间（endOfTurn=false）不置计数——防空消息被 flush 后非法 continue", async () => {
		router.accumulate(assistantMsg(longText));
		judgeMock.mockResolvedValue(["git"]);
		settingsStore.enabled = true;
		await router.maybeTrigger(piStub(), { endOfTurn: false }); // 工具循环中间的 message_end
		expect(emitMock).toHaveBeenCalledTimes(1); // hint 照常 emit（由下一次循环请求自然 drain）
		expect(router.consumePendingHint(piStub())).toBe(false); // 但不走 settle 链路 → 永不非法 continue
	});

	it("回归：settle 消费时补发 sendMessage（队列燃料）", async () => {
		router.accumulate(assistantMsg(longText));
		judgeMock.mockResolvedValue(["git"]);
		settingsStore.enabled = true;
		const pi = piStub();
		await router.maybeTrigger(pi, { endOfTurn: true }); // 回合末
		expect(pi.sendMessage).not.toHaveBeenCalled(); // emit 时不再发（防被中途 flush）
		const ok = router.consumePendingHint(pi);
		expect(ok).toBe(true);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1); // settle 时补发——队列有货，continue 合法
	});

	it("toolResult 消息的 text 块不入池（read 全文污染源修复）", () => {
		const r = new MemoryRouter("/w", { enabled: true, batchChars: 100, includeSpecs: true, judgeModel: "" });
		const toolResultMsg = { message: { role: "toolResult", content: [{ type: "text", text: "# 某记忆文件全文".repeat(30) }] } };
		r.accumulate(toolResultMsg);
		expect((r as unknown as { charCount: number }).charCount).toBe(0);
		r.accumulate({ message: { role: "assistant", content: [{ type: "text", text: "正常叙述" }] } });
		expect((r as unknown as { charCount: number }).charCount).toBeGreaterThan(0);
	});
});
