[中文文档](README.md) | English

# pi-memory

Persistent cross-session memory for [pi](https://github.com/earendil-works/pi-coding-agent).

Every AI agent conversation starts from scratch — it doesn't remember what was discussed yesterday, what pitfalls were hit, or what decisions were made. pi-memory solves this using the filesystem: it lets the agent maintain a knowledge base automatically, and loads it into every new session without manual intervention.

## How It Works

```
New session starts
  └─► MEMORY.md index is automatically injected into system prompt
       │
       ▼
Agent needs to recall → calls memory_index to check existing entries
Agent learns something new → calls memory_update to write it down
  └─► Index is rebuilt automatically, visible in next session
```

**Core mechanisms**:
- **Files as memory**: Each Markdown file is an independent knowledge record
- **Auto-indexing**: The `MEMORY.md` index is rebuilt after every write, automatically injected into the next session
- **Conflict detection**: Before writing, checks for existing files with the same topic or ≥3 overlapping keywords to prevent fragmentation
- **Two-tier storage**: Global memory (cross-project knowledge) + Project memory (architectural decisions, pitfalls)

## Installation

```bash
pi install git:github.com/catlain/pi-memory
```

Restart pi and you're good to go. No additional configuration needed.

> **Prerequisite**: [pi](https://github.com/earendil-works/pi-coding-agent) must be installed.

## Provided Tools

### `memory_index` — View Memory Inventory

Scans the memory directories and returns a structured index table.

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| scope | `"all"` / `"L1"` / `"L2"` | No | Scan scope, defaults to `all` |

**When the agent should use this**:
- To browse existing memory contents
- To check whether a topic already has a memory file before writing
- To decide whether to create a new file or merge into an existing one

**Example output**:
```
# Memory Index

## L1 — ~/.pi/agent/memory

| topic | keywords | lines | description |
|-------|----------|-------|-------------|
| coding_standards | coding, git, lint, format | 45 | Coding standards and file formatting rules |
| debug_anti_pattern | uvicorn, cache, code loading | 32 | Common debugging pitfalls |

## L2 — /project/.pi/memory

| topic | keywords | lines | description |
|-------|----------|-------|-------------|
| data_model | DuckDB, factor, incremental | 28 | Factor data storage design |
```

### `memory_update` — Write/Update Memory

Writes a Markdown file and rebuilds the index. Includes a full safety check chain.

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| fileName | string | Yes | File name, format `topic--kw1,kw2,kw3.md` |
| content | string | Yes | Full memory file content (Markdown) |
| scope | `"L1"` / `"L2"` | No | Target scope, defaults to `L2` |

**Safety checks** (executed in order; any failure rejects the write):
1. ✏️ File name does not contain path separators (prevents path traversal)
2. 📏 Content ≤ 50KB
3. 📏 Content ≤ 200 lines
4. 📁 Total memory files ≤ 40 (hard limit)
5. 🔍 No existing file with same topic or ≥3 overlapping keywords (conflict detection)

**Agent write workflow** (guided by the tool description):
```
1. Call memory_index to inspect existing files
2. Decide: create new? overwrite? merge?
3. Confirm the file name format is correct
4. Call memory_update to write
```

**Handling conflicts** (the tool returns the list of conflicting files):
- **Merge**: Read all conflicting files → consolidate into one → overwrite with an existing file name → delete the rest
- **Replace**: New content fully supersedes old conclusions → write using the conflicting file's name
- **Confirm unrelated**: Adjust the topic or keywords so overlap < 3, then retry

## File Format

### File Naming

```
topic--kw1,kw2,kw3,kw4,kw5.md
```

| Part | Description | Example |
|------|-------------|---------|
| topic | Short English identifier representing the memory topic | `coding_standards` |
| kw1~kw5 | Up to 5 keywords, comma-separated | `coding,git,lint,format` |

**Examples**:
- `debug_anti_pattern--uvicorn,cache,code-loading,misdiagnosis.md`
- `data_model--DuckDB,factor,incremental.md`
- `coding_standards--coding,git,lint,format,Karpathy.md`

### File Content

Markdown format, with the title describing the topic:

```markdown
# Coding Standards & File Formatting

Keywords: coding git lint format

## Core Rules
- One PR per concern
- Must lint before commit
- ...

## Pitfalls
- ...
```

### Index File

`MEMORY.md` is maintained automatically by the tool — no manual editing needed. Format:

```markdown
# Memory Index

> Auto-generated — lists all memory files and their keyword summaries

## Files (3)

| # | File | Keywords |
|---|------|----------|
| 1 | coding_standards | coding, git, lint |
| 2 | debug_anti_pattern | uvicorn, cache |

- [coding_standards](coding_standards--coding,git,lint.md)
- [debug_anti_pattern](debug_anti_pattern--uvicorn,cache.md)
```

## Two-Tier Storage

| Tier | Path | Purpose | Example |
|------|------|---------|---------|
| **L1 Global** | `~/.pi/agent/memory/` | Cross-project general knowledge | Toolchain config, coding discipline, general pitfalls |
| **L2 Project** | `<project>/.pi/memory/` | Project-specific knowledge | Architecture decisions, data models, project conventions |

- L1 is visible in all projects
- L2 is visible only under its project directory
- Each tier's index is maintained independently

## Automatic Injection

On every new session start, the `before_agent_start` hook automatically injects the `MEMORY.md` index into the system prompt. Once the agent sees the index, it can use the `read` tool to load specific memory files.

Injection limits:
- Max 200 lines
- Max 25KB
- Truncated automatically with a warning when exceeded

## Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max lines per file | 200 | Write rejected beyond this; split required |
| Max size per file | 50 KB | Write rejected beyond this |
| Hard limit on total files | 40 | Write rejected beyond this; cleanup/merge required |
| Soft limit on total files | 25 | Warning issued beyond this |
| Max keywords | 5 | At most 5 keywords per file |
| Conflict detection threshold | 3 overlapping keywords | Same topic or ≥3 keyword overlap triggers conflict |

## Best Practices

### ✅ Worth Remembering
- Pitfalls you've hit and how you fixed them
- Architecture decisions and the reasoning behind them
- Project-specific conventions and rules
- Toolchain configuration experience
- Debugging misconceptions and anti-patterns

### ❌ Not Worth Remembering
- Transient info (current bug state, tasks in progress)
- Information that can be read directly from source code
- Frequently changing info (version numbers, specific line numbers)

### 🧹 Regular Cleanup
- When memory exceeds 25 files, proactively merge related topics
- When new files supersede outdated conclusions, delete the old ones
- Split files exceeding 200 lines by subtopic

## Architecture

```
extensions/memory/
├── index.ts                 # Entry point: registers tools + before_agent_start hook
├── memory-prompt.md         # Injected instructions (tells the AI how to use memory)
├── lib/
│   ├── types.ts             # Constants (directory paths, limit thresholds)
│   ├── memory-hook.ts       # before_agent_start hook registration
│   ├── memory-inject.ts     # Reads MEMORY.md → generates injection text
│   ├── writer.ts            # File writing + index rebuild
│   └── conflict-detect.ts   # Same-topic / keyword-overlap detection
├── prompts/
│   └── update-description.md  # Full description for the memory_update tool (with write workflow)
└── package.json
```

**Dependencies**:
- `@pi-atelier/shared-utils` — `scanMemoryDir`, `parseFileName` (file name parsing and directory scanning)
- `@earendil-works/pi-coding-agent` — ExtensionAPI
- No other dependencies

## License

MIT
