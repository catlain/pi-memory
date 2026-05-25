import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@pi-atelier/shared-utils": path.resolve(
        __dirname,
        "../pi-shared-utils/src/index"
      ),
      "@pi-atelier/shared-utils/*": path.resolve(
        __dirname,
        "../pi-shared-utils/src/*"
      ),
    },
  },
});
