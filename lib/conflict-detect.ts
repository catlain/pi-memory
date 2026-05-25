/**
 * Memory 冲突检测 — 同目录中 topic 或关键词重叠检查
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFileName } from "@pi-atelier/shared-utils";

/** 检测同目录中与目标文件存在 topic 或关键词重叠的文件 */
export function detectConflicts(
	dir: string,
	newFileName: string,
	newParsed: ReturnType<typeof parseFileName>,
): Array<{ name: string; reason: string }> {
	const results: Array<{ name: string; reason: string }> = [];
	const newKeywords = new Set(newParsed.keywords);
	const newTopic = newParsed.topic;

	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".md") || f === "MEMORY.md" || f === newFileName) continue;
		const existing = parseFileName(f);
		if (!existing) continue;

		// 同 topic → 冲突
		if (existing.topic === newTopic) {
			const lines = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").length;
			results.push({ name: f, reason: `同topic, ${lines}行` });
			continue;
		}
		// 关键词重叠 ≥ 3 → 冲突
		const overlap = existing.keywords.filter((k: string) => newKeywords.has(k)).length;
		if (overlap >= 3) {
			const lines = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").length;
			results.push({ name: f, reason: `${overlap}关键词重叠, ${lines}行` });
		}
	}
	return results;
}
