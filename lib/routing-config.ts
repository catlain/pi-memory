import { getEffectiveConfig, patchSettingsSection } from "@pi-atelier/shared-utils";

export interface RoutingConfig {
	enabled: boolean;
	/** 批量判定字符门槛（默认 5000，重工具流 ≈4-8 回合/判） */
	batchChars: number;
	includeSpecs: boolean;
	/** 显式判定模型（缺省 = judgeModel 顶层/legacy/会话默认三层链） */
	judgeModel: string;
}

const DEFAULTS: RoutingConfig = { enabled: true, batchChars: 5000, includeSpecs: true, judgeModel: "" };

/** 热读：跨会话立即感知 off/N 变更（写入层为全局 settings） */
export function loadConfig(cwd: string): RoutingConfig {
	const r = getEffectiveConfig("memoryRouting", { ...DEFAULTS }, cwd) as { config?: Partial<RoutingConfig> };
	return { ...DEFAULTS, ...(r.config ?? {}) };
}

export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
	return patchSettingsSection<RoutingConfig>("memoryRouting", patch, DEFAULTS);
}

export { DEFAULTS };
