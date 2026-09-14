/**
 * Shared UI/data constants.
 *
 * Live home for a handful of small constants/helpers that outlived the (now
 * deleted) `src/mocks/` seed subsystem. Only values with real importers belong
 * here.
 */

// ── Brand colors for TechIcon monograms ───────────────────────────────
export const BRAND_COLORS: Record<string, string> = {
  ollama: "#111827",
  honcho: "#a855f7",
  "honcho-mcp": "#9333ea",
  hindsight: "#6d28d9",
  "hindsight-control-plane": "#7c3aed",
  "kernel-browser": "#6366f1",
  "cortex-sandbox-runner": "#7c3aed",
  caddy: "#0ea5e9",
  tailscale: "#111827",
  cockpit: "#1d4ed8",
  webmin: "#dc2626",
  incus: "#16a34a",
  dockhand: "#2563eb",
  watchtower: "#0ea5e9",
  dnsmasq: "#22c55e",
  fail2ban: "#ef4444",
  postgresql: "#336791",
  mysql: "#00758f",
  redis: "#dc2626",
  mongodb: "#10b981",
  pgadmin: "#326690",
  phpmyadmin: "#f97316",
  redisinsight: "#b91c1c",
  jellyfin: "#7b2cbf",
  grafana: "#f46800",
  prometheus: "#e6522c",
  loki: "#0a7c2f",
  cadvisor: "#3b82f6",
  "home-assistant": "#41bdf5",
};

/**
 * Deterministic, non-cryptographic hash used to chain audit-preview rows.
 * djb2-derived; kept for the golden-output test that pins its exact outputs.
 */
export function fakeHash(prev: string, payload: string): string {
  let h = 5381;
  const s = `${prev}|${payload}`;
  for (let i = 0; i < s.length; i++) {
    const v = Math.imul(h, 32) + h + s.charCodeAt(i);
    h = ((v % 0x100000000) + 0x100000000) % 0x100000000;
  }
  return `${`00000000${h.toString(16)}`.slice(-8)}…`;
}
