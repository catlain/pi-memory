/**
 * Memory Tools — 文件写入与索引重建
 *
 * 索引（MEMORY.md）以磁盘文件为唯一真相源。
 * 每次 write 后全量重建索引，保证索引与磁盘始终一致。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scanMemoryDir } from "@pi-atelier/shared-utils";
import { MAX_FILE_LINES } from "./types";

/**
 * 全量重建 MEMORY.md 索引
 *
 * 扫描 targetDir 下所有 .md 文件（排除 MEMORY.md 自身），
 * 生成 表格 + 链接区，覆盖写入 indexPath。
 *
 * 这是保证「索引 === 磁盘」的唯一函数。
 */
export function rebuildIndex(targetDir: string, indexPath: string, scope: "L1" | "L2"): void {
	const entries = scanMemoryDir(targetDir, scope);

	if (entries.length === 0) {
		// 没有记忆文件时，写一个空索引（或删除索引）
		if (fs.existsSync(indexPath)) {
			fs.writeFileSync(indexPath, "", "utf-8");
		}
		return;
	}

	const lines: string[] = [
		"# Memory Index",
		"",
		"> 自动生成 — 列出所有记忆文件及其关键词摘要",
		"",
		`## 文件清单 (${entries.length})`,
		"",
		"| # | 文件 | 关键词 |",
		"|---|------|--------|",
	];

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const kws = e.keywords.join(", ") || "";
		lines.push(`| ${i + 1} | ${e.topic} | ${kws} |`);
	}

	lines.push("");

	for (const e of entries) {
		lines.push(`- [${e.topic}](${e.file})`);
	}

	lines.push(""); // trailing newline

	fs.mkdirSync(path.dirname(indexPath), { recursive: true });
	fs.writeFileSync(indexPath, lines.join("\n"), "utf-8");
}

/** 检查文件行数是否超限，返回警告或 null */
export function checkLineCount(filePath: string): string | null {
	if (!fs.existsSync(filePath)) return null;
	const lines = fs.readFileSync(filePath, "utf-8").split("\n").length;
	if (lines > MAX_FILE_LINES) {
		return `⚠️ ${filePath} 超过 ${MAX_FILE_LINES} 行（当前 ${lines} 行），请拆分`;
	}
	return null;
}
