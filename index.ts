/**
 * Memory Tools — 记忆索引查询 + 写入
 *
 * 提供两个工具供 AI 主动调用：
 *   - memory_index:  扫描记忆目录，返回结构化清单（从文件名解析 topic + keywords）
 *   - memory_update: 写文件 + 更新 MEMORY.md 索引（去重由 AI 判断）
 *
 * 记忆架构：
 *   L1  ~/.pi/agent/MEMORY.md + memory/*.md   ← 跨项目通用
 *   L2  {project}/.pi/memory/MEMORY.md + *.md ← 项目主题
 *
 * 文件名格式：topic--kw1,kw2,kw3,kw4,kw5.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIR, MAX_FILE_LINES, HARD_FILE_LIMIT, SOFT_FILE_LIMIT, HINT_FILE_LIMIT } from "./lib/types";
import { scanMemoryDir, parseFileName, type MemoryEntry } from "@pi-atelier/shared-utils";
import { rebuildIndex } from "./lib/writer";
import { registerMemoryHook } from "./lib/memory-hook";
import { detectConflicts } from "./lib/conflict-detect";

export default function memoryToolsExtension(pi: ExtensionAPI) {

  // ── before_agent_start: 注入记忆说明 + 索引到 systemPrompt ──
  registerMemoryHook(pi);

  // ── memory_index: 查询记忆清单 ──────────────────────
  pi.registerTool({
    name: "memory_index",
    label: "Memory Index",
    description: [
      "扫描并返回所有记忆文件的索引清单（L1 全局 + L2 项目）。",
      "从文件名解析 topic 和关键词，返回结构化表格。",
      "用于：了解已有记忆、判断重复、决定是否新建文件。",
    ].join("\n"),
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("L1"),
        Type.Literal("L2"),
      ], { description: "扫描范围：all=全部，L1=全局，L2=项目。默认 all。", default: "all" })),
    }),
    async execute(toolCallId, params: { scope?: "all" | "L1" | "L2" }, signal, onUpdate, ctx) {
      const cwd = (ctx as any).cwd || process.cwd();
      const l1Dir = path.join(AGENT_DIR, "memory");
      const l2Dir = path.join(cwd, ".pi", "memory");
      const entries: MemoryEntry[] = [];

      if ((params.scope || "all") !== "L2") {
        entries.push(...scanMemoryDir(l1Dir, "L1"));
        // 顺便重建索引，修复手动删文件后的不一致
        const l1IndexPath = path.join(AGENT_DIR, "MEMORY.md");
        if (fs.existsSync(l1Dir)) rebuildIndex(l1Dir, l1IndexPath, "L1");
      }
      if ((params.scope || "all") !== "L1") {
        entries.push(...scanMemoryDir(l2Dir, "L2"));
        // 顺便重建索引，修复手动删文件后的不一致
        const l2IndexPath = path.join(cwd, ".pi", "memory", "MEMORY.md");
        if (fs.existsSync(l2Dir)) rebuildIndex(l2Dir, l2IndexPath, "L2");
      }

      if (entries.length === 0) {
        return { content: [{ type: "text", text: "未找到任何记忆文件。" }], details: {} };
      }

      entries.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === "L1" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const lines: string[] = ["# 记忆文件索引\n"];
      let currentScope = "";
      for (const e of entries) {
        if (e.scope !== currentScope) {
          currentScope = e.scope;
          const scopeDir = e.scope === "L1" ? l1Dir : l2Dir;
          lines.push(`\n## ${e.scope} — ${scopeDir}\n`);
          lines.push("| topic | keywords | 行数 | 描述 |");
          lines.push("|-------|----------|------|------|");
        }
        const topic = e.topic || e.name;
        const kws = e.keywords.join(", ") || "";
        const lineWarning = e.lines > MAX_FILE_LINES ? " ⚠️" : "";
        lines.push(`| ${topic} | ${kws} | ${e.lines}${lineWarning} | ${e.description} |`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  // ── memory_update: 写文件 + 更新索引 ─────────────────
  // AI 负责：看 memory_index → 判断重复 → 决定文件名 → 调用本工具
  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description: fs.readFileSync(
      path.join(__dirname, "prompts", "update-description.md"), "utf-8"
    ).trim(),
    parameters: Type.Object({
      fileName: Type.String({ description: "目标文件名，格式 topic--kw1,kw2,kw3.md" }),
      content: Type.String({ description: "完整的记忆文件内容（markdown）" }),
      scope: Type.Optional(Type.Union([
        Type.Literal("L1"),
        Type.Literal("L2"),
      ], { description: "目标作用域。默认 L2。", default: "L2" })),
    }),
    async execute(toolCallId, params: { fileName: string; content: string; scope?: "L1" | "L2" }, signal, onUpdate, ctx) {
      const cwd = (ctx as any).cwd || process.cwd();
      const effectiveScope: "L1" | "L2" = params.scope === "L1" ? "L1" : "L2";
      const targetDir = effectiveScope === "L1"
        ? path.join(AGENT_DIR, "memory")
        : path.join(cwd, ".pi", "memory");
      const indexPath = effectiveScope === "L1"
        ? path.join(AGENT_DIR, "MEMORY.md")
        : path.join(cwd, ".pi", "memory", "MEMORY.md");

      fs.mkdirSync(targetDir, { recursive: true });

      // 安全检查：只允许 .md 文件，不允许路径遍历
      const fileName = params.fileName.replace(/\.md$/, "") + ".md";
      if (fileName.includes("/") || fileName.includes("\\")) {
        return { content: [{ type: "text", text: "❌ 文件名不允许包含路径分隔符" }], details: {} };
      }

      const filePath = path.join(targetDir, fileName);
      const parsed = parseFileName(fileName);
      const isOverwrite = fs.existsSync(filePath);
      const contentBytes = Buffer.byteLength(params.content, "utf-8");
      const MAX_CONTENT_BYTES = 50_000; // 50KB
      if (contentBytes > MAX_CONTENT_BYTES) {
        return { content: [{ type: "text", text: `❌ 内容 ${(contentBytes / 1024).toFixed(1)}KB 超过 ${MAX_CONTENT_BYTES / 1000}KB 限制` }], details: {} };
      }
      const contentLines = params.content.split("\n").length;

      // 行数硬限制
      if (contentLines > MAX_FILE_LINES) {
        return { content: [{ type: "text", text: `❌ 内容 ${contentLines} 行，超过 ${MAX_FILE_LINES} 行硬限制，请精简或拆分后重试` }], details: {} };
      }

      // 记忆总数硬限制 — 先检查再写
      const totalFiles = fs.existsSync(targetDir)
        ? fs.readdirSync(targetDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md").length
        : 0;
      // 覆盖已有文件不增加总数，不算超标
      const effectiveTotal = isOverwrite ? totalFiles : totalFiles + 1;
      if (effectiveTotal > HARD_FILE_LIMIT) {
        return {
          content: [{ type: "text", text: `❌ ${effectiveScope} 记忆文件已达 ${totalFiles} 个（硬限制 ${HARD_FILE_LIMIT}），拒绝写入。请先用 memory_index 查看，合并/删除后重试。` }],
          details: {},
        };
      }

      // 写入前检测冲突：同 topic 或高关键词重叠 → 硬拒绝
      if (fs.existsSync(targetDir)) {
        const conflicts = detectConflicts(targetDir, fileName, parsed);
        if (conflicts.length > 0) {
          const conflictList = conflicts.map(c => `  - ${c.name} (${c.reason})`).join("\n");
          return {
            content: [{ type: "text", text: [
              `❌ 检测到相关记忆，拒绝写入。请先处理冲突：`,
              ``,
              conflictList,
              ``,
              `处理方法（按优先级）：`,
              `1. 合并：内容互补 → 读取所有冲突文件 → 整合为一份 → 用 memory_update 覆盖其中一个的文件名 → 删除其余文件`,
              `2. 取代：新内容完全覆盖旧结论 → 改用冲突文件的文件名写入（覆盖），不要新建`,
              `3. 确认不相关 → 在 fileName 中调整 topic 或关键词使重叠 < 3，再重试`,
              ``,
              `⚠️ 不允许无视此提示。必须处理冲突后才能写入。`,
            ].join("\n") }],
            details: {},
          };
        }
      }

      // 所有检查通过，写入文件
      fs.writeFileSync(filePath, params.content, "utf-8");
      // 全量重建索引，保证索引 === 磁盘
      rebuildIndex(targetDir, indexPath, effectiveScope);

      // 成功消息
      const action = isOverwrite ? "覆盖" : "新建";
      const totalWarning = totalFiles > SOFT_FILE_LIMIT
        ? `\n⚠️ ${effectiveScope} 记忆文件 ${totalFiles} 个，接近 ${HARD_FILE_LIMIT} 硬限制，请尽快清理合并`
        : totalFiles > HINT_FILE_LIMIT
          ? `\n💡 ${effectiveScope} 记忆文件 ${totalFiles} 个，注意控制数量`
          : "";

      return {
        content: [{ type: "text", text: `✅ ${action}: ${fileName} (${contentLines} 行)${totalWarning}` }],
        details: {},
      };
    },
  });
}
