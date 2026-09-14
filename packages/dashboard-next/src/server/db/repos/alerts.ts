/**
 * Alerts repository.
 *
 * Two distinct concerns live in this repo (mirroring the existing
 * `lib/db/alerts.ts`):
 *
 *   - **Rule-based** (`alert_rules` + `alert_history`) — the long-lived
 *     rules the socket server evaluates against service status
 *     transitions, and the historical firings.
 *   - **Operational** (`alerts`) — the transient feed the dashboard
 *     surfaces as toasts and admin notifications. Distinct from rule
 *     history.
 *
 * Both go through the same repo because they share lifecycle verbs
 * (create, list, acknowledge) and the call sites tend to want them
 * in the same transaction.
 */

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { alertHistory, alertRules, alerts, services } from "../schema";
import type {
  Alert,
  AlertHistoryRow,
  AlertRule,
  NewAlert,
  NewAlertHistoryRow,
  NewAlertRule,
} from "../schema";

export type AlertSeverity = "info" | "warn" | "error" | "critical";
export type AlertCondition = "offline" | "online" | "response_time";

const SEVERITIES: ReadonlySet<AlertSeverity> = new Set(["info", "warn", "error", "critical"]);

function validateSeverity(s: string): asserts s is AlertSeverity {
  if (!SEVERITIES.has(s as AlertSeverity)) {
    throw new Error(`Invalid alert severity: ${s}`);
  }
}

// =====================================================================
// Rule-based alerts
// =====================================================================

export interface ListAlertRulesOptions {
  serviceId?: number;
  enabledOnly?: boolean;
}

export async function listAlertRules(
  db: DbClient,
  opts: ListAlertRulesOptions = {},
): Promise<AlertRule[]> {
  const conds: SQL[] = [];
  if (opts.serviceId !== undefined) conds.push(eq(alertRules.serviceId, opts.serviceId));
  if (opts.enabledOnly) conds.push(eq(alertRules.enabled, true));
  const where = conds.length > 0 ? and(...conds) : undefined;
  return db.select().from(alertRules).where(where).orderBy(desc(alertRules.createdAt));
}

export async function getAlertRuleById(db: DbClient, id: number): Promise<AlertRule | null> {
  const rows = await db.select().from(alertRules).where(eq(alertRules.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createAlertRule(db: DbClient, input: NewAlertRule): Promise<AlertRule> {
  if (!input.serviceId) throw new Error("alert_rule.serviceId is required");
  if (!input.name) throw new Error("alert_rule.name is required");
  if (!input.condition) throw new Error("alert_rule.condition is required");
  const inserted = await db.insert(alertRules).values(input).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create alert rule");
  return row;
}

export async function updateAlertRule(
  db: DbClient,
  id: number,
  patch: Partial<Omit<AlertRule, "id" | "createdAt" | "updatedAt">>,
): Promise<AlertRule | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.serviceId !== undefined) update.serviceId = patch.serviceId;
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.condition !== undefined) update.condition = patch.condition;
  if (patch.thresholdMs !== undefined) update.thresholdMs = patch.thresholdMs;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  const res = await db.update(alertRules).set(update).where(eq(alertRules.id, id)).returning();
  return res[0] ?? null;
}

export async function deleteAlertRule(db: DbClient, id: number): Promise<boolean> {
  const res = await db
    .delete(alertRules)
    .where(eq(alertRules.id, id))
    .returning({ id: alertRules.id });
  return res.length > 0;
}

// =====================================================================
// Alert history (rule firings)
// =====================================================================

export interface ListAlertHistoryOptions {
  ruleId?: number;
  serviceId?: number;
  limit?: number;
}

export async function listAlertHistory(
  db: DbClient,
  opts: ListAlertHistoryOptions = {},
): Promise<AlertHistoryRow[]> {
  const conds: SQL[] = [];
  if (opts.ruleId !== undefined) conds.push(eq(alertHistory.ruleId, opts.ruleId));
  if (opts.serviceId !== undefined) conds.push(eq(alertHistory.serviceId, opts.serviceId));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return db
    .select()
    .from(alertHistory)
    .where(where)
    .orderBy(desc(alertHistory.createdAt))
    .limit(limit);
}

export async function insertAlertHistory(
  db: DbClient,
  input: NewAlertHistoryRow,
): Promise<AlertHistoryRow> {
  const inserted = await db.insert(alertHistory).values(input).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to insert alert history");
  return row;
}

export interface AlertHistoryItem {
  id: number;
  ruleName: string;
  serviceName: string;
  status: string;
  message: string;
  timestamp: string;
}

export interface ListAlertHistoryWithNamesOptions {
  limit?: number;
}

export async function listAlertHistoryWithNames(
  db: DbClient,
  opts: ListAlertHistoryWithNamesOptions = {},
): Promise<AlertHistoryItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = await db
    .select({
      id: alertHistory.id,
      ruleName: alertRules.name,
      serviceName: services.name,
      status: alertHistory.status,
      message: alertHistory.message,
      timestamp: alertHistory.createdAt,
    })
    .from(alertHistory)
    .innerJoin(alertRules, eq(alertHistory.ruleId, alertRules.id))
    .innerJoin(services, eq(alertHistory.serviceId, services.id))
    .orderBy(desc(alertHistory.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
  }));
}
export async function deleteAlertHistoryOlderThan(db: DbClient, cutoff: Date): Promise<number> {
  const res = await db
    .delete(alertHistory)
    .where(sql`${alertHistory.createdAt} < ${cutoff}`)
    .returning({ id: alertHistory.id });
  return res.length;
}

// =====================================================================
// Operational alerts (alerts table)
// =====================================================================

export interface ListOperationalAlertsOptions {
  severity?: AlertSeverity;
  unacknowledgedOnly?: boolean;
  limit?: number;
}

export async function listOperationalAlerts(
  db: DbClient,
  opts: ListOperationalAlertsOptions = {},
): Promise<Alert[]> {
  const conds: SQL[] = [];
  if (opts.severity) {
    validateSeverity(opts.severity);
    conds.push(eq(alerts.severity, opts.severity));
  }
  if (opts.unacknowledgedOnly) conds.push(isNull(alerts.acknowledgedAt));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  return db.select().from(alerts).where(where).orderBy(desc(alerts.createdAt)).limit(limit);
}

export async function getOperationalAlertById(db: DbClient, id: number): Promise<Alert | null> {
  const rows = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createOperationalAlert(db: DbClient, input: NewAlert): Promise<Alert> {
  validateSeverity(input.severity);
  if (!input.kind || input.kind.length > 64) {
    throw new Error("Alert kind must be 1..64 chars");
  }
  if (!input.title || input.title.length > 255) {
    throw new Error("Alert title must be 1..255 chars");
  }
  const inserted = await db.insert(alerts).values(input).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create alert");
  return row;
}

export async function acknowledgeOperationalAlert(db: DbClient, id: number): Promise<Alert | null> {
  const res = await db
    .update(alerts)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(alerts.id, id), isNull(alerts.acknowledgedAt)))
    .returning();
  return res[0] ?? null;
}

export async function deleteOperationalAlert(db: DbClient, id: number): Promise<boolean> {
  const res = await db.delete(alerts).where(eq(alerts.id, id)).returning({ id: alerts.id });
  return res.length > 0;
}
