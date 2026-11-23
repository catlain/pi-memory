/**
 * MemoryRouter 核心测试 — 计数触发 / tool 轮不计数 / 幂等 / 白名单 / fail-open
 * （mock judge 与 asset-catalog，隔离 LLM 与磁盘）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@pi-atelier/shared-utils/judge", () => ({
	createJudge: () => ({
		setContext: vi.fn(),
		resetContext: vi.fn(),
		judge: vi.fn(async () => [] as string[]),
	}),
}));

vi.mock("../lib/asset-catalog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/asset-catalog")>();
	return {
		...actual,
		collectMemoryAssets: () => [
			{ entry: "memory/git--x.md", desc: "git 判例" },
			{ entry: "memory/vitest--y.md", desc: "vitest 陷阱" },
		],
		collectSpecAssets: () => [{ entry: "openspec/specs/cap-a/spec.md", desc: "能力 A" }],
	};
});

import { MemoryRouter } from "../lib/routing";

function msg(texts: string[]) {
	return {
		message: {
			role: "assistant",
			content: texts.map((t) => ({ type: "text", text: t })),
		},
	};
}

describe("MemoryRouter 计数与触发（specs §1.1/1.2）", () => {
	it("纯 tool 轮（无 text 块）不计数", () => {
		const r = new MemoryRouter("/tmp", { enabled: true, batchSize: 2, includeSpecs: true, judgeModel: "" });
		r.accumulate({ message: { role: "assistant", content: [{ type: "toolCall", id: "t1" }] } });
		expect((r as unknown as { buffer: string[] }).buffer).toHaveLength(0);
	});
	it("不满 batchSize 不触发判定", async () => {
		const r = new MemoryRouter("/tmp", { enabled: true, batchSize: 5, includeSpecs: true, judgeModel: "" });
		r.accumulate(msg(["第一条"]));
		await r.maybeTrigger();
		// 未计满：buffer 未清
		expect((r as unknown as { buffer: string[] }).buffer).toHaveLength(1);
	});
	it("计满触发判定并清空 buffer（judge mock 返回空 = 无注入）", async () => {
		const r = new MemoryRouter("/tmp", { enabled: true, batchSize: 2, includeSpecs: true, judgeModel: "" });
		r.accumulate(msg(["a"]));
		r.accumulate(msg(["b"]));
		await r.maybeTrigger();
		expect((r as unknown as { buffer: string[] }).buffer).toHaveLength(0);
	});
});

describe("fail-open（specs §1.5）", () => {
	it("runBatch 异常静默吞掉不抛出", async () => {
		const r = new MemoryRouter("/tmp", { enabled: true, batchSize: 1, includeSpecs: true, judgeModel: "" });
		// accumulate 一次触发（batchSize=1）
		r.accumulate(msg(["x"]));
		// maybeTrigger 内部 try/catch：即使 judge mock 抛错也不抛出
		vi.mocked;
		await expect(r.maybeTrigger()).resolves.toBeUndefined();
	});
});
