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
				assets.push({ entry: `${prefix}/${f}`, desc: "" });
			}
		} catch {
			// 目录不存在（L2 常见）：跳过
		}
	}
	return assets;
}

/** spec 清单：openspec/specs/<cap>/spec.md 的 capability + Purpose 首句 */
export function collectSpecAssets(cwd: string): KnowledgeAsset[] {
	const specsDir = path.join(cwd, "openspec", "specs");
	const assets: KnowledgeAsset[] = [];
	try {
		for (const cap of fs.readdirSync(specsDir)) {
			const p = path.join(specsDir, cap, "spec.md");
			try {
				const text = fs.readFileSync(p, "utf8");
				const m = text.match(/^##\s*Purpose\s*\n+(.+)$/m);
				const purpose = m?.[1] ?? "";
				const firstSentence =
					purpose.split(/[。\n]/)[0]?.replace(/^#+\s*/, "").trim() ?? "";
				assets.push({
					entry: `openspec/specs/${cap}/spec.md`,
					desc: firstSentence.slice(0, 120),
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
