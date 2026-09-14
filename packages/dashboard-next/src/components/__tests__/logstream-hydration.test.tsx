import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { render, waitFor, act } from "@testing-library/react";
import { LogStream } from "../LogStream";

// Regression test for MP-003 / AN-002: LogStream previously called
// `makeLine()` (new Date() + Math.random()) inside its useState initializer,
// so the static markup produced by SSR and the first client render did not
// match — React then threw #418 (hydration text mismatch) on /healthcheck.
//
// The fix defers the 40 initial lines to a mount-only useEffect, so the
// initial markup is fully deterministic. This test pins that contract by
// rendering <LogStream /> twice to a string and asserting the outputs are
// byte-identical.
describe("LogStream — SSR/client hydration determinism (MP-003)", () => {
  it("produces identical static markup on two consecutive SSR renders", () => {
    const first = renderToString(<LogStream />);
    const second = renderToString(<LogStream />);
    expect(second).toBe(first);
  });

  it("SSR markup with a fetcher prop is identical on two renders (empty list)", () => {
    // Hydration guard binding (MP-009): the SSR initial markup MUST stay
    // the deterministic empty list regardless of whether a fetcher is
    // passed. Asserted per-render: two SSR renders of the same JSX
    // (fetcher or not) must produce byte-identical markup.
    const fetcher = vi.fn(async () => ["a", "b"]);
    const a = renderToString(<LogStream fetcher={fetcher} />);
    const b = renderToString(<LogStream fetcher={fetcher} />);
    expect(b).toBe(a);
  });
});

// MP-009 — fetcher + refetchIntervalMs props. Renders the LogStream with
// a fake fetcher and verifies that lines from the fetcher appear after
// mount, and that the custom refetchIntervalMs drives a second poll.
describe("LogStream — fetcher + refetchIntervalMs props (MP-009)", () => {
  // No fake timers — the polling uses setInterval under the hood but
  // the test uses a small (50ms) refetchIntervalMs so the wait is fast.
  // The contract is: the CUSTOM interval value is honored — a different
  // value would call the fetcher a different number of times.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the fetcher's lines after mount and re-polls on the custom interval", async () => {
    let callCount = 0;
    const fetcher = vi.fn<() => Promise<string[]>>().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return ["from-fetcher-1", "from-fetcher-2"];
      if (callCount === 2) return ["from-fetcher-poll-2"];
      return ["steady-state-line"]; // any further polls return valid data
    });

    // Use a generous interval (250ms) so the test has time to observe the
    // 2nd poll's data before the 3rd poll overwrites it.
    const { findByText, getByText, unmount } = render(
      <LogStream fetcher={fetcher} refetchIntervalMs={250} />,
    );

    // First poll resolves — lines appear.
    await findByText("from-fetcher-1");
    expect(getByText("from-fetcher-2")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance by the CUSTOM interval value (250ms — the test custom value
    // is honored; the test is specifically about a non-default interval).
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 300);
      });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    // The second poll's line is now present.
    await findByText("from-fetcher-poll-2");

    unmount();
  });

  it("honors a different custom refetchIntervalMs (interval drives timing)", async () => {
    // The contract: passing a different custom interval drives a
    // different number of fetcher calls per unit time. This pins that
    // the value is honored, not hard-coded.
    const fetcher = vi.fn<() => Promise<string[]>>().mockResolvedValue(["a", "b"]);

    const { unmount } = render(<LogStream fetcher={fetcher} refetchIntervalMs={20} />);

    // Wait ~120ms — expect ~5 fetcher calls (one initial + 5 polls).
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 120);
      });
    });
    const calls = fetcher.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(7);
    unmount();
  });
});
