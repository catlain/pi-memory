/**
 * Asset Catalog — 知识资产清单构建（记忆 L1/L2 + openspec specs）
 *
 * 供 routing 判定拼装清单用：每条资产 = 相对路径 + 一句话描述。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIR } from "./types";

export interface KnowledgeAsset {
	/** 展示/匹配路径（相对，如 memory/xxx.md 或 openspec/specs/yyy/spec.md） */
	entry: string;
	/** 一句话描述（关键词 or Purpose 首句） */
	desc: string;
	/** 显式词表（spec frontmatter `keywords: [a, b, c]` 解析产物；缺省走 entry 解析回退） */
	kws?: string[];
}

/** L1+L2 记忆条目：memory 目录扫描（MEMORY.md 索引文件本身除外） */
export function collectMemoryAssets(cwd: string): KnowledgeAsset[] {
	const assets: KnowledgeAsset[] = [];
	const sources: Array<[string, string]> = [
		["memory", path.join(AGENT_DIR, "memory")],
		[".pi/memory", path.join(cwd, ".pi", "memory")],
	];
	for (const [prefix, dir] of sources) {
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".md") || f === "MEMORY.md") continue;
				// desc = 文件名 kw 段（--kw1,kw2,kw3 → "kw1 / kw2 / kw3"）——零 IO、总有值
				const kwSeg = f.replace(/\.md$/, "").split("--")[1] ?? "";
				const desc = kwSeg.split(",").map(s => s.trim()).filter(Boolean).slice(0, 5).join(" / ");
				assets.push({ entry: `${prefix}/${f}`, desc });
			}
		} catch {
			// 目录不存在（L2 常见）：跳过
		}
	}
	return assets;
}

/** spec frontmatter 的 keywords 行解析：`keywords: [a, b, c]` 或 `keywords:\n  - a` → 词数组（无 frontmatter/无字段 → null，走 capability 回退） */
function parseSpecKeywords(text: string): string[] | null {
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return null;
	const inline = fm[1].match(/^keywords:\s*\[(.*)\]\s*$/m);
	if (inline) {
		return inline[1].split(",").map((s) => s.trim()).filter((s) => s.length >= 2).map((s) => s.toLowerCase());
	}
	const blockMatch = fm[1].match(/^keywords:\s*\n((?:\s+-\s+.+\n?)+)/m);
	if (blockMatch) {
		return blockMatch[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter((s) => s.length >= 2).map((s) => s.toLowerCase());
	}
	return null;
}

/** spec 清单：openspec/specs/<cap>/spec.md 的 keywords（frontmatter）+ Purpose 首句 */
export function collectSpecAssets(cwd: string): KnowledgeAsset[] {
	const specsDir = path.join(cwd, "openspec", "specs");
	const assets: KnowledgeAsset[] = [];
	try {
		for (const cap of fs.readdirSync(specsDir)) {
			const p = path.join(specsDir, cap, "spec.md");
			try {
				const text = fs.readFileSync(p, "utf8");
				const kws = parseSpecKeywords(text);
				const m = text.match(/^##\s*Purpose\s*\n+(.+)$/m);
				const purpose = m?.[1] ?? "";
				const firstSentence =
					purpose.split(/[。\n]/)[0]?.replace(/^#+\s*/, "").trim() ?? "";
				assets.push({
					entry: `openspec/specs/${cap}/spec.md`,
				desc: firstSentence.slice(0, 120),
					...(kws && { kws }),
				});
			} catch {
				// 单条读失败跳过
			}
		}
	} catch {
		// 无 specs 目录
	}
	return assets;
}
