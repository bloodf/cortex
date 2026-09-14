import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@lobehub/ui";
import { LogViewer } from "@/components/LogViewer";

const SOURCES = ["systemd", "docker", "incus", "kernel", "auditd", "ollama", "caddy"];
const LEVELS = ["INFO", "INFO", "INFO", "INFO", "WARN", "DEBUG", "ERROR"] as const;
const MESSAGES = [
  "request handled in 4ms",
  "container heartbeat ok",
  "tls handshake complete",
  "scheduled flush 128KiB",
  "queue depth 3 → 2",
  "model inference q=512 tokens=128",
  "cgroup pressure cpu=12%",
  "config reloaded without restart",
  "health probe ok",
  "GET /api/status 200",
  "incus instance backup-runner exited 0",
  "auditd: USER_AUTH uid=1000 res=success",
  "kernel: br0: port 2 entered learning state",
];

function makeLine() {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const src = SOURCES[Math.floor(Math.random() * SOURCES.length)];
  const lvl = LEVELS[Math.floor(Math.random() * LEVELS.length)];
  const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  return `[${ts}] ${lvl.padEnd(5)} ${src.padEnd(8)} ${msg}`;
}

export interface LogStreamProps {
  height?: number;
  /** Mock-generator tick interval (no-fetcher fallback). */
  intervalMs?: number;
  max?: number;
  /**
   * When provided, lines are sourced by polling this function every
   * `refetchIntervalMs` ms. The mock generator (`makeLine`) remains
   * ONLY as the no-fetcher fallback (used nowhere after MP-009 wires
   * real fetchers at the call sites).
   */
  fetcher?: () => Promise<string[]>;
  /**
   * Polling interval in ms when `fetcher` is set. Ignored otherwise.
   * Defaults to 3000ms.
   */
  refetchIntervalMs?: number;
}

export function LogStream({
  height = 480,
  intervalMs = 700,
  max = 400,
  fetcher,
  refetchIntervalMs = 3000,
}: LogStreamProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // MP-009 fetcher path: poll the fetcher on a setInterval and push the
  // result into `lines`. The mock generator is the no-fetcher fallback.
  // (Direct setInterval polling, NOT React Query — keeps the component
  // self-contained and SSR-safe without requiring a QueryClient.)
  //
  // Error contract: call-site fetchers let rejections propagate. This
  // effect catches them and KEEPS the previously rendered lines — no
  // state update, nothing logged — so a transient failure does not
  // blank the log view.
  useEffect(() => {
    if (!fetcher) {
      return () => {};
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await fetcher();
        if (!cancelled) {
          // Truncate to the last `max` lines so the fetcher path
          // honors the same `max` UX as the mock path.
          setLines(result.length > max ? result.slice(result.length - max) : result);
        }
      } catch {
        // Fetcher rejected — keep the previous lines, no state update.
      }
    };
    // Fire immediately on mount, then on each interval tick.
    tick().catch(() => {});
    if (paused) {
      return () => {
        cancelled = true;
      };
    }
    timer.current = setInterval(() => {
      tick().catch(() => {});
    }, refetchIntervalMs);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [fetcher, refetchIntervalMs, paused, max]);

  // MP-003: defer initial 40 lines to a mount-only effect so SSR and the
  // first client render produce identical markup (fixes React #418 on
  // /healthcheck). Empty deps — never re-runs on dependency changes.
  // Only the no-fetcher fallback path: when a fetcher is wired, the server
  // drives the first lines and we must not seed the mock 40-line burst.
  useEffect(() => {
    if (!fetcher) {
      setLines(Array.from({ length: 40 }, makeLine));
    }
  }, [fetcher]);

  useEffect(() => {
    if (fetcher || paused) {
      return () => {};
    }
    timer.current = setInterval(() => {
      setLines((prev) => {
        const next = [...prev, makeLine()];
        return next.length > max ? next.slice(next.length - max) : next;
      });
    }, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [paused, intervalMs, max, fetcher]);

  let modeLabel: string;
  if (fetcher) {
    modeLabel = paused ? "paused" : `polling every ${refetchIntervalMs}ms`;
  } else {
    modeLabel = paused ? "paused" : `streaming every ${intervalMs}ms`;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground tabular-nums">
          {lines.length} lines · {modeLabel}
        </div>
        <div className="flex gap-1">
          <Button
            size="small"
            variant="outlined"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? (
              <>
                <Play className="size-3.5 mr-1" />
                Resume
              </>
            ) : (
              <>
                <Pause className="size-3.5 mr-1" />
                Pause
              </>
            )}
          </Button>
          <Button size="small" variant="outlined" onClick={() => setLines([])}>
            <Trash2 className="size-3.5 mr-1" />
            Clear
          </Button>
        </div>
      </div>
      <LogViewer lines={lines} height={height} />
    </div>
  );
}
