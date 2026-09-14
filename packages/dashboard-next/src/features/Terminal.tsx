import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Terminal as TermIcon,
  Lock,
  Plus,
  X,
  Send,
  Radio,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button, Input, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FCard } from "@/components/fable";
import { severityColor } from "@/lib/status";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import { useUI } from "@/hooks/useUI";
import { cn } from "@/lib/utils";
import { listTerminalOps, dispatchTerminalOp } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";

// Same-origin WebSocket; the installed reverse proxy routes this to the
// authenticated local PTY sidecar.
function terminalWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/terminal/ws`;
}

type LiveState = "connecting" | "live" | "unavailable" | "closed";

export interface TabHandle {
  execute: (cmd: string) => void;
  focus: () => void;
  reconnect: () => void;
}

interface TerminalTabProps {
  id: string;
  active: boolean;
  dark: boolean;
  onReady: (id: string, handle: TabHandle) => void;
  onState?: (id: string, state: LiveState) => void;
}

// Read the terminal palette from CSS custom properties so the xterm surface
// tracks the active theme/accent (Oscilloscope tokens).
function terminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--terminal-bg").trim() || "oklch(0.115 0.012 230)";
  const fg = cs.getPropertyValue("--terminal-fg").trim() || "oklch(0.9 0.008 210)";
  const primary = cs.getPropertyValue("--primary").trim() || "oklch(0.78 0.13 185)";
  return { background: bg, foreground: fg, cursor: primary, selectionBackground: primary };
}

function TerminalTab({ id, active, dark, onReady, onState }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Latest-ref pattern: this tab's terminal/WebSocket lifecycle is keyed only
  // on `id`. Props/callbacks that may change during a tab's lifetime are read
  // through refs so the mount effect does not retrigger.
  const onReadyRef = useRef(onReady);
  const onStateRef = useRef(onState);
  onReadyRef.current = onReady;
  onStateRef.current = onState;

  // Mount xterm once per tab
  useEffect(() => {
    if (!containerRef.current) {
      return () => {};
    }
    const term = new XTerm({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* noop */
    }
    termRef.current = term;
    fitRef.current = fit;

    // ---- live-shell disposers (set only in live mode) ----
    let liveDataDisposable: { dispose: () => void } | null = null;
    let ws: WebSocket | null = null;
    let disposed = false;

    const setState = (s: LiveState) => {
      if (!disposed) onStateRef.current?.(id, s);
    };

    // Push xterm dimensions to the PTY so it matches the visible viewport.
    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch {
          /* socket gone */
        }
      }
    };

    // ---- live PTY (WP-19): bind xterm I/O straight to the sidecar WS ----
    const connectLive = () => {
      if (disposed || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
      setState("connecting");
      try {
        ws = new WebSocket(terminalWsUrl());
      } catch {
        setState("unavailable");
        term.writeln("\r\n[Live shell unavailable. Reconnect or use Named Operations below.]");
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws?.close();
          return;
        }
        setState("live");
        term.options.disableStdin = false;
        try {
          fit.fit();
        } catch {
          /* noop */
        }
        sendResize();
        // Raw keystrokes → PTY (xterm onData yields the encoded bytes).
        liveDataDisposable = term.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "input", data }));
            } catch {
              /* gone */
            }
          }
        });
        term.focus();
      };

      // Sidecar sends raw pty bytes as text frames, plus a JSON {type:'exit'}.
      ws.onmessage = (ev) => {
        const data = typeof ev.data === "string" ? ev.data : "";
        if (data.startsWith("{") && data.includes('"type"')) {
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === "exit") {
              term.writeln(
                `\r\n\x1b[33m[process exited${typeof msg.code === "number" ? ` with code ${msg.code}` : ""}]\x1b[0m`,
              );
              return;
            }
          } catch {
            /* not control — fall through and print */
          }
        }
        term.write(data);
      };

      ws.onclose = (ev) => {
        liveDataDisposable?.dispose();
        liveDataDisposable = null;
        if (disposed) return;
        term.options.disableStdin = true;
        wsRef.current = null;
        // Preserve explicit authentication and clean-exit states.
        if (ev.code === 4401) {
          setState("closed");
          term.writeln("\r\n\x1b[31m[session expired — reload to re-authenticate]\x1b[0m");
        } else if (ev.code === 4403) {
          setState("closed");
          term.writeln("\r\n\x1b[31m[forbidden — admin access required]\x1b[0m");
        } else if (ev.code === 4408) {
          setState("closed");
          term.writeln("\r\n\x1b[33m[disconnected — idle timeout]\x1b[0m");
        } else if (ev.code === 4000 || ev.code === 1000 || ev.code === 1012) {
          // clean shell exit / normal / server restart
          setState("closed");
          term.writeln("\r\n\x1b[33m[disconnected]\x1b[0m");
        } else {
          setState("unavailable");
          term.writeln("\r\n[Live shell unavailable. Reconnect or use Named Operations below.]");
        }
      };

      ws.onerror = () => {
        // onclose follows onerror and records the unavailable state.
      };
    };

    connectLive();

    const handle: TabHandle = {
      execute: (cmd: string) => {
        // Live mode: type the command straight into the PTY.
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({ type: "input", data: `${cmd}\n` }));
          } catch {
            /* gone */
          }
          return;
        }
        term.writeln("\r\n[Command not sent: the live shell is disconnected.]");
      },
      focus: () => term.focus(),
      reconnect: () => {
        if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
        term.writeln("\r\n[Reconnecting to the live shell…]");
        connectLive();
      },
    };
    onReadyRef.current(id, handle);

    const onResize = () => {
      try {
        fitRef.current?.fit();
      } catch {
        /* noop */
      }
      sendResize();
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      liveDataDisposable?.dispose();
      if (ws) {
        try {
          ws.close(1000, "tab closed");
        } catch {
          /* noop */
        }
      }
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  // Refit when becoming active
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* noop */
        }
      });
    }
  }, [active]);

  // Re-read theme tokens on theme/accent toggle
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = terminalTheme();
  }, [dark]);

  return <div ref={containerRef} className={cn("h-full w-full", !active && "hidden")} />;
}

interface TabMeta {
  id: string;
  name: string;
}

function ConnStateBadge({ state }: { state: LiveState }) {
  const map: Record<LiveState, { label: string; cls: string; dot: string }> = {
    connecting: {
      label: "connecting",
      cls: severityColor("warn").text,
      dot: cn(severityColor("warn").dot, "animate-pulse"),
    },
    live: {
      label: "live shell",
      cls: severityColor("ok").text,
      dot: severityColor("ok").dot,
    },
    unavailable: { label: "unavailable", cls: severityColor("err").text, dot: severityColor("err").dot },
    closed: {
      label: "disconnected",
      cls: severityColor("err").text,
      dot: severityColor("err").dot,
    },
  };
  const m = map[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-mono", m.cls)}>
      <span className={cn("inline-block size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// NamedOpsPanel — real server-side named-op dispatch (WP-19)
// ---------------------------------------------------------------------------

interface TermOp {
  op: string;
  description: string;
  requiresApproval: boolean;
  placeholders: readonly string[];
}

interface OpResult {
  op: string;
  argv: readonly string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// Cast helpers — same gate-middleware boundary pattern as client.ts.
const listTerminalOpsFn = listTerminalOps as unknown as (opts: {
  data: Record<string, never>;
}) => Promise<{ ops: TermOp[] }>;
const dispatchTerminalOpFn = dispatchTerminalOp as unknown as (opts: {
  data: { op: string; args: Record<string, unknown> };
  headers: Record<string, string>;
}) => Promise<OpResult>;

function NamedOpRow({ op }: { op: TermOp }) {
  const [args, setArgs] = useState<Record<string, string>>(() =>
    Object.fromEntries(op.placeholders.map((p) => [p, ""])),
  );
  const [result, setResult] = useState<OpResult | null>(null);

  const mutation = useMutation({
    mutationFn: () => dispatchTerminalOpFn({ data: { op: op.op, args }, headers: csrfHeaders() }),
    onSuccess: (data) => setResult(data),
  });

  const canRun = op.placeholders.every((p) => (args[p] ?? "").trim() !== "");

  return (
    <FCard className="rounded-md p-3 shadow-none space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-medium">{op.op}</span>
            {op.requiresApproval && (
              <Tag variant="outlined" className="text-[11px]">
                approval
              </Tag>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{op.description}</p>
        </div>
        <Button
          size="small"
          type="default"
          className="h-7 px-2 shrink-0"
          disabled={!canRun || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
        </Button>
      </div>

      {op.placeholders.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {op.placeholders.map((ph) => (
            <div key={ph} className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground font-mono">{ph}:</span>
              <Input
                value={args[ph] ?? ""}
                onChange={(e) => setArgs((prev) => ({ ...prev, [ph]: e.target.value }))}
                className="h-6 text-xs font-mono w-36 px-2"
                placeholder={`<${ph}>`}
              />
            </div>
          ))}
        </div>
      )}

      {mutation.isError && (
        <p className="text-xs text-destructive font-mono">{String(mutation.error)}</p>
      )}

      {result && (
        <div className="rounded border bg-background p-2 space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{result.argv.join(" ")}</span>
            <span className="ml-auto">
              exit {result.exitCode} · {result.durationMs}ms
            </span>
          </div>
          {result.stdout && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-20 overflow-y-auto text-destructive">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
    </FCard>
  );
}

function NamedOpsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["terminal", "ops"],
    queryFn: () => listTerminalOpsFn({ data: {} }),
  });

  const ops = data?.ops ?? [];
  const [expanded, setExpanded] = useState(true);

  return (
    <FCard>
      <div
        className="flex flex-col gap-1.5 p-6 pb-2 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <h3 className="text-sm font-semibold tracking-tight">Named Operations</h3>
          <span className="text-xs text-muted-foreground ml-1">
            real server dispatch · allowlisted ops only
          </span>
          {isLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground ml-auto" />}
          {!isLoading && (
            <span className="text-xs text-muted-foreground ml-auto">{ops.length} ops</span>
          )}
        </div>
      </div>
      {expanded && (
        <div className="p-6 pt-0 space-y-2">
          {ops.length === 0 && !isLoading && (
            <p className="text-xs text-muted-foreground py-2">
              No allowlisted terminal ops registered.
            </p>
          )}
          {ops.map((op) => (
            <NamedOpRow key={op.op} op={op} />
          ))}
        </div>
      )}
    </FCard>
  );
}

export function TerminalPage() {
  const t = useT();
  const { user } = useAuth();
  const { effective } = useUI();
  const [tabs, setTabs] = useState<TabMeta[]>([{ id: "t1", name: "shell-1" }]);
  const [activeId, setActiveId] = useState("t1");
  const [broadcast, setBroadcast] = useState(false);
  const [cmd, setCmd] = useState("");
  const [states, setStates] = useState<Record<string, LiveState>>({});
  const handlesRef = useRef<Map<string, TabHandle>>(new Map());
  const counterRef = useRef(1);

  const onReady = useCallback((id: string, handle: TabHandle) => {
    handlesRef.current.set(id, handle);
  }, []);

  const onState = useCallback((id: string, state: LiveState) => {
    setStates((prev) => (prev[id] === state ? prev : { ...prev, [id]: state }));
  }, []);

  const activeState = states[activeId] ?? "connecting";
  const canSend = broadcast
    ? tabs.some((tab) => states[tab.id] === "live")
    : activeState === "live";

  const addTab = () => {
    counterRef.current += 1;
    const id = `t${counterRef.current}`;
    const name = `shell-${counterRef.current}`;
    setTabs((prev) => [...prev, { id, name }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    handlesRef.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        counterRef.current += 1;
        const nid = `t${counterRef.current}`;
        const nm = `shell-${counterRef.current}`;
        setActiveId(nid);
        return [{ id: nid, name: nm }];
      }
      if (id === activeId) setActiveId(next[next.length - 1].id);
      return next;
    });
  };

  const sendCommand = (override?: string) => {
    const text = (override ?? cmd).trim();
    if (!text || !canSend) return;
    if (broadcast) {
      handlesRef.current.forEach((handle, id) => {
        if (states[id] === "live") handle.execute(text);
      });
    } else {
      handlesRef.current.get(activeId)?.execute(text);
    }
    setCmd("");
  };

  if (!user?.is_admin) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<TermIcon className="size-5" />}
          title={t.nav.terminal}
          description="Interactive shell on the host."
        />
        <FCard>
          <EmptyState
            icon={<Lock className="size-10" />}
            title="403 · Admin only"
            description="Terminal access is restricted to administrators."
          />
        </FCard>
      </div>
    );
  }

  const dark = effective === "dark";

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<TermIcon className="size-5" />}
        title={t.nav.terminal}
        description="Live interactive shell on the host (admin-only PTY). Open multiple tabs and broadcast commands to connected panes. Named Operations remain available when the live shell is disconnected."
      />

      <FCard className="overflow-hidden">
        {/* Tab strip */}
        <div className="flex items-center gap-1 border-b bg-muted/20 px-2 py-1.5 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-mono cursor-pointer border",
                tab.id === activeId
                  ? "bg-card border-border text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/40",
              )}
              onClick={() => {
                setActiveId(tab.id);
                requestAnimationFrame(() => handlesRef.current.get(tab.id)?.focus());
              }}
            >
              <TermIcon className="size-3" />
              <span>{tab.name}</span>
              <button
                aria-label={`Close ${tab.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-50 hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <Button
            type="text"
            size="small"
            className="h-7 px-2"
            onClick={addTab}
            aria-label="New tab"
          >
            <Plus className="size-3.5" />
          </Button>
          {(activeState === "unavailable" || activeState === "closed") && (
            <Button
              size="small"
              onClick={() => handlesRef.current.get(activeId)?.reconnect()}
              aria-label="Reconnect live shell"
            >
              Reconnect
            </Button>
          )}
          <div className="ml-auto pr-1">
            <ConnStateBadge state={activeState} />
          </div>
        </div>

        {/* Terminals */}
        <div className="h-[60vh] w-full bg-card p-3">
          {tabs.map((tab) => (
            <TerminalTab
              key={tab.id}
              id={tab.id}
              active={tab.id === activeId}
              dark={dark}
              onReady={onReady}
              onState={onState}
            />
          ))}
        </div>

        {/* Send / broadcast bar */}
        <div className="flex items-center gap-2 border-t bg-muted/20 px-3 py-2">
          <Button
            type={broadcast ? "primary" : "default"}
            variant={broadcast ? undefined : "outlined"}
            size="small"
            onClick={() => setBroadcast((v) => !v)}
            title="Broadcast to connected tabs"
          >
            <Radio className="size-3.5 mr-1.5" />
            {broadcast ? "Broadcast: ON" : "Broadcast: OFF"}
          </Button>
          <Input
            value={cmd}
            disabled={!canSend}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendCommand();
              }
            }}
            placeholder={
              broadcast
                ? "send-keys to all panes…"
                : `send-keys to ${tabs.find((tab) => tab.id === activeId)?.name ?? "active"}…`
            }
            className="font-mono h-8"
          />
          <Button type="primary" size="small" onClick={() => sendCommand()} disabled={!cmd.trim() || !canSend}>
            <Send className="size-3.5 mr-1.5" />
            Send
          </Button>
        </div>
      </FCard>

      <NamedOpsPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnStateBadge — live PTY connection indicator (WP-19)
// ---------------------------------------------------------------------------
