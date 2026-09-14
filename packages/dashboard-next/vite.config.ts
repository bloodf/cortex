// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Force a Node server build (Nitro node-server preset). Without an explicit
  // `nitro` option the lovable wrapper skips Nitro entirely outside a sandbox,
  // and nitro@3.0.260429-beta predates defaultPreset auto-detect — so the preset
  // MUST be set explicitly. Emits .output/server/index.mjs (run with `node`).
  nitro: { preset: "node-server" },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // Keep test files co-located with routes without treating them as route modules.
    router: {
      routeFileIgnorePattern: "(__tests__)|(-test\\.)|(.test\\.)",
    },
  },
});
