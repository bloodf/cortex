/**
 * Adapter tests for `toServiceRow` (MP-028 / item 1.1, "hashId class").
 *
 * These feed the REAL runtime shape the WP-10 repo emits: an integer serial
 * `id` (NOT a uuid string), a nested `icon` object, and an aggregated `badges`
 * array. The adapter must thread `icon.type/color/image` through to the
 * snake_case `icon_type`/`icon_color`/`icon_image` mock fields and map badges,
 * and the integer id must survive `hashId` (a NULL-icon row must not throw).
 */

import { describe, it, expect } from "vitest";
import { toServiceRow, type ServiceRowInput } from "../services";

function baseRow(overrides: Partial<ServiceRowInput> = {}): ServiceRowInput {
  return {
    id: 42,
    slug: "grafana",
    name: "Grafana",
    kind: "service",
    category: "Monitoring",
    healthUrl: "http://127.0.0.1:3000/api/health",
    healthType: "http",
    status: "online",
    sortOrder: 1,
    isActive: true,
    hasWebui: true,
    showInHealthcheck: true,
    showInWebui: true,
    icon: { type: "monogram", color: "#123456", image: "/uploads/g.png" },
    badges: [],
    ...overrides,
  } as ServiceRowInput;
}

describe("toServiceRow — contract icon + badges → mock row", () => {
  it("threads nested icon + integer id through to the mock shape", () => {
    const row = toServiceRow(baseRow());
    expect(row.id).toBe(42); // integer id survives hashId
    expect(row.icon_type).toBe("monogram");
    expect(row.icon_color).toBe("#123456");
    expect(row.icon_image).toBe("/uploads/g.png");
  });

  it("maps badges through toBadgeRef", () => {
    const row = toServiceRow(
      baseRow({
        badges: [
          { slug: "beta", label: "Beta", color: "#10b981" },
          { slug: "internal", label: "Internal", color: null },
        ],
      }),
    );
    expect(row.badges).toHaveLength(2);
    expect(row.badges[0]).toEqual({ slug: "beta", label: "Beta", color: "#10b981" });
    // null badge color falls back to the adapter default.
    expect(row.badges[1]).toEqual({ slug: "internal", label: "Internal", color: "#64748b" });
  });

  it("a NULL-icon row maps to defaults without throwing", () => {
    const row = toServiceRow(baseRow({ icon: { type: "auto", color: null, image: null } }));
    expect(row.icon_type).toBe("auto");
    expect(row.icon_color).toBeNull();
    expect(row.icon_image).toBeNull();
    expect(row.badges).toEqual([]);
  });

  it("a missing icon object falls back to icon_type 'auto'", () => {
    const noIcon: ServiceRowInput = { ...baseRow(), icon: undefined };
    const row = toServiceRow(noIcon);
    expect(row.icon_type).toBe("auto");
    expect(row.icon_color).toBeNull();
    expect(row.icon_image).toBeNull();
  });
});
