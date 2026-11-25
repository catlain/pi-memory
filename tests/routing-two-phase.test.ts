/**
 * 两段判定链路：S1 提取领域名（批进 S1）→ S2 词表纯映射（领域名+词库，批不进 S2）；
 * S1 空/异常的 fail-open；S2 标签在日志中一行还原决策链。
 * （自 routing-flows.test.ts 拆出——该文件超 200 行阈值）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { topicMock, mapMock, emitMock, settingsStore } = vi.hoisted(() => ({
	topicMock: vi.fn(),
	mapMock: vi.fn(),
	emitMock: vi.fn(),
	settingsStore: { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" } as Record<string, unknown>,
}));

vi.mock("@pi-atelier/shared-utils", () => ({
	getEffectiveConfig: () => ({ config: { ...settingsStore } }),
}));
vi.mock("@pi-atelier/shared-utils/judge", () => ({
	// 两段判定：工厂按 label 分流（S1 提取领域名 / S2 词表映射）
	createJudge: (opts: { label?: string }) => ({ setContext: vi.fn(), judge: opts?.label === "memory-routing-topics" ? topicMock : mapMock }),
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
	const handlers: Record<string, Function[]> = {};
	return {
		on: (ev: string, fn: Function) => (handlers[ev] ??= []).push(fn),
		registerCommand: () => {},
		events: { emit: emitMock },
		__handlers: handlers,
	} as any;
}

const longText = "x".repeat(60);

function assistantMsg(text: string) {
	return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

let router: MemoryRouter;
beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(settingsStore, { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
	topicMock.mockResolvedValue(["git"]);
	mapMock.mockResolvedValue(["git"]);
	router = new MemoryRouter("/w", { enabled: true, batchChars: 50, includeSpecs: true, judgeModel: "" });
});

describe("两段判定链路（S1 提取领域名 → S2 词表映射）", () => {
	it("批只进 S1；S2 的输入是领域名 + 词库，不含批", async () => {
		topicMock.mockResolvedValue(["git 陷阱"]);
		mapMock.mockResolvedValue(["git"]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		const s1 = topicMock.mock.calls[0][0];
		const s2 = mapMock.mock.calls[0][0];
		expect(String(s1.text)).toContain(longText);
		expect(String(s1.question)).not.toContain("词库");
		expect(String(s2.text)).toBe("git 陷阱"); // 领域名逐行，不含批
		expect(String(s2.question)).toContain("词库");
		expect(String(s2.question)).toContain("git");
		expect(String(s2.question)).not.toContain(longText);
	});

	it("S1 无可命名领域（返回空）→ S2 不调用，静默", async () => {
		topicMock.mockResolvedValue([]);
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(topicMock).toHaveBeenCalledTimes(1);
		expect(mapMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("S1 异常 → fail-open：S2 不调用、不炸", async () => {
		topicMock.mockRejectedValue(new Error("S1 down"));
		router.accumulate(assistantMsg(longText));
		await expect(router.maybeTrigger(piStub())).resolves.toBeUndefined();
		expect(mapMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});

	it("S2 标签 = S1 标签 + →map(领域名)（日志一行还原决策链）", async () => {
		router.accumulate(assistantMsg(longText));
		await router.maybeTrigger(piStub());
		expect(mapMock.mock.calls[0][0].contextLabel).toBe(`${topicMock.mock.calls[0][0].contextLabel}→map(git)`);
	});
});
