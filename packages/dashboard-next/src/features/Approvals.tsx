import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckCircle2, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button, Modal, Tabs, Tag, TextArea } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard } from "@/components/fable";
import { api, callGrantApproval, callRevokeApproval } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import type { ApprovalRequest } from "@/mocks/types";
import { relativeTime } from "@/lib/format";

export function ApprovalsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const {
    data: items = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: ["approvals"], queryFn: api.approvals });
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["approvals"] }).catch(() => {});
  };

  const handleGrant = async (a: ApprovalRequest) => {
    setPending(`grant-${a.id}`);
    try {
      await callGrantApproval({ data: { id: Number(a.id) }, headers: csrfHeaders() });
      toast.success(`Approved: ${a.summary}`);
      invalidate();
    } catch {
      toast.error(`Failed to approve request`);
    } finally {
      setPending(null);
    }
  };

  const handleRevoke = async (a: ApprovalRequest, revokeReason: string) => {
    setPending(`deny-${a.id}`);
    try {
      await callRevokeApproval({
        data: { id: Number(a.id), reason: revokeReason || undefined },
        headers: csrfHeaders(),
      });
      toast.success(`Denied: ${a.summary}${revokeReason ? ` — ${revokeReason}` : ""}`);
      invalidate();
    } catch {
      toast.error(`Failed to deny request`);
    } finally {
      setPending(null);
      setDenyFor(null);
      setReason("");
    }
  };

  const open = items.filter((i) => i.status === "pending");
  const resolved = items.filter((i) => i.status !== "pending");

  const card = (a: ApprovalRequest) => {
    const isGranting = pending === `grant-${a.id}`;
    const isDenying = pending === `deny-${a.id}`;
    return (
      <FCard key={a.id} className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-sm">{a.summary}</p>
            <p className="text-xs text-muted-foreground">
              <code>{a.tool}</code> · {a.actor} · {relativeTime(a.requested_at)}
            </p>
          </div>
          <Tag
            variant="outlined"
            color={a.status === "approved" ? "green" : a.status === "denied" ? "red" : undefined}
          >
            {a.status}
          </Tag>
        </div>
        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto">
          <code>{a.args_preview}</code>
        </pre>
        {a.reason && <p className="text-xs text-muted-foreground italic">Reason: {a.reason}</p>}
        {a.status === "pending" && user?.is_admin && (
          <div className="flex gap-2 pt-2">
            <Button
              size="small"
              disabled={!!pending}
              icon={isGranting ? undefined : <Check />}
              loading={isGranting}
              onClick={() => handleGrant(a)}
            >
              Approve
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={!!pending}
              icon={isDenying ? undefined : <X />}
              loading={isDenying}
              onClick={() => {
                setDenyFor(a.id);
                setReason("");
              }}
            >
              Deny
            </Button>
          </div>
        )}
      </FCard>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<CheckCircle2 className="size-5" />}
          title={t.nav.approvals}
          description="Loading…"
        />
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <FCard key={i} className="p-4 h-24 animate-pulse bg-muted/40">
              {""}
            </FCard>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<CheckCircle2 className="size-5" />}
          title={t.nav.approvals}
          description="Error loading approvals"
        />
        <p className="text-sm text-destructive">Failed to load approvals. Please try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CheckCircle2 className="size-5" />}
        title={t.nav.approvals}
        description={`${open.length} pending`}
      />
      <Tabs
        defaultActiveKey="pending"
        items={[
          {
            key: "pending",
            label: `Pending (${open.length})`,
            children: (
              <div className="mt-4 space-y-3">
                {open.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No pending approvals.</p>
                ) : (
                  open.map(card)
                )}
              </div>
            ),
          },
          {
            key: "resolved",
            label: `Resolved (${resolved.length})`,
            children: (
              <div className="mt-4 space-y-3">
                {resolved.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No resolved approvals.</p>
                ) : (
                  resolved.map(card)
                )}
              </div>
            ),
          },
        ]}
      />
      <Modal
        open={!!denyFor}
        onCancel={() => setDenyFor(null)}
        title="Deny request"
        footer={[
          <Button key="cancel" variant="outlined" onClick={() => setDenyFor(null)}>
            Cancel
          </Button>,
          <Button
            key="deny"
            danger
            type="primary"
            disabled={!!pending}
            loading={pending?.startsWith("deny-")}
            onClick={() => {
              const target = items.find((i) => i.id === denyFor);
              if (target) handleRevoke(target, reason).catch(() => {});
            }}
          >
            Deny
          </Button>,
        ]}
      >
        <TextArea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
        />
      </Modal>
    </div>
  );
}
