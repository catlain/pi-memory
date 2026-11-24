/**
 * SDK 消息形态解析公共层（1.4.3 教训：同一数据的防御解析出现多处时必须收敛到一处）
 * content 形态矩阵：string（UserMessage）/ 数组（Assistant|ToolResultMessage 的 text|toolCall|thinking|image 块）/ null
 */

export function contentBlocksOf(event: unknown): Array<{ type?: string }> {
	const c = (event as { message?: { content?: unknown } } | undefined)?.message?.content;
	return Array.isArray(c) ? (c as Array<{ type?: string }>) : [];
}

export function roleOf(event: unknown): string | undefined {
	return (event as { message?: { role?: string } } | undefined)?.message?.role;
}
