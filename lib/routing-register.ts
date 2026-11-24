/**
 * routing 扩展接线：事件钩子（message_end/tool_execution_start/tool_result）+ 命令注册
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryRouter, loadConfig, setRoutingConfig } from "./routing";

export function registerRouting(pi: ExtensionAPI): void {
	const cfg = loadConfig(process.cwd());
	const router = new MemoryRouter(process.cwd(), cfg);
	const pendingTools = new Map<string, { toolName: string; args: unknown }>();

	pi.on("message_end", async (event: unknown, ctx: unknown) => {
		router.accumulate(event as { message?: { content?: unknown } });
		void router.maybeTrigger(pi);
	});

	pi.on("tool_execution_start", (event: unknown) => {
		const { toolName, args, toolCallId } = event as { toolName?: string; args?: unknown; toolCallId?: string };
		if (toolName && toolCallId) pendingTools.set(toolCallId, { toolName, args });
	});

	pi.on("tool_result", (event: unknown) => {
		const { toolCallId, isError, result } = event as { toolCallId?: string; isError?: boolean; result?: unknown };
		const rec = toolCallId ? pendingTools.get(toolCallId) : undefined;
		if (!rec) return;
		pendingTools.delete(toolCallId!);
		router.observeToolResult(rec.toolName, rec.args, isError === true, result);
		router.readTracker.recordRead(rec.toolName ?? "", rec.args, isError === true);
	});

	pi.registerCommand("memory-routing", {
		handler: async (rawArgs: string, ctx: unknown) => {
			const notify = (text: string) => (ctx as { ui?: { notify?: (t: string, l?: string) => void } }).ui?.notify?.(text, "info");
			const sub = rawArgs.trim();
			if (sub === "" || sub === "status") {
				const c = router.config;
				notify(`memoryRouting: enabled=${c.enabled} batchChars=${c.batchChars} includeSpecs=${c.includeSpecs}\n用法: /memory-routing [N|on|off]（N=字符阈值）`);
				return;
			}
			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				const updated = setRoutingConfig({ enabled });
				router.setConfig(updated);
				notify(`✅ memoryRouting.enabled = ${updated.enabled}（已持久化 settings.json）`);
				return;
			}
			const n = Number.parseInt(sub, 10);
			if (Number.isFinite(n) && n >= 200 && n <= 20000) {
				const updated = setRoutingConfig({ batchChars: n });
				router.config = updated;
				notify(`✅ memoryRouting.batchChars = ${updated.batchChars}（已持久化 settings.json）`);
				return;
			}
			notify(`无效参数「${sub}」：N（200-20000 字符阈值）| on | off | status`);
		},
		description: "记忆路由：查看/设置字符阈值与开关",
	});
}
