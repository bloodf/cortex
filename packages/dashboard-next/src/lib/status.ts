export type Status = "online" | "offline" | "unknown" | "checking";

export function statusColor(s: Status): { dot: string; text: string; bg: string } {
  switch (s) {
    case "online":
      return {
        dot: "bg-[var(--success)]",
        text: "text-[var(--success)]",
        bg: "bg-[var(--success)]/10",
      };
    case "offline":
      return {
        dot: "bg-[var(--destructive)]",
        text: "text-[var(--destructive)]",
        bg: "bg-[var(--destructive)]/10",
      };
    case "checking":
      return {
        dot: "bg-[var(--warning)] animate-pulse",
        text: "text-[var(--warning)]",
        bg: "bg-[var(--warning)]/10",
      };
    default:
      return { dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" };
  }
}

export function tempColor(t: number): string {
  if (t >= 85) return "text-[var(--destructive)]";
  if (t >= 70) return "text-[var(--warning)]";
  return "text-[var(--success)]";
}

export function usageColor(p: number): string {
  if (p >= 90) return "text-[var(--destructive)]";
  if (p >= 75) return "text-[var(--warning)]";
  return "text-[var(--success)]";
}

export function usageBg(p: number): string {
  if (p >= 90) return "bg-[var(--destructive)]";
  if (p >= 75) return "bg-[var(--warning)]";
  return "bg-[var(--success)]";
}

export type Severity = "ok" | "warn" | "err" | "off";
export function severityColor(s: Severity): { dot: string; text: string; bg: string } {
  switch (s) {
    case "ok":
      return {
        dot: "bg-[var(--success)]",
        text: "text-[var(--success)]",
        bg: "bg-[var(--success)]/10",
      };
    case "warn":
      return {
        dot: "bg-[var(--warning)]",
        text: "text-[var(--warning)]",
        bg: "bg-[var(--warning)]/10",
      };
    case "err":
      return {
        dot: "bg-[var(--danger)]",
        text: "text-[var(--danger)]",
        bg: "bg-[var(--danger)]/10",
      };
    default:
      return { dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" };
  }
}
