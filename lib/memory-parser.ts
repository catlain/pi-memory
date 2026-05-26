/**
 * Memory Parser — 共享的记忆文件名解析与目录扫描
 *
 * 文件名格式：topic--kw1,kw2,kw3,kw4,kw5.md
 *   -- 分隔 topic 和关键词
 *   ,  分隔关键词
 *
 * 被 memory 扩展和 smart-context 扩展共同使用。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── 类型定义 ─────────────────────────────────────────────

export interface MemoryEntry {
	name: string;
	file: string;
	description: string;
	lines: number;
	scope: "L1" | "L2";
	topic: string;
	keywords: string[];
}

// ── 文件名解析 ───────────────────────────────────────────

/** 从文件名解析 topic 和 keywords
 *
 * 格式：topic--kw1,kw2,kw3.md
 * 无 -- 时 topic = basename（兼容旧格式）
 */
export function parseFileName(fileName: string): { topic: string; keywords: string[] } {
	if (fileName == null) return { topic: "", keywords: [] };
	const base = fileName.replace(/\.md$/, "");
	const idx = base.indexOf("--");
	if (idx === -1) {
		return { topic: base, keywords: [] };
	}
	const topic = base.substring(0, idx);
	const kwStr = base.substring(idx + 2);
	const keywords = kwStr ? kwStr.split(",") : [];
	return { topic, keywords };
}

/** 生成文件名：topic--kw1,kw2,...md */
export function buildFileName(topic: string, keywords: string[]): string {
	const kwPart = keywords.length > 0 ? keywords.join(",") : "";
	const base = kwPart ? `${topic}--${kwPart}` : topic;
	return `${base}.md`;
}

// ── 目录扫描 ─────────────────────────────────────────────

/** 扫描目录下的记忆文件，从文件名解析 topic + keywords */
export function scanMemoryDir(dir: string, scope: "L1" | "L2"): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	if (!fs.existsSync(dir)) return entries;

	const files = fs.readdirSync(dir)
		.filter(f => f.endsWith(".md") && f !== "MEMORY.md")
		.sort();

	for (const file of files) {
		const filePath = path.join(dir, file);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n").length;
			const titleLine = content.split("\n").find(l => l.startsWith("# "));
			const description = titleLine?.replace(/^#\s+/, "") || "";
			const parsed = parseFileName(file);
			entries.push({
				name: file.replace(".md", ""),
				file,
				description,
				lines,
				scope,
				topic: parsed.topic,
				keywords: parsed.keywords,
			});
		} catch {
			entries.push({
				name: file.replace(".md", ""),
				file,
				description: "(读取失败)",
				lines: 0,
				scope,
				topic: parseFileName(file).topic,
				keywords: parseFileName(file).keywords,
			});
		}
	}

	return entries;
}
