// @vitest-environment node
/**
 * WP-01 unit tests for the ported CSRF double-submit guard.
 * Verifies: safe methods are a no-op; the three-way (header == cookie ==
 * session-bound) check; constant-time equality; and that a missing session
 * surfaces as 401 (not a CSRF 403, to avoid revealing CSRF to the unauthed).
 */

import { describe, it, expect } from "vitest";
import {
  csrfIsSafeMethod,
  csrfHeadersFromRequest,
  requireCsrf,
  LOGIN_BOOTSTRAP_CSRF,
} from "../csrf";
import { safeCsrfEqual } from "../cookies";
import { WebCookieJar } from "../../context";
import { CSRF_COOKIE } from "../../config";
import { ApiErrorThrown } from "../../errors";

function req(opts: { method?: string; csrfCookie?: string; csrfHeader?: string }): {
  request: Request;
  jar: WebCookieJar;
} {
  const headers: Record<string, string> = {};
  if (opts.csrfCookie !== undefined) {
    headers.cookie = `${CSRF_COOKIE}=${encodeURIComponent(opts.csrfCookie)}`;
  }
  if (opts.csrfHeader !== undefined) headers["x-csrf-token"] = opts.csrfHeader;
  const request = new Request("http://localhost/api/x", { method: opts.method ?? "POST", headers });
  return { request, jar: new WebCookieJar(request) };
}

describe("csrfIsSafeMethod", () => {
  it("treats GET/HEAD/OPTIONS as safe", () => {
    ["GET", "head", "Options"].forEach((m) => expect(csrfIsSafeMethod(m)).toBe(true));
  });
  it("treats POST/PUT/PATCH/DELETE as unsafe", () => {
    ["POST", "PUT", "PATCH", "DELETE"].forEach((m) => expect(csrfIsSafeMethod(m)).toBe(false));
  });
});

describe("safeCsrfEqual", () => {
  it("is true only for identical non-null strings", () => {
    expect(safeCsrfEqual("abc", "abc")).toBe(true);
    expect(safeCsrfEqual("abc", "abd")).toBe(false);
    expect(safeCsrfEqual("abc", "ab")).toBe(false);
    expect(safeCsrfEqual(null, "abc")).toBe(false);
    expect(safeCsrfEqual("abc", null)).toBe(false);
  });
});

describe("csrfHeadersFromRequest", () => {
  it("reads the x-csrf-token header", () => {
    const { request } = req({ csrfHeader: "tok" });
    expect(csrfHeadersFromRequest(request)).toBe("tok");
  });
});

describe("requireCsrf", () => {
  it("is a no-op on safe methods", () => {
    const { request, jar } = req({ method: "GET" });
    expect(() => requireCsrf(request, null, jar)).not.toThrow();
  });

  it("passes when header == cookie == session-bound token", () => {
    const tok = "session-bound-token";
    const { request, jar } = req({ csrfCookie: tok, csrfHeader: tok });
    expect(() => requireCsrf(request, tok, jar)).not.toThrow();
  });

  it("throws 401 when there is no session-bound token", () => {
    const tok = "tok";
    const { request, jar } = req({ csrfCookie: tok, csrfHeader: tok });
    try {
      requireCsrf(request, null, jar);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiErrorThrown);
      expect((e as ApiErrorThrown).status).toBe(401);
    }
  });

  it("throws 403 when the header is missing (stolen-cookie attack)", () => {
    const tok = "tok";
    const { request, jar } = req({ csrfCookie: tok });
    try {
      requireCsrf(request, tok, jar);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ApiErrorThrown).status).toBe(403);
    }
  });

  it("throws 403 when the cookie is missing", () => {
    const tok = "tok";
    const { request, jar } = req({ csrfHeader: tok });
    try {
      requireCsrf(request, tok, jar);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ApiErrorThrown).status).toBe(403);
    }
  });

  it("throws 403 when header/cookie mismatch the session-bound token", () => {
    const { request, jar } = req({ csrfCookie: "aaa", csrfHeader: "aaa" });
    try {
      requireCsrf(request, "bbb", jar);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ApiErrorThrown).status).toBe(403);
    }
  });

  it("exposes a stable login bootstrap token", () => {
    expect(LOGIN_BOOTSTRAP_CSRF).toBe("login-bootstrap");
  });
});
