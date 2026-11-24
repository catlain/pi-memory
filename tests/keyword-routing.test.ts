import { describe, expect, it } from "vitest";
import { MAP_SYSTEM_PROMPT, TOPIC_SYSTEM_PROMPT, parseKeywords, parseTopics } from "../lib/keyword-routing";

describe("parseKeywords（S2 词表映射输出解析）", () => {
	it("每行一词 → 原样收集", () => {
		expect(parseKeywords("opsx\nsubagent")).toEqual(["opsx", "subagent"]);
	});

	it("「无」→ 空集（判定有效，无匹配）", () => {
		expect(parseKeywords("无")).toEqual([]);
		expect(parseKeywords("None")).toEqual([]);
	});

	it("无有效词 → null（判定作废）", () => {
		expect(parseKeywords("x")).toBeNull();
		expect(parseKeywords("   ")).toBeNull();
	});

	it("单行多词按分隔符拆分，短词丢弃", () => {
		expect(parseKeywords("opsx、a、npm")).toEqual(["opsx", "npm"]);
	});

	it("去重 + 总量上限 5", () => {
		const raw = ["a1", "a1", "b2", "c3", "d4", "e5", "f6"].join("\n");
		expect(parseKeywords(raw)).toEqual(["a1", "b2", "c3", "d4", "e5"]);
	});
});

describe("parseTopics（S1 领域名提取输出解析）", () => {
	it("剥序号 / markdown 残渣 / 列表符号", () => {
		const raw = "1. **OpenSpec**\n- 子代理架构\n> git 工作流\n_回测引擎_";
		expect(parseTopics(raw)).toEqual(["OpenSpec", "子代理架构", "git 工作流", "回测引擎"]);
	});

	it("顿号 / 逗号多领域同行拆分", () => {
		expect(parseTopics("OpenSpec、npm 发布；pre-commit")).toEqual(["OpenSpec", "npm 发布", "pre-commit"]);
	});

	it("「无」→ 空集", () => {
		expect(parseTopics("无")).toEqual([]);
	});

	it("空白 / 残渣-only → null（无领域，S2 不调用）", () => {
		expect(parseTopics("")).toBeNull();
		expect(parseTopics("**\n---")).toBeNull();
	});

	it("去重 + 总量上限 5（与提示词「最多 5 个」一致）；单字符噪声丢弃", () => {
		expect(parseTopics("A1\nA1\nB2\nC3\nD4\nE5\nF6\nx")).toEqual(["A1", "B2", "C3", "D4", "E5"]);
	});
});

describe("两段 system prompt 的契约要点", () => {
	it("S1 不含词库 / 不判断新旧（纯提取）", () => {
		expect(TOPIC_SYSTEM_PROMPT).not.toMatch(/词库|尚未掌握|是否读过|新不新/);
		expect(TOPIC_SYSTEM_PROMPT).toMatch(/领域名/);
	});

	it("S2 以词库为唯一映射目标", () => {
		expect(MAP_SYSTEM_PROMPT).toMatch(/词库/);
		expect(MAP_SYSTEM_PROMPT).toMatch(/原样/);
	});
});
