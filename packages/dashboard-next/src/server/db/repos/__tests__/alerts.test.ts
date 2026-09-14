// @vitest-environment node
/**
 * Alerts repository tests.
 *
 * Covers both rule-based (alert_rules, alert_history) and operational
 * (alerts) tables.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import {
  listAlertRules,
  getAlertRuleById,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  listAlertHistory,
  insertAlertHistory,
  deleteAlertHistoryOlderThan,
  listOperationalAlerts,
  getOperationalAlertById,
  createOperationalAlert,
  acknowledgeOperationalAlert,
  deleteOperationalAlert,
} from "../alerts";

let db: PgliteDbClient;
let client: PGlite;
let serviceId: number;

beforeEach(async () => {
  const r = await createTestDb();
  db = r.db;
  client = r.client;
  const { services } = await import("../../schema");
  const svc = await db.select().from(services).limit(1);
  serviceId = svc[0].id;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("alerts repo — rule-based", () => {
  it("createAlertRule inserts and returns the row", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "offline rule",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.condition).toBe("offline");
  });

  it("getAlertRuleById returns the row", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "response_time rule",
      condition: "response_time",
      thresholdMs: 500,
      enabled: true,
    });
    const got = await getAlertRuleById(db, rule.id);
    expect(got?.name).toBe("response_time rule");
  });

  it("listAlertRules filters by serviceId", async () => {
    await createAlertRule(db, {
      serviceId,
      name: "rule-1",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    const rows = await listAlertRules(db, { serviceId });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.serviceId === serviceId)).toBe(true);
  });

  it("listAlertRules filters by enabled", async () => {
    await createAlertRule(db, {
      serviceId,
      name: "enabled",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    await createAlertRule(db, {
      serviceId,
      name: "disabled",
      condition: "online",
      thresholdMs: null,
      enabled: false,
    });
    const rows = await listAlertRules(db, { enabledOnly: true });
    expect(rows.every((r) => r.enabled)).toBe(true);
  });

  it("updateAlertRule patches the named fields", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "to update",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    const updated = await updateAlertRule(db, rule.id, {
      enabled: false,
      thresholdMs: 250,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.thresholdMs).toBe(250);
  });

  it("deleteAlertRule removes the row", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "to delete",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    expect(await deleteAlertRule(db, rule.id)).toBe(true);
    expect(await getAlertRuleById(db, rule.id)).toBeNull();
  });

  it("insertAlertHistory + listAlertHistory roundtrip", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "history rule",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    await insertAlertHistory(db, {
      ruleId: rule.id,
      serviceId,
      status: "offline",
      message: "service is down",
    });
    const hist = await listAlertHistory(db, { ruleId: rule.id });
    expect(hist.length).toBe(1);
    expect(hist[0].message).toBe("service is down");
  });

  it("deleteAlertHistoryOlderThan sweeps old rows", async () => {
    const rule = await createAlertRule(db, {
      serviceId,
      name: "retention rule",
      condition: "offline",
      thresholdMs: null,
      enabled: true,
    });
    await insertAlertHistory(db, {
      ruleId: rule.id,
      serviceId,
      status: "offline",
      message: "old",
    });
    // All rows have created_at = NOW, so a cutoff in the future sweeps all.
    const n = await deleteAlertHistoryOlderThan(db, new Date(Date.now() + 1_000));
    expect(n).toBe(1);
  });
});

describe("alerts repo — operational", () => {
  it("createOperationalAlert inserts and returns the row", async () => {
    const a = await createOperationalAlert(db, {
      kind: "test",
      severity: "warn",
      title: "Test alert",
    });
    expect(a.id).toBeGreaterThan(0);
    expect(a.severity).toBe("warn");
  });

  it("createOperationalAlert rejects bad severity", async () => {
    await expect(
      createOperationalAlert(db, {
        kind: "test",
        severity: "fatal",
        title: "x",
      }),
    ).rejects.toThrow("Invalid alert severity");
  });

  it("createOperationalAlert rejects empty title", async () => {
    await expect(
      createOperationalAlert(db, {
        kind: "test",
        severity: "info",
        title: "",
      }),
    ).rejects.toThrow();
  });

  it("listOperationalAlerts filters by severity", async () => {
    await createOperationalAlert(db, { kind: "k1", severity: "info", title: "a" });
    await createOperationalAlert(db, { kind: "k2", severity: "error", title: "b" });
    const rows = await listOperationalAlerts(db, { severity: "error" });
    expect(rows.every((r) => r.severity === "error")).toBe(true);
  });

  it("listOperationalAlerts filters by unacknowledgedOnly", async () => {
    const a = await createOperationalAlert(db, {
      kind: "ack-test",
      severity: "info",
      title: "ack",
    });
    await acknowledgeOperationalAlert(db, a.id);
    const unack = await listOperationalAlerts(db, { unacknowledgedOnly: true });
    expect(unack.find((r) => r.id === a.id)).toBeUndefined();
  });

  it("acknowledgeOperationalAlert sets acknowledgedAt", async () => {
    const a = await createOperationalAlert(db, {
      kind: "ack-test",
      severity: "info",
      title: "ack",
    });
    const got = await acknowledgeOperationalAlert(db, a.id);
    expect(got?.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("acknowledgeOperationalAlert returns null for already-acked", async () => {
    const a = await createOperationalAlert(db, {
      kind: "ack-test",
      severity: "info",
      title: "ack",
    });
    await acknowledgeOperationalAlert(db, a.id);
    const second = await acknowledgeOperationalAlert(db, a.id);
    expect(second).toBeNull();
  });

  it("deleteOperationalAlert removes the row", async () => {
    const a = await createOperationalAlert(db, {
      kind: "del-test",
      severity: "info",
      title: "del",
    });
    expect(await deleteOperationalAlert(db, a.id)).toBe(true);
    expect(await getOperationalAlertById(db, a.id)).toBeNull();
  });
});
