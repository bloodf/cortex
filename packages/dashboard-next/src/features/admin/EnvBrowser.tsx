import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FileCode, Lock, Unlock, Copy, ShieldCheck, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Modal, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FCard, FLabel } from "@/components/fable";
import { listAdminEnvFiles, readAdminEnv, unlockAdminEnv, updateAdminEnv } from "./rpc";

function remainingSeconds(expiresAt: number | null): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

export function AdminEnvPage() {
  const [selected, setSelected] = useState("");
  const filesQuery = useQuery({
    queryKey: ["envFilePaths"],
    queryFn: listAdminEnvFiles,
    retry: false,
  });
  const paths = filesQuery.data ?? [];
  const path = paths.includes(selected) ? selected : (paths[0] ?? "");

  const [unlockOpen, setUnlockOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: ["envFiles", path],
    queryFn: () => readAdminEnv(path),
    enabled: path !== "",
    // Once a reveal grant is live, keep the cleartext fresh until it expires.
    refetchInterval: (q) => {
      const { data } = q.state;
      if (data?.revealed && data.revealExpiresAt && data.revealExpiresAt > Date.now()) {
        return 30_000;
      }
      return false;
    },
    retry: false,
  });

  const { data } = query;
  const revealed = !!data?.revealed && remainingSeconds(data.revealExpiresAt) > 0;

  // Latest-ref pattern: the per-second timer below must retrigger only on
  // `now`, but it needs the current revealed state, expiry, and refetch fn.
  const revealedRef = useRef(revealed);
  const expiresAtRef = useRef(data?.revealExpiresAt ?? null);
  const refetchRef = useRef(query.refetch);
  revealedRef.current = revealed;
  expiresAtRef.current = data?.revealExpiresAt ?? null;
  refetchRef.current = query.refetch;

  // Tick the countdown each second while a grant is live; refetch when it lapses
  // so cleartext is cleared from the client view.
  useEffect(() => {
    if (!revealed) {
      return () => {};
    }
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [revealed]);

  useEffect(() => {
    if (revealedRef.current && remainingSeconds(expiresAtRef.current) === 0) {
      refetchRef.current().catch(() => {});
    }
  }, [now]);

  // Recomputed every render — the per-second `setNow` tick keeps it current.
  const liveRemaining = remainingSeconds(data?.revealExpiresAt ?? null);

  const doUnlock = async () => {
    const pw = password;
    // Never keep the password in state beyond the submission.
    setPassword("");
    setUnlocking(true);
    try {
      await unlockAdminEnv(pw);
      setUnlockOpen(false);
      toast.success("Reveal unlocked for 10 minutes");
      await query.refetch();
    } catch {
      toast.error("Incorrect password or permission denied");
    } finally {
      setUnlocking(false);
    }
  };

  const copy = (key: string, value: string) => {
    navigator.clipboard?.writeText(value)?.catch(() => {});
    toast.success(`Copied ${key}`);
  };

  const qc = useQueryClient();
  const [editEntry, setEditEntry] = useState<{ path: string; key: string; value: string } | null>(
    null,
  );
  const saveMut = useMutation({
    mutationFn: (vars: { path: string; key: string; value: string }) =>
      updateAdminEnv(vars.path, vars.key, vars.value),
    onSuccess: (_d, vars) => {
      toast.success(`Updated ${vars.key}`);
      setEditEntry(null);
      qc.invalidateQueries({ queryKey: ["envFiles", vars.path] }).catch(() => {});
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update value"),
  });

  let entriesPanel;
  if (query.isError || filesQuery.isError) {
    entriesPanel = (
      <EmptyState
        icon={<FileCode className="size-8" />}
        title="Env browser unavailable"
        description="This file is not accessible or the env browser requires server-side configuration."
      />
    );
  } else if (query.isLoading || filesQuery.isLoading) {
    entriesPanel = <EmptyState title="Loading…" />;
  } else if (data && data.entries.length > 0) {
    entriesPanel = (
      <>
        <div className="flex items-center justify-between mb-3">
          <code className="text-xs text-muted-foreground">{data.path}</code>
          <span className="text-xs text-muted-foreground">{data.entries.length} keys</span>
        </div>
        <div className="space-y-2">
          {data.entries.map((entry) => (
            <div key={entry.key} className="grid grid-cols-[260px_1fr_auto] gap-2 items-center">
              <code className="text-xs font-semibold">{entry.key}</code>
              <Input value={entry.value} readOnly className="h-8 font-mono text-xs" />
              <div className="flex gap-1">
                <Button
                  size="small"
                  type="text"
                  disabled={!revealed}
                  onClick={() => copy(entry.key, entry.value)}
                  title={revealed ? "Copy value" : "Unlock to copy cleartext"}
                  aria-label={revealed ? "Copy value" : "Unlock to copy cleartext"}
                >
                  <Copy className="size-3.5" />
                </Button>
                <Button
                  size="small"
                  type="text"
                  disabled={!revealed}
                  onClick={() => setEditEntry({ path, key: entry.key, value: entry.value })}
                  title={revealed ? "Edit value" : "Unlock to edit"}
                  aria-label={`Edit ${entry.key}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  } else {
    entriesPanel = (
      <EmptyState
        icon={<FileCode className="size-8" />}
        title={path ? "No entries" : "No env files"}
        description={path ? "This env file has no readable keys." : "No environment files were found in the configured service roots."}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Env Browser"
        description="Inspect and rotate environment secrets for managed services."
        actions={
          revealed ? (
            <Tag variant="borderless" className="gap-1.5">
              <ShieldCheck className="size-3.5" />
              Reveal active · expires in {Math.ceil(liveRemaining / 60)}m
            </Tag>
          ) : (
            <Button size="small" type="default" onClick={() => setUnlockOpen(true)}>
              <Lock className="size-4 mr-1" />
              Unlock to reveal
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <FCard className="p-2 h-fit">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground px-2 pb-2">
            Env files
          </div>
          <div role="tablist" aria-label="Env files">
            {paths.map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={p === path}
                onClick={() => setSelected(p)}
                className={`w-full text-left rounded-md px-2 py-1.5 flex items-center gap-2 text-sm transition-colors ${p === path ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"}`}
              >
                <FileCode className="size-3.5 shrink-0" />
                <span className="truncate font-mono text-xs">{p.split("/").pop()}</span>
              </button>
            ))}
          </div>
        </FCard>
        <FCard className="p-4">{entriesPanel}</FCard>
      </div>

      <Modal
        open={unlockOpen}
        onCancel={() => {
          setUnlockOpen(false);
          setPassword("");
        }}
        title={
          <span className="flex items-center gap-2">
            <Unlock className="size-4" />
            Unlock secret reveal
          </span>
        }
        footer={
          <>
            <Button
              type="default"
              size="small"
              onClick={() => {
                setUnlockOpen(false);
                setPassword("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              onClick={() => {
                doUnlock().catch(() => {});
              }}
              disabled={!password || unlocking}
            >
              {unlocking ? "Verifying…" : "Unlock"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Re-enter your password to reveal cleartext secrets for 10 minutes. Your password is
          verified server-side and never stored.
        </p>
        <div className="space-y-1.5">
          <FLabel htmlFor="env-password">Password</FLabel>
          <Input
            id="env-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && !unlocking) doUnlock().catch(() => {});
            }}
            className="h-9"
          />
        </div>
      </Modal>

      <Modal
        open={!!editEntry}
        onCancel={() => setEditEntry(null)}
        title={
          <span className="flex items-center gap-2">
            <Pencil className="size-4" />
            Edit {editEntry?.key}
          </span>
        }
        footer={
          <>
            <Button type="default" size="small" onClick={() => setEditEntry(null)}>
              Cancel
            </Button>
            <Button
              type="primary"
              size="small"
              disabled={saveMut.isPending}
              onClick={() => editEntry && saveMut.mutate(editEntry)}
            >
              {saveMut.isPending ? "Saving…" : "Save value"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Writes <code className="font-mono">{editEntry?.key}</code> back to{" "}
          <code className="font-mono">{editEntry?.path ?? path}</code>. Changing a value here can
          break the services that read it — they may need a restart to pick it up.
        </p>
        <div className="space-y-1.5">
          <FLabel htmlFor="env-edit-value">Value</FLabel>
          <Input
            id="env-edit-value"
            autoFocus
            value={editEntry?.value ?? ""}
            onChange={(e) => setEditEntry((p) => (p ? { ...p, value: e.target.value } : p))}
            className="h-9 font-mono text-xs"
          />
        </div>
      </Modal>
    </div>
  );
}
