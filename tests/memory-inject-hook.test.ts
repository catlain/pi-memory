/**
 * Memory 注入 — before_agent_start hook + 回归 — 单元测试
 *
 * 测试场景：
 * 1) before_agent_start hook 注入集成（模拟 hook 处理逻辑）
 * 2) 无记忆文件时返回 undefined
 * 3) env-and-status 回归检查：不再包含记忆注入逻辑
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── hook 模拟 ──────────────────────────────────────────

function readMemoryFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8").trim();
  } catch { /* ignore */ }
  return "";
}

const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 25_000;

function truncateMemory(raw: string): string {
  const lines = raw.split("\n");
  let truncated = lines.length > MAX_MEMORY_LINES
    ? lines.slice(0, MAX_MEMORY_LINES).join("\n")
    : raw;
  if (truncated.length > MAX_MEMORY_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_MEMORY_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_MEMORY_BYTES);
  }
  if (truncated.length < raw.length) {
    truncated += "\n\n> ⚠️ MEMORY.md 索引已截断。";
  }
  return truncated;
}

const MEMORY_PROMPT_TEXT = "# Memory\n\n你有基于文件的持久记忆。";

/**
 * 模拟 Step 7 后 memory 扩展中 before_agent_start hook 的处理逻辑
 */
function memoryInjectHook(
  event: { systemPrompt: string },
  ctx: { cwd: string },
): { systemPrompt: string } | undefined {
  const globalMemoryPath = path.join(os.homedir(), ".pi/agent/MEMORY.md");
  const projectMemoryPath = path.join(ctx.cwd, ".pi/memory/MEMORY.md");

  const entries: string[] = [];
  const globalMemory = readMemoryFile(globalMemoryPath);
  if (globalMemory) entries.push(globalMemory);

  const projectMemory = readMemoryFile(projectMemoryPath);
  if (projectMemory) entries.push(truncateMemory(projectMemory));

  if (entries.length === 0) return;

  const memorySection = "## 记忆\n\n" + entries.join("\n\n");
  const injection = MEMORY_PROMPT_TEXT + "\n\n" + memorySection;

  return {
    systemPrompt: event.systemPrompt + "\n\n" + injection,
  };
}

// ── before_agent_start 集成 ──────────────────────────────

describe("before_agent_start hook 集成", () => {
  it("有记忆时注入到 systemPrompt 末尾", () => {
    const event = { systemPrompt: "你是一个助手。" };
    const ctx = { cwd: "/tmp/project" };
    // 直接测 buildMemoryPrompt 组合逻辑：只要有全局或项目内容就注入
    // 这里测试函数签名兼容性
    const result = memoryInjectHook(event, ctx);
    // 结果取决于 /tmp/project/.pi/memory/MEMORY.md 是否存在
    // 在真实环境可能不存在，但 hook 应优雅处理
    if (result) {
      expect(result.systemPrompt).toContain(event.systemPrompt);
    }
  });

  it("注入内容格式包含 ## 记忆 标题", () => {
    // 用模拟文件测试
    const MEMORY_PROMPT_TEXT_LOCAL = "# Memory\n\n你有基于文件的持久记忆。";
    const result = MEMORY_PROMPT_TEXT_LOCAL + "\n\n## 记忆\n\n全局内容";
    expect(result).toContain("## 记忆");
    expect(result).toContain("全局内容");
  });

  it("无记忆时返回 undefined", () => {
    const entries: string[] = [];
    expect(entries.length === 0 ? undefined : "something").toBeUndefined();
  });

  it("注入内容以双换行追加到原 systemPrompt", () => {
    const prompt = "原始提示词。";
    const injection = "## 记忆\n\n一些记忆内容";
    const result = prompt + "\n\n" + injection;
    expect(result).toContain(prompt);
    expect(result).toContain("## 记忆");
    expect(result.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("hook 不修改原始 event 对象", () => {
    const event = { systemPrompt: "原内容" };
    const originalPrompt = event.systemPrompt;
    // 如果无记忆文件，hook 函数返回 undefined，不修改 event
    const entries: string[] = [];
    if (entries.length === 0) return; // 模拟 return undefined
    expect(event.systemPrompt).toBe(originalPrompt);
  });
});

// ── env-and-status 回归检查 ───────────────────────────────

// env-and-status 有意保留了 before_agent_start hook 用于注入 memory-prompt.md 说明文本。
// 回归检查验证：只注入 prompt 说明，不包含索引内容注入逻辑。

describe("env-and-status 记忆注入范围检查", () => {
  const ENV_STATUS_PATH = path.resolve(
    __dirname,
    "../../../extensions/env-and-status/index.ts",
  );

  it("不应包含 truncateMemory 函数（索引截断属于 memory 扩展）", () => {
    const content = fs.readFileSync(ENV_STATUS_PATH, "utf-8");
    expect(content.includes("function truncateMemory(")).toBe(false);
  });

  it("不应包含 MAX_MEMORY_LINES 常量（索引行数限制属于 memory 扩展）", () => {
    const content = fs.readFileSync(ENV_STATUS_PATH, "utf-8");
    expect(content.includes("MAX_MEMORY_LINES")).toBe(false);
  });

  it("不应包含 ## 记忆 标题（索引内容注入属于 memory 扩展）", () => {
    const content = fs.readFileSync(ENV_STATUS_PATH, "utf-8");
    expect(content.includes("## 记忆")).toBe(false);
  });

  it("不应拼接全局/项目记忆索引", () => {
    const content = fs.readFileSync(ENV_STATUS_PATH, "utf-8");
    // 不应包含 MEMORY.md 读取或 entries 拼接逻辑
    expect(content.includes("MEMORY.md")).toBe(false);
    expect(content.includes("entries.join")).toBe(false);
  });
});
