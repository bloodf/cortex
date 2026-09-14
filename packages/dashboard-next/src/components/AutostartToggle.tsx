import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
// ponytail: lobehub Switch API mismatch — @lobehub/ui has no top-level Switch export; keep shadcn Switch.
import { Button, Modal } from "@lobehub/ui";
import { Switch } from "@/components/ui/switch";
import { callMintApproval, callSetServiceAutostart } from "@/lib/api/client";
import { APPROVAL_ACTIONS } from "@/lib/api/approval-actions";
import { csrfHeaders } from "@/lib/csrf";

interface Props {
  slug: string;
  enabled: boolean;
  disabled?: boolean;
}

interface ConflictBody {
  blocked: boolean;
  dependents: string[];
}

/**
 * Parse a thrown 409 conflict from the server-fn runner. Gate failures are
 * thrown as `Response` (server-fn-runner.server.ts) with the typed-error
 * envelope as JSON body — validate the shape before trusting it.
 */
async function readConflict(error: unknown): Promise<ConflictBody | null> {
  if (!(error instanceof Response) || error.status !== 409) return null;
  let body: unknown;
  try {
    body = await error.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  if (!("blocked" in body) || body.blocked !== true) return null;
  if (!("dependents" in body) || !Array.isArray(body.dependents)) return null;
  const dependents = body.dependents.filter((d): d is string => typeof d === "string");
  return { blocked: true, dependents };
}

export function AutostartToggle({ slug, enabled, disabled }: Props) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictBody | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["services"] }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["dependencies"] }).catch(() => {});
  };

  /**
   * Mint a single-use approval covering the FULL input (force included — the
   * gate hashes the payload, so a force re-submit needs a fresh mint), then
   * dispatch with the token + CSRF headers.
   */
  const submit = async (next: boolean, force?: boolean): Promise<void> => {
    const input = { slug, enabled: next, ...(force ? { force } : {}) };
    const mint = await callMintApproval({
      data: { action: APPROVAL_ACTIONS.servicesAutostart, payload: input },
      headers: csrfHeaders(),
    });
    await callSetServiceAutostart({
      data: input,
      headers: { ...csrfHeaders(), "x-cortex-approval-token": mint.token },
    });
  };

  const handleToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await submit(next);
      toast.success(`${slug}: autostart ${next ? "enabled" : "disabled"}`);
      invalidate();
    } catch (error) {
      const c = await readConflict(error);
      if (c) {
        setConflict(c);
      } else {
        toast.error(`Failed to ${next ? "enable" : "disable"} autostart for ${slug}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForce = async () => {
    setBusy(true);
    try {
      await submit(false, true);
      setConflict(null);
      toast.success(`${slug}: autostart disabled (forced)`);
      invalidate();
    } catch {
      toast.error(`Failed to disable autostart for ${slug}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Switch
        checked={enabled}
        disabled={disabled || busy}
        onCheckedChange={(v) => {
          handleToggle(v);
        }}
        aria-label={`Autostart ${slug}`}
      />
      <Modal
        open={conflict !== null}
        title="Active dependents would break"
        onCancel={() => setConflict(null)}
        footer={null}
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Disabling <span className="font-medium">{slug}</span> stops it now and on next boot.
            These active services depend on it:
          </p>
          <ul className="list-inside list-disc text-sm">
            {conflict?.dependents.map((d) => (
              <li key={d} className="font-mono">
                {d}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            No edge ≠ unused — this list only covers known configured/observed edges.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={busy} onClick={() => setConflict(null)}>
            Cancel
          </Button>
          <Button
            type="primary"
            danger
            disabled={busy}
            onClick={() => {
              handleForce();
            }}
          >
            Disable anyway
          </Button>
        </div>
      </Modal>
    </>
  );
}
