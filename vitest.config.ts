import path from "node:path";
import { createConfig } from "../vitest.config.base";

export default createConfig({
	alias: {
		"@earendil-works/pi-coding-agent": true,
		// judge.ts 运行时依赖 pi-ai/compat：测试环境 node_modules 无 pi-ai，
		// 指向仓库顶层 _sdk-link 内的真身（与 shepherd 同源）
		"@earendil-works/pi-ai/compat": path.resolve(
			__dirname,
			"../_sdk-link/node_modules/@earendil-works/pi-ai/dist/compat.js",
		),
	},
	test: {
		globals: true,
	},
});
