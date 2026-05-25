# pi-memory

为 [pi](https://github.com/earendil-works/pi-coding-agent) 提供跨会话持久记忆。

AI agent 的每次对话都是全新开始——不记得昨天讨论了什么、踩过哪些坑、做过什么决策。pi-memory 用文件系统解决这个问题：让 agent 自动维护一个知识库，每次新会话自动加载。

## 工作原理

```
新会话启动
  └─► 自动注入 MEMORY.md 索引到 system prompt
       │
       ▼
Agent 需要记忆 → 调用 memory_index 查看已有
Agent 学到新东西 → 调用 memory_update 写入
  └─► 自动重建索引，下次会话可见
```

**核心机制**：
- **文件即记忆**：每个 Markdown 文件是一条独立的知识记录
- **自动索引**：每次写入后自动重建 `MEMORY.md` 索引，下次会话自动注入
- **冲突检测**：写入时自动检查同主题/高关键词重叠的已有文件，防止碎片化
- **两级存储**：全局记忆（跨项目通用知识）+ 项目记忆（架构决策、踩坑记录）

## 安装

```bash
pi install git:github.com/catlain/pi-memory
```

重启 pi 即可使用。无需额外配置。

> **前提**：已安装 [pi](https://github.com/earendil-works/pi-coding-agent)。

## 提供的工具

### `memory_index` — 查看记忆清单

扫描记忆目录，返回结构化索引表格。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scope | `"all"` / `"L1"` / `"L2"` | 否 | 扫描范围，默认 `all` |

**Agent 什么时候用**：
- 想了解已有记忆内容
- 写入前检查是否已存在相关记忆
- 决定是否需要新建或合并

**输出示例**：
```
# 记忆文件索引

## L1 — ~/.pi/agent/memory

| topic | keywords | 行数 | 描述 |
|-------|----------|------|------|
| coding_standards | 编码, git, lint, 格式 | 45 | 编码规范和文件格式要求 |
| debug_anti_pattern | uvicorn, 缓存, 代码加载 | 32 | 常见调试误区 |

## L2 — /project/.pi/memory

| topic | keywords | 行数 | 描述 |
|-------|----------|------|------|
| 数据模型 | DuckDB, 因子, 增量 | 28 | 因子数据存储方案 |
```

### `memory_update` — 写入/更新记忆

写入 Markdown 文件并自动重建索引。包含完整的安全检查链。

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fileName | string | 是 | 文件名，格式 `topic--kw1,kw2,kw3.md` |
| content | string | 是 | 完整的记忆文件内容（Markdown） |
| scope | `"L1"` / `"L2"` | 否 | 目标作用域，默认 `L2` |

**安全检查**（按顺序执行，任一失败则拒绝写入）：
1. ✏️ 文件名不含路径分隔符（防路径遍历）
2. 📏 内容 ≤ 50KB
3. 📏 内容 ≤ 200 行
4. 📁 记忆文件总数 ≤ 40（硬限制）
5. 🔍 无同主题或 ≥3 关键词重叠的已有文件（冲突检测）

**Agent 写入流程**（工具描述中已引导）：
```
1. 调 memory_index 查看已有文件
2. 判断：新建？覆盖？合并？
3. 确认文件名格式正确
4. 调 memory_update 写入
```

**冲突时的处理方法**（工具会返回具体冲突文件列表）：
- **合并**：读取所有冲突文件 → 整合为一份 → 用已有文件名覆盖 → 删除其余
- **取代**：新内容完全覆盖旧结论 → 用冲突文件的文件名写入
- **确认不相关**：调整 topic 或关键词使重叠 < 3，再重试

## 文件格式

### 文件命名

```
topic--kw1,kw2,kw3,kw4,kw5.md
```

| 部分 | 说明 | 示例 |
|------|------|------|
| topic | 英文短标识，代表记忆主题 | `coding_standards` |
| kw1~kw5 | 最多 5 个关键词，逗号分隔 | `编码,git,lint,格式` |

**示例**：
- `debug_anti_pattern--uvicorn,缓存,代码加载,误判.md`
- `数据模型--DuckDB,因子,增量.md`
- `coding_standards--编码,git,lint,格式,Karpathy.md`

### 文件内容

Markdown 格式，标题即主题描述：

```markdown
# 编码规范与文件格式

关键词: 编码 git lint 格式

## 核心规则
- 每个 PR 只做一件事
- 提交前必须 lint
- ...

## 踩坑记录
- ...
```

### 索引文件

`MEMORY.md` 由工具自动维护，不需要手动编辑。格式：

```markdown
# Memory Index

> 自动生成 — 列出所有记忆文件及其关键词摘要

## 文件清单 (3)

| # | 文件 | 关键词 |
|---|------|--------|
| 1 | coding_standards | 编码, git, lint |
| 2 | debug_anti_pattern | uvicorn, 缓存 |

- [coding_standards](coding_standards--编码,git,lint.md)
- [debug_anti_pattern](debug_anti_pattern--uvicorn,缓存.md)
```

## 两级存储

| 级别 | 路径 | 用途 | 示例 |
|------|------|------|------|
| **L1 全局** | `~/.pi/agent/memory/` | 跨项目通用知识 | 工具链配置、编码纪律、通用踩坑 |
| **L2 项目** | `<project>/.pi/memory/` | 项目特定知识 | 架构决策、数据模型、项目约定 |

- L1 在所有项目中可见
- L2 只在对应项目目录下可见
- 两级的索引独立维护

## 自动注入

每次新会话启动时，`before_agent_start` hook 会自动将 `MEMORY.md` 索引注入到 system prompt 中。Agent 看到索引后，可以用 `read` 工具读取具体文件内容。

注入有限制：
- 最大 200 行
- 最大 25KB
- 超出时自动截断并提示

## 限制

| 限制 | 值 | 说明 |
|------|---|------|
| 单文件行数上限 | 200 行 | 超出拒绝写入，需拆分 |
| 单文件大小上限 | 50 KB | 超出拒绝写入 |
| 文件总数硬限制 | 40 个 | 超出拒绝写入，需清理合并 |
| 文件总数软限制 | 25 个 | 超出发出警告 |
| 关键词上限 | 5 个 | 每个文件最多 5 个关键词 |
| 冲突检测阈值 | 3 个关键词重叠 | 同 topic 或 ≥3 关键词重叠触发冲突 |

## 最佳实践

### ✅ 应该记住的
- 踩过的坑和解决方案
- 架构决策和原因
- 项目特有的约定和规则
- 工具链配置经验
- 调试误区和反模式

### ❌ 不应该记住的
- 临时信息（当前 bug 状态、正在处理的任务）
- 可以从代码中直接读取的信息
- 频繁变化的信息（版本号、具体行数）

### 🧹 定期清理
- 记忆超过 25 个时，主动合并相关主题
- 过时结论被新文件取代时，删除旧文件
- 超过 200 行的文件按子主题拆分

## 架构

```
extensions/memory/
├── index.ts                 # 入口：注册工具 + before_agent_start hook
├── memory-prompt.md         # 注入说明文本（告诉 AI 怎么用记忆）
├── lib/
│   ├── types.ts             # 常量（目录路径、限制阈值）
│   ├── memory-hook.ts       # before_agent_start hook 注册
│   ├── memory-inject.ts     # 读取 MEMORY.md → 生成注入文本
│   ├── writer.ts            # 文件写入 + 索引重建
│   └── conflict-detect.ts   # 同主题/关键词重叠检测
├── prompts/
│   └── update-description.md  # memory_update 工具的完整描述（含写入流程）
└── package.json
```

**依赖**：
- `@pi-atelier/shared-utils` — `scanMemoryDir`、`parseFileName`（文件名解析和目录扫描）
- `@earendil-works/pi-coding-agent` — ExtensionAPI
- 无其他依赖

## 许可证

MIT
