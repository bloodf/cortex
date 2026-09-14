// MP-008 (R2) — useAuth tests.
//
// The hook's job is the React state machine: hydrate from `me()` on mount,
// mirror `login()` results into state, clear on `logout()`. The server-fn RPC transport is exercised
// end-to-end by the node-env pipeline tests in
// `src/lib/api/__tests__/auth.functions.test.ts` (real PAM, real session
// store, real gate+handler). We therefore mock the REAL module exports of
// `@/lib/api/auth.functions` (`login`, `logout`, `me` — NOT the hook-local
// aliases `callLogin`/`callLogout`/`callMe` from `useAuth.tsx:42-44`) and
// drive the hook's state transitions through that mock.
//
// RACE GUARD (every test): the mount effect at `useAuth.tsx:48-61` fires
// `callMe` asynchronously. If the probe resolves AFTER `login()` has
// already set `user`, the probe's `setUser(null)` clobbers the login state.
// We therefore await the probe's settlement (`loading` flips to false) at
// the top of every test before invoking any action that mutates `user`.
//
// EMPTY-CREDENTIALS: the mocked `login` mirrors the real gate's zod
// `string().min(1)` constraint on username + password
// (`auth.functions.ts:32`); the assertion tests the mock's real rejection
// (not the Start-context error that was satisfying it before the mock).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { User as ContractUser } from "@cortexos/contracts/entities";
import { AuthProvider } from "./auth-provider";
import { useAuth } from "./useAuth";

vi.mock("@/lib/api/auth.functions", () => {
  // Minimal ContractUser factory — the hook only reads `username` and
  // `isAdmin` (see `useAuth.tsx:33-35`), so other schema fields are not
  // exercised. Cast to satisfy the type.
  const makeUser = (username: string, isAdmin: boolean): ContractUser =>
    ({
      id: "00000000-0000-0000-0000-000000000000",
      username,
      isAdmin,
      isActive: true,
      status: "active",
      groupMemberships: [],
      createdAt: "1970-01-01T00:00:00.000Z",
      lastLoginAt: null,
      activeSessions: 0,
    }) as unknown as ContractUser;

  const login = vi.fn(async (opts: { data: { username: string; password: string } }) => {
    // Mirror the real gate's zod non-empty constraint (username + password
    // are both `z.string().min(1).max(...)` at `auth.functions.ts:32-40`).
    if (!opts.data.username || !opts.data.password) {
      throw new Error("Invalid credentials");
    }
    return {
      user: makeUser(opts.data.username, opts.data.username === "admin"),
      session: { token: "fake-session-token" },
    };
  });
  const logout = vi.fn(async () => ({ ok: true as const }));
  // Mount probe returns no user/session — the test "starts logged out" is
  // what this contract means: a session probe that resolves to null.
  const me = vi.fn(async () => ({ user: null, session: null }));

  return { login, logout, me };
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

beforeEach(() => {
  localStorage.clear();
});

describe("useAuth", () => {
  it("starts logged out", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    // Await the mount probe's settlement before asserting the RESOLVED
    // logged-out state — the pre-effect initial state is also null, but
    // verifying the post-probe state proves the probe ran and returned
    // a null user (the real hydration path).
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it("logs in admin user", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    // RACE GUARD: probe must settle before any action that mutates `user`.
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("admin", "x");
    });
    expect(result.current.user?.username).toBe("admin");
    expect(result.current.user?.is_admin).toBe(true);
  });

  it("logs in standard user", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("bob", "x");
    });
    expect(result.current.user?.username).toBe("bob");
    expect(result.current.user?.is_admin).toBe(false);
  });

  it("rejects empty credentials", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The mock's empty-credentials branch (mirrors the real zod gate) is the
    // ONLY path that can satisfy this assertion now that the real fn is
    // mocked away — the Start-context error is no longer in scope.
    await expect(result.current.login("", "")).rejects.toThrow();
  });

  it("logout clears user", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.login("admin", "x");
    });
    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.user).toBeNull();
  });
});
