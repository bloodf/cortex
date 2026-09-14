// MP-008 (deviation from file ownership): the side-effect import
// `import "@testing-library/jest-dom/vitest"` does NOT register the jest-dom
// matchers under vitest@4.1.8 + jest-dom@6.9.1 in this workspace
// (empirically: side-effect import resolves and runs `expect.extend(extensions)`
// but `expect(...).toBeInTheDocument` still throws "Invalid Chai property").
// The legacy SvelteKit `vitest.setup.ts` (deleted in MP-007) used a
// belt-and-suspenders pattern with an explicit `expect.extend(matchers)` call
// to work around this; with that package removed the workaround is gone and
// ~15 unrelated UI tests broke. We restore the same explicit pattern here so
// the four MP-008 owned files AND the rest of the jsdom suite can GREEN.
// Documented as a deviation in `.planning/harness/artifacts/impl-mp-008-report.md`
// (and in the GATE-RESOLUTION entry for MP-008 follow-up).
import { expect, afterEach, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, configure } from "@testing-library/react";
import { notifyManager } from "@tanstack/react-query";

expect.extend(matchers);

afterEach(() => {
  cleanup();
  // Guard for node-environment tests (server/db specs use
  // `// @vitest-environment node`, where these globals are undefined).
  if (typeof localStorage !== "undefined") localStorage.clear();
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});

// jsdom shims
if (typeof window !== "undefined") {
  // Cold mounting the real Lobe table primitives can take more than the default
  // one-second waitFor deadline before query observers even subscribe. Keep
  // asynchronous assertions bounded without replacing those components or data.
  configure({ asyncUtilTimeout: 5_000 });
  // Query notifies through a scheduled external-store callback; flush it inside
  // React's test boundary so assertions observe committed updates.
  notifyManager.setNotifyFunction((callback) => {
    act(callback);
  });
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    });
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      root = null;
      rootMargin = "";
      thresholds = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }
  // Element.scrollIntoView used by some shadcn primitives
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
}
