/**
 * memory-routing 事件接线与命令注册。
 * 核心路由器见 routing.ts。
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryRouter, routingJudge, loadConfig, setRoutingConfig } from "./routing";

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");

function appendRunLog(line: string): void {
	try {
		mkdirSync(join(AGENT_DIR, "logs"), { recursive: true });
		appendFileSync(
			join(AGENT_DIR, "logs", "memory-routing.log"),
			`${new Date().toISOString()} ${line}\n`,
		);
	} catch {
		// 日志失败不影响主流程
	}
}

export function registerRouting(pi: ExtensionAPI): void {
	const router = new MemoryRouter(process.cwd());
	const pendingTools = new Map<string, unknown>();
	pi.on("message_end", async (event: unknown, ctx: unknown) => {
		if (ctx) routingJudge.setContext(ctx as never); // 事件回调是 ctx 权威来源（shepherd 模式）
		router.accumulate(event);
		await router.maybeTrigger(pi);
	});
	pi.on("tool_execution_start", (event: unknown) => {
		const { toolName, args, toolCallId } = event as {
			toolName?: string; args?: unknown; toolCallId?: string;
		};
		if (toolName === "read" && toolCallId) pendingTools.set(toolCallId, args);
	});
	pi.on("tool_result", (event: unknown) => {
		const { toolCallId, isError } = event as { toolCallId?: string; isError?: boolean };
		if (!toolCallId || !pendingTools.has(toolCallId)) return;
		const args = pendingTools.get(toolCallId);
		pendingTools.delete(toolCallId);
		if (!isError) router.recordRead("read", args, false);
	});
	pi.registerCommand("memory-routing", {
		handler: async (rawArgs: string, ctx) => {
			const sub = rawArgs.trim();
			const notify = (ctx as { ui?: { notify?: (t: string) => void } })?.ui?.notify;
			if (!notify) return;
			const cfg = loadConfig(process.cwd());
			if (/^\d+$/.test(sub)) {
				const n = Math.max(1, Math.min(20, Number(sub)));
				const updated = setRoutingConfig({ batchSize: n });
				router.setConfig({ batchSize: updated.batchSize });
				notify(`✅ memoryRouting.batchSize = ${updated.batchSize}（已持久化 settings.json，重启后保留）`);
			} else if (sub === "off" || sub === "on") {
				const updated = setRoutingConfig({ enabled: sub === "on" });
				router.setConfig({ enabled: updated.enabled });
				notify(`✅ memoryRouting.enabled = ${updated.enabled}（已持久化 settings.json，重启后保留）`);
			} else {
				notify(
					`memory-routing: enabled=${cfg.enabled} batchSize=${cfg.batchSize} ` +
						`includeSpecs=${cfg.includeSpecs}\n用法: /memory-routing [N|on|off]`,
				);
			}
		},
		description: "记忆按需路由配置. 用法: /memory-routing | /memory-routing <N|on|off>",
	});
	appendRunLog("routing registered");
}
