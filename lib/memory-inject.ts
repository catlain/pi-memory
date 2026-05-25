/**
 * Memory 注入 — 读取 MEMORY.md 索引并拼接为 systemPrompt 注入文本
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIR } from "./types";

// ── 注入截断常量 ─────────────────────────────────────────

/** 注入索引的最大行数 */
const MAX_MEMORY_LINES = 200;

/** 注入索引的最大字节数 */
const MAX_MEMORY_BYTES = 25_000;

// ── 工具函数 ─────────────────────────────────────────────

/** 读取文件，成功返回 trim 内容，否则空字符串 */
export function readMemoryFile(filePath: string): string {
	try {
		if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8").trim();
	} catch {
		/* ignore */
	}
	return "";
}

/** 截断超长记忆索引 */
export function truncateMemory(raw: string): string {
	const lines = raw.split("\n");
	let truncated =
		lines.length > MAX_MEMORY_LINES
			? lines.slice(0, MAX_MEMORY_LINES).join("\n")
			: raw;
	if (truncated.length > MAX_MEMORY_BYTES) {
		const cutAt = truncated.lastIndexOf("\n", MAX_MEMORY_BYTES);
		truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_MEMORY_BYTES);
	}
	if (truncated.length < raw.length) {
		truncated += "\n\n> ⚠️ MEMORY.md 索引已截断。";
	}
	return truncated;
}

/**
 * 拼接记忆注入文本。
 * @returns 完整的注入文本，或 null（无记忆时）
 */
export function buildMemoryPrompt(
	globalMemory: string,
	projectMemory: string,
): string | null {
	const entries: string[] = [];
	if (globalMemory) entries.push(globalMemory);
	if (projectMemory) entries.push(projectMemory);
	if (entries.length === 0) return null;
	return "## 记忆\n\n" + entries.join("\n\n");
}

/**
 * 读取 L1/L2 的 MEMORY.md 索引，返回注入文本。
 * 供 before_agent_start hook 调用。
 */
export function resolveMemoryInjection(cwd: string): string | null {
	const l1Path = path.join(AGENT_DIR, "MEMORY.md");
	const l2Path = path.join(cwd, ".pi", "memory", "MEMORY.md");

	const globalMemory = readMemoryFile(l1Path);
	const projectMemory = truncateMemory(readMemoryFile(l2Path));

	return buildMemoryPrompt(globalMemory, projectMemory);
}
