/**
 * Memory 注入 — before_agent_start hook 注册
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { resolveMemoryInjection } from "./memory-inject";

/**
 * 注册 before_agent_start hook：
 * 1. 注入 memory-prompt.md 说明文本
 * 2. 注入 L1/L2 MEMORY.md 索引内容
 */
export function registerMemoryHook(pi: ExtensionAPI): void {
	const memoryPromptPath = path.join(__dirname, "..", "memory-prompt.md");
	let memoryPrompt = "";
	try {
		if (fs.existsSync(memoryPromptPath)) {
			memoryPrompt = fs.readFileSync(memoryPromptPath, "utf-8").trim();
		}
	} catch { // 文件不存在或权限异常 → 跳过注入
		/* ignore */
	}

	if (!memoryPrompt) return;

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult> => {
		const cwd = event.systemPromptOptions?.cwd || process.cwd();
		const injection = resolveMemoryInjection(cwd);
		const parts = [memoryPrompt];
		if (injection) parts.push(injection);
		return {
			systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n"),
		};
	});
}
