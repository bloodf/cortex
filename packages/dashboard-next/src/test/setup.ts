// Bind DOM matchers to this package's Vitest instance. The side-effect
// jest-dom/vitest entry can resolve a different Vitest version via workspace hoisting.
import { expect, afterEach, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
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
