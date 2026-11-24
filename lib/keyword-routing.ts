import type { KnowledgeAsset } from "./asset-catalog";

/** 资产元数据词表：记忆文件名 kw 段 / spec capability 名 */
export function kwOf(asset: KnowledgeAsset): string[] {
	if (asset.entry.startsWith("openspec/")) {
		const cap = asset.entry.split("/")[2] ?? "";
		return cap ? [cap.toLowerCase()] : [];
	}
	const stem = asset.entry.split("/").pop() ?? "";
	const kwPart = stem.replace(/\.md$/, "").split("--")[1] ?? "";
	return kwPart.split(",").map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);
}

/** 词库构建：全部资产词表去重（按长度降序，进判定 question，纯受限选择） */
export function buildVocabulary(assets: KnowledgeAsset[]): string[] {
	const s = new Set<string>();
	for (const a of assets) for (const k of kwOf(a)) s.add(k);
	return [...s].sort((x, y) => y.length - x.length);
}

/** 判定输出解析：词级容错（分隔符拆分 + 短词过滤），返回 null=判定作废 */
export function parseKeywords(raw: string): string[] | null {
	const lines = raw.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 1 && /^(无|none|n\/a)$/i.test(lines[0])) return [];
	const out: string[] = [];
	for (const line of lines) {
		const toks = line.split(/[\s,，、;；|]+/).filter((t) => t.length >= 2 && t.length <= 40);
		for (const t of toks.slice(0, 3)) if (!out.includes(t)) out.push(t);
	}
	return out.length ? out.slice(0, 5) : null;
}

/** 纯倒排匹配：选中词 ∈ 资产词表即命中（无自创兜底，desc 不参与匹配） */
export function matchAssets(keywords: string[], assets: KnowledgeAsset[]): KnowledgeAsset[] {
	const kws = keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);
	const hits: KnowledgeAsset[] = [];
	for (const a of assets) {
		if (kwOf(a).some((k) => kws.includes(k)) && !hits.some((h) => h.entry === a.entry)) hits.push(a);
	}
	return hits;
}

/** v3.4 注入文本四要素：判定依据（主题词）+ 完整路径（L1/L2 前缀消歧）+ desc + 行动指引 */
export function buildHintText(
	candidates: KnowledgeAsset[],
	keywords: string[],
	cwd: string,
): { text: string; short: string } {
	const lines = candidates
		.map((a) => {
			const full = a.entry.startsWith("memory/") ? `~/.pi/agent/${a.entry}` : `${cwd}/${a.entry}`;
			return `- ${full}（${a.desc.slice(0, 60) || "关键词见文件名"}）`;
		})
		.join("\n");
	const stems = candidates.map((a) => (a.entry.split("/").pop() ?? "").split("--")[0]).join("、");
	const theme = keywords.slice(0, 3).join("·");
	return {
		text:
			`💡 记忆路由：从你近期的工作记录（叙述/工具操作/报错）中识别出主题「${theme}」，` +
			`以下未读知识资产与之匹配（本会话内不会重复提示）：\n${lines}\n若与当前任务相关请 read；无关则忽略即可。`,
		short: `💡 记忆路由（${theme}）：${stems}`,
	};
}
