import { describe, it, expect } from "vitest";
import { decideAdminAccess, decideLanding } from "../route-guards";

describe("decideAdminAccess", () => {
  it("sends an unauthenticated visitor to /login", () => {
    expect(decideAdminAccess(null)).toBe("redirect-login");
    expect(decideAdminAccess(undefined)).toBe("redirect-login");
  });

  it("sends an authenticated non-admin to /overview", () => {
    expect(decideAdminAccess({ is_admin: false })).toBe("redirect-overview");
    // Missing flag is treated as non-admin (fail-closed).
    expect(decideAdminAccess({})).toBe("redirect-overview");
  });

  it("allows an admin", () => {
    expect(decideAdminAccess({ is_admin: true })).toBe("allow");
  });

  it("regression: a real admin user is NOT bounced (the cortex.auth bug)", () => {
    // The old guard read localStorage['cortex.auth'] (never written) and so
    // bounced EVERY user, admins included. With cookie-authoritative `me()`,
    // a real admin must be allowed.
    expect(decideAdminAccess({ is_admin: true })).not.toBe("redirect-overview");
    expect(decideAdminAccess({ is_admin: true })).not.toBe("redirect-login");
  });
});

describe("decideLanding", () => {
  it("sends an authenticated visitor to /overview", () => {
    expect(decideLanding({ is_admin: false })).toBe("/overview");
    expect(decideLanding({ is_admin: true })).toBe("/overview");
  });

  it("sends an unauthenticated visitor to /login", () => {
    expect(decideLanding(null)).toBe("/login");
    expect(decideLanding(undefined)).toBe("/login");
  });
});
