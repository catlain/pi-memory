/**
 * Memory Tools — 公共类型与常量
 */

import * as path from "node:path";
import { homedir } from "node:os";

export interface MemoryEntry {
	name: string;
	file: string;
	description: string;
	lines: number;
	scope: "L1" | "L2";
}

/** L1 全局目录 */
export const AGENT_DIR = path.join(homedir(), ".pi/agent");

/** 记忆文件行数上限 */
export const MAX_FILE_LINES = 200;

/** 记忆文件合并后行数上限 */
export const MAX_MERGED_LINES = MAX_FILE_LINES * 2;

/** 记忆文件总数硬限制（超过拒绝写入） */
export const HARD_FILE_LIMIT = 40;

/** 记忆文件总数软限制（超过发出警告） */
export const SOFT_FILE_LIMIT = 25;

/** 记忆文件总数提示阈值 */
export const HINT_FILE_LIMIT = 20;
