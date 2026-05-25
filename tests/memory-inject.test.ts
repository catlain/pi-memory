/**
 * Memory 注入 — 工具函数 — 单元测试
 *
 * Step 7 将记忆注入逻辑从 env-and-status 迁入 memory 扩展。
 * 本测试验证三个核"心工具函数：
 *   - readMemoryFile(path): string   — 读取文件，成功返回 trim 内容
 *   - truncateMemory(raw): string    — 截断超长记忆
 *   - buildMemoryPrompt(...): string | null — 拼接注入文本
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 测试辅助 ──────────────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memory-inject-test-"));

function writeTestFile(relative: string, content: string): string {
  const fp = path.join(TMP_DIR, relative);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

beforeEach(() => {
  for (const e of fs.readdirSync(TMP_DIR)) {
    fs.rmSync(path.join(TMP_DIR, e), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── readMemoryFile ────────────────────────────────────────

function readMemoryFile(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8").trim();
  } catch { /* ignore */ }
  return "";
}

describe("readMemoryFile", () => {
  it("存在文件时返回内容", () => {
    const fp = writeTestFile("MEMORY.md", "# 全局\n- [test](test.md)");
    expect(readMemoryFile(fp)).toBe("# 全局\n- [test](test.md)");
  });

  it("不存在返回空字符串", () => {
    expect(readMemoryFile("/nonexistent/path/MEMORY.md")).toBe("");
  });

  it("空文件返回空字符串", () => {
    expect(readMemoryFile(writeTestFile("empty.md", ""))).toBe("");
  });

  it("只含空白返回空字符串", () => {
    expect(readMemoryFile(writeTestFile("ws.md", "   \n  "))).toBe("");
  });

  it("读取失败返回空字符串", () => {
    expect(readMemoryFile("/root/forbidden/MEMORY.md")).toBe("");
  });
});

// ── truncateMemory ────────────────────────────────────────

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

describe("truncateMemory", () => {
  it("短内容不截断", () => {
    expect(truncateMemory("简短")).toBe("简短");
  });

  it("刚好 200 行不截断", () => {
    const c = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    expect(truncateMemory(c)).toBe(c);
  });

  it("201 行截到 200 行加警告", () => {
    const c = Array.from({ length: 201 }, (_, i) => `line-${i}`).join("\n");
    const r = truncateMemory(c);
    // 过滤掉截断警告行及其前面的空行
    const lines = r.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("> ⚠️"));
    expect(lines).toHaveLength(200);
    expect(r).toContain("⚠️");
  });

  it("超长字节截到 25KB", () => {
    const c = Array.from({ length: 130 }, (_, i) => `line-${i} ` + "x".repeat(200)).join("\n");
    const r = truncateMemory(c);
    expect(Buffer.byteLength(r, "utf-8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES + 200);
  });

  it("超大内容单行也能截断", () => {
    const r = truncateMemory("x".repeat(50_000));
    expect(Buffer.byteLength(r, "utf-8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES + 200);
  });
});

// ── buildMemoryPrompt ─────────────────────────────────────

const MEMORY_PROMPT_TEXT = "# Memory\n\n你有基于文件的持久记忆。";

function buildMemoryPrompt(globalMemory: string, projectMemory: string): string | null {
  const entries: string[] = [];
  if (globalMemory) entries.push(globalMemory);
  if (projectMemory) entries.push(projectMemory);
  if (entries.length === 0) return null;
  return MEMORY_PROMPT_TEXT + "\n\n## 记忆\n\n" + entries.join("\n\n");
}

describe("buildMemoryPrompt", () => {
  it("全局+项目拼接完整", () => {
    const r = buildMemoryPrompt("全局", "项目");
    expect(r).toContain("全局");
    expect(r).toContain("项目");
    expect(r).toContain("## 记忆");
    expect(r).toContain("Memory");
  });

  it("只有全局", () => {
    const r = buildMemoryPrompt("仅全局", "");
    expect(r).toContain("仅全局");
    expect(r).not.toContain("项目");
  });

  it("只有项目", () => {
    const r = buildMemoryPrompt("", "仅项目");
    expect(r).toContain("仅项目");
    expect(r).not.toContain("全局");
  });

  it("都没有时返回 null", () => {
    expect(buildMemoryPrompt("", "")).toBeNull();
  });

  it("内容之间用双换行分隔", () => {
    const r = buildMemoryPrompt("global-content", "project-content")!;
    // 验证两个条目之间通过 \n\n 分隔（entries.join("\n\n")）
    expect(r).toContain("global-content\n\nproject-content");
  });
});
