import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    // @lobehub/ui's root barrel pulls @lobehub/fluent-emoji, which ships
    // extensionless directory imports (`export ... from "./FluentEmoji"`) that
    // Node's ESM loader rejects (ERR_UNSUPPORTED_DIR_IMPORT). Inlining forces
    // Vite to transform them so lobe components import cleanly in jsdom tests.
    server: {
      deps: {
        inline: [
          /@lobehub\/ui/,
          /@lobehub\/fluent-emoji/,
          /@lobehub\/icons/,
          /@lobehub\/charts/,
          /@lobehub\/editor/,
        ],
      },
    },
    environment: "jsdom",
    env: { NODE_ENV: "test" },
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", ".lovable"],
    // @lobehub/ui's per-file transform is heavy; unbounded workers on a
    // many-core host saturate CPU/memory and make page-render waitFors flake
    // under peak load (identical tests pass isolated). Cap workers for a
    // deterministic full-suite run — assertions unchanged, just less contention.
    maxWorkers: 4,
    // PGlite WASM init + migration runs vary with host load; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/hooks/**", "src/components/**"],
      exclude: ["src/components/ui/**", "**/*.test.*", "**/*.spec.*"],
      thresholds: { lines: 70, branches: 60, functions: 70, statements: 70 },
    },
  },
});
