import DOMPurify from "dompurify";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Mail,
  Shield,
  AlertTriangle,
  Flag,
  CheckCheck,
  X,
  Settings,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  RefreshCw,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Checkbox, Input, Modal, Tabs, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { FCard, FToolbar, FLabel } from "@/components/fable";
import { severityColor } from "@/lib/status";
import { Skeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  api,
  callFlagReview,
  callApproveReview,
  callBatchDecision,
  callListMailAccounts,
  callCreateMailAccount,
  callUpdateMailAccount,
  callDeleteMailAccount,
} from "@/lib/api/client";
import type { ServerMailAccount } from "@/lib/api/client";
import { useT } from "@/hooks/useT";
import { useAuth } from "@/hooks/useAuth";
import { csrfHeaders } from "@/lib/csrf";
import type { MailReview } from "@/mocks/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Risk colour helpers
// ---------------------------------------------------------------------------
const riskColor = {
  low: cn("border", severityColor("ok").text),
  medium: cn("border", severityColor("warn").text),
  high: cn("border", severityColor("err").text),
} as const;

// ---------------------------------------------------------------------------
// HTML body sanitizer — strips scripts/event handlers/unknown tags so the
// review detail can render mail HTML safely. DOMPurify runs client-side.
// Returns "" when given empty/non-string input.
// ---------------------------------------------------------------------------

const EMPTY_HTML = "";

let linkHookRegistered = false;

// Register the link-safety hook ONCE at module load. DOMPurify hooks are
// global — registering inside sanitizeHtml would stack duplicates on every
// call. The hook forces target=_blank + rel=noopener noreferrer on all links.
function ensureLinkHook() {
  if (linkHookRegistered) return;
  if (typeof window === "undefined") return; // SSR-safe: hook needs DOM
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  linkHookRegistered = true;
}

export function sanitizeHtml(html: string | null | undefined): string {
  if (typeof html !== "string" || html.length === 0) return EMPTY_HTML;
  try {
    ensureLinkHook();
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      // Strip: scripts/styles (XSS), forms/inputs (phishing), img (remote
      // tracking pixels), interactive controls (clickjacking).
      FORBID_TAGS: [
        "form",
        "input",
        "style",
        "script",
        "img",
        "button",
        "select",
        "textarea",
        "option",
        "iframe",
        "object",
        "embed",
        "base",
        "link",
        "meta",
        "svg",
        "math",
      ],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"],
      ADD_ATTR: ["target", "rel"],
      ALLOW_DATA_ATTR: false,
    });
  } catch {
    return EMPTY_HTML;
  }
}

/**
 * MailBody — render a review's body. Prefers sanitized HTML when the
 * processor stored a text/html part; otherwise falls back to plain text
 * with preserved whitespace.
 */
function MailBody({ review }: { review: MailReview }) {
  const html = useMemo(() => sanitizeHtml(review.bodyHtml), [review.bodyHtml]);
  if (html) {
    return (
      <div
        className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed text-foreground mail-html-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div className="prose prose-sm max-w-none text-sm leading-relaxed text-foreground whitespace-pre-wrap">
      {review.body}
    </div>
  );
}
// ---------------------------------------------------------------------------
// Reviews pane — two-pane list + detail
// ---------------------------------------------------------------------------

function ReviewsPane() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const t = useT();
  const {
    data: mails = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: ["mail"], queryFn: api.mail, refetchInterval: 30_000 });

  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<string | null>(null);

  const active = mails.find((m) => m.id === sel) ?? mails[0] ?? null;

  const allIds = useMemo(() => mails.map((m) => m.id), [mails]);
  const allChecked = picked.size > 0 && picked.size === allIds.length;
  const someChecked = picked.size > 0 && !allChecked;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["mail"] });

  // Optimistic helper: update status in cache before server confirms.
  const optimisticStatus = (id: string, status: MailReview["status"]) => {
    qc.setQueryData<MailReview[]>(["mail"], (p) =>
      p?.map((m) => (m.id === id ? { ...m, status } : m)),
    );
  };

  const handleFlag = async (id: string) => {
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) return;
    setActing(`flag-${id}`);
    optimisticStatus(id, "flagged");
    try {
      await callFlagReview({ data: { id: numId }, headers: csrfHeaders() });
      toast.success("Email flagged");
      invalidate().catch(() => {});
    } catch {
      toast.error("Failed to flag email");
      invalidate().catch(() => {}); // revert optimistic update
    } finally {
      setActing(null);
    }
  };

  const handleApprove = async (id: string) => {
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) return;
    setActing(`approve-${id}`);
    optimisticStatus(id, "approved");
    try {
      await callApproveReview({ data: { id: numId }, headers: csrfHeaders() });
      toast.success("Email approved");
      invalidate().catch(() => {});
    } catch {
      toast.error("Failed to approve email");
      invalidate().catch(() => {});
    } finally {
      setActing(null);
    }
  };

  const handleBatch = async (action: "approve" | "flag") => {
    const ids = Array.from(picked)
      .map((id) => parseInt(id, 10))
      .filter((n) => !Number.isNaN(n));
    if (!ids.length) return;
    const status: MailReview["status"] = action === "approve" ? "approved" : "flagged";
    // Optimistic batch update
    qc.setQueryData<MailReview[]>(["mail"], (p) =>
      p?.map((m) => (picked.has(m.id) ? { ...m, status } : m)),
    );
    setPicked(new Set());
    try {
      await callBatchDecision({ data: { ids, action }, headers: csrfHeaders() });
      toast.success(
        `${ids.length} email${ids.length === 1 ? "" : "s"} ${action === "approve" ? "approved" : "flagged"}`,
      );
      invalidate().catch(() => {});
    } catch {
      toast.error(`Batch ${action} failed`);
      invalidate().catch(() => {});
    }
  };

  const togglePick = (id: string, checked: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setPicked(checked ? new Set(allIds) : new Set());
  };

  if (isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-[420px_1fr]">
        <FCard className="p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </FCard>
        <FCard className="p-5 space-y-4">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </FCard>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <EmptyState
          title={t.empty.mail.reviewsFailedTitle}
          description={t.empty.mail.reviewsFailedDescription}
          action={
            <Button size="small" variant="outlined" icon={<RefreshCw />} onClick={invalidate}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (mails.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Mail className="size-8" />}
          title={t.empty.mail.reviewsEmptyTitle}
          description={t.empty.mail.reviewsEmptyDescription}
        />
      </div>
    );
  }

  let selectAllChecked = false;
  let selectAllIndeterminate = false;
  if (allChecked) {
    selectAllChecked = true;
  } else if (someChecked) {
    selectAllIndeterminate = true;
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[420px_1fr]">
      {/* Left pane — list */}
      <FCard className="overflow-hidden">
        {/* Batch toolbar */}
        <FToolbar className="px-3 py-2 border-b border-border bg-muted/20">
          <Checkbox
            checked={selectAllChecked}
            indeterminate={selectAllIndeterminate}
            onChange={(v) => toggleAll(v)}
            aria-label="Select all"
          />
          {picked.size > 0 ? (
            <>
              <span className="text-xs text-muted-foreground">{picked.size} selected</span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="small"
                  type="primary"
                  className="h-7"
                  icon={<CheckCheck />}
                  disabled={!isAdmin}
                  onClick={() => handleBatch("approve")}
                >
                  Approve
                </Button>
                <Button
                  size="small"
                  danger
                  type="primary"
                  className="h-7"
                  icon={<Flag />}
                  disabled={!isAdmin}
                  onClick={() => handleBatch("flag")}
                >
                  Flag
                </Button>
                <Button
                  size="small"
                  variant="text"
                  className="h-7"
                  icon={<X />}
                  onClick={() => setPicked(new Set())}
                  aria-label="Clear selection"
                />
              </div>
            </>
          ) : (
            <div className="ml-auto flex items-center gap-1 text-xs">
              <span className="text-muted-foreground mr-1">Select:</span>
              {(["high", "medium", "low"] as const).map((level) => {
                const count = mails.filter((m) => m.risk === level).length;
                if (count === 0) return null;
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() =>
                      setPicked(new Set(mails.filter((m) => m.risk === level).map((m) => m.id)))
                    }
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] uppercase transition-colors hover:bg-accent",
                      riskColor[level],
                    )}
                    aria-label={`Select all ${level} risk`}
                    title={`Select all ${count} ${level}-risk email${count === 1 ? "" : "s"}`}
                  >
                    {level} · {count}
                  </button>
                );
              })}
            </div>
          )}
        </FToolbar>

        <div className="divide-y max-h-[70vh] overflow-y-auto">
          {mails.map((m) => {
            const isPicked = picked.has(m.id);
            const isActive = active?.id === m.id;
            const isFlagging = acting === `flag-${m.id}`;
            const isApproving = acting === `approve-${m.id}`;
            return (
              <div
                key={m.id}
                className={cn(
                  "group flex items-start gap-2 px-3 py-2.5 hover:bg-muted/30",
                  isActive && "bg-accent/50",
                  isPicked && "bg-primary/5",
                )}
              >
                <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isPicked}
                    onChange={(v) => togglePick(m.id, v)}
                    aria-label={`Select ${m.subject}`}
                  />
                </div>
                <button onClick={() => setSel(m.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{m.from}</p>
                      <p className="text-sm truncate">{m.subject}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.snippet}</p>
                    </div>
                    <Tag
                      variant="outlined"
                      color={m.risk === "high" ? "red" : m.risk === "medium" ? "gold" : "green"}
                      className="text-[11px] shrink-0"
                    >
                      {m.classificationState === "failed" ? "AI failed" : `${m.spamScore}/100`}
                    </Tag>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {relativeTime(m.received_at)} · {m.status}
                  </p>
                </button>
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <Button
                    size="small"
                    variant="outlined"
                    className="h-7 w-7"
                    title="Approve"
                    aria-label="Approve"
                    icon={isApproving ? <Loader2 className="animate-spin" /> : <Shield />}
                    disabled={!isAdmin || isApproving || isFlagging}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleApprove(m.id).catch(() => {});
                    }}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    danger
                    className="h-7 w-7"
                    title="Flag"
                    aria-label="Flag"
                    icon={isFlagging ? <Loader2 className="animate-spin" /> : <Flag />}
                    disabled={!isAdmin || isApproving || isFlagging}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFlag(m.id).catch(() => {});
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </FCard>

      {/* Right pane — detail */}
      <FCard className="p-5 space-y-4">
        {active ? (
          <>
            <div>
              <div className="flex items-baseline gap-2 flex-wrap">
                <h2 className="text-lg font-semibold">{active.subject}</h2>
                <Tag
                  variant="outlined"
                  color={
                    active.risk === "high" ? "red" : active.risk === "medium" ? "gold" : "green"
                  }
                >
                  {active.risk === "high" && <AlertTriangle className="size-3 mr-1" />}
                  {active.classificationState === "failed"
                    ? "AI classification failed"
                    : `Spam score ${active.spamScore}/100 · ${active.category?.replaceAll("_", " ")}`}
                </Tag>
              </div>
              <p className="text-sm text-muted-foreground">
                From <span className="font-mono">{active.from}</span> ·{" "}
                {relativeTime(active.received_at)}
              </p>
            </div>
            <MailBody review={active} />
            <div className="flex gap-2 pt-3 border-t">
              <Button
                type="primary"
                disabled={!isAdmin || acting === `approve-${active.id}`}
                loading={acting === `approve-${active.id}`}
                icon={acting === `approve-${active.id}` ? undefined : <Shield />}
                onClick={() => {
                  handleApprove(active.id).catch(() => {});
                }}
              >
                Approve
              </Button>
              <Button
                danger
                type="primary"
                disabled={!isAdmin || acting === `flag-${active.id}`}
                loading={acting === `flag-${active.id}`}
                icon={acting === `flag-${active.id}` ? undefined : <Flag />}
                onClick={() => {
                  handleFlag(active.id).catch(() => {});
                }}
              >
                Flag
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Select an email.</p>
        )}
      </FCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account form dialog (create / edit)
// ---------------------------------------------------------------------------

interface AccountFormValues {
  slug: string;
  address: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  inbox: string;
  trashMailbox: string;
  reviewMailbox: string;
  enabled: boolean;
}

const emptyForm = (): AccountFormValues => ({
  slug: "",
  address: "",
  host: "",
  port: "993",
  secure: true,
  username: "",
  password: "",
  inbox: "INBOX",
  trashMailbox: "",
  reviewMailbox: "INBOX.Cortex Mail Guardian Review",
  enabled: true,
});

function fromAccount(a: ServerMailAccount): AccountFormValues {
  return {
    slug: a.slug,
    address: a.address,
    host: a.host,
    port: String(a.port),
    secure: a.secure,
    username: a.username,
    password: "", // never pre-filled — leave blank to keep existing
    inbox: a.inbox,
    trashMailbox: a.trashMailbox ?? "",
    reviewMailbox: a.reviewMailbox,
    enabled: a.enabled,
  };
}

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: ServerMailAccount | null;
  onSaved: () => void;
}

function AccountDialog({ open, onOpenChange, editing, onSaved }: AccountDialogProps) {
  const [form, setForm] = useState<AccountFormValues>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Reset form when dialog opens.
  const handleOpenChange = (o: boolean) => {
    if (o) setForm(editing ? fromAccount(editing) : emptyForm());
    onOpenChange(o);
  };

  const set = (k: keyof AccountFormValues, v: string | boolean) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const headers = csrfHeaders();
    const port = parseInt(form.port, 10);
    const base = {
      slug: form.slug,
      address: form.address,
      host: form.host,
      port: Number.isNaN(port) ? 993 : port,
      secure: form.secure,
      username: form.username,
      inbox: form.inbox,
      trashMailbox: form.trashMailbox || null,
      reviewMailbox: form.reviewMailbox,
      enabled: form.enabled,
    };
    try {
      if (editing) {
        await callUpdateMailAccount({
          data: { ...base, ...(form.password ? { password: form.password } : {}) },
          headers,
        });
        toast.success(`Account "${form.slug}" updated`);
      } else {
        await callCreateMailAccount({ data: { ...base, password: form.password }, headers });
        toast.success(`Account "${form.slug}" created`);
      }
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Save failed";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={() => handleOpenChange(false)}
      title={editing ? `Edit account "${editing.slug}"` : "Add IMAP account"}
      footer={null}
      width={560}
    >
      <form
        onSubmit={(e) => {
          handleSubmit(e).catch(() => {});
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <FLabel htmlFor="acct-slug">Slug</FLabel>
            <Input
              id="acct-slug"
              value={form.slug}
              onChange={(e) => set("slug", e.target.value)}
              disabled={!!editing}
              placeholder="work-inbox"
              required
            />
          </div>
          <div className="space-y-1">
            <FLabel htmlFor="acct-address">Email address</FLabel>
            <Input
              id="acct-address"
              type="email"
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="ops@example.com"
              required
            />
          </div>
        </div>
        <div className="grid grid-cols-[1fr_100px_80px] gap-3 items-end">
          <div className="space-y-1">
            <FLabel htmlFor="acct-host">IMAP host</FLabel>
            <Input
              id="acct-host"
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder="imap.example.com"
              required
            />
          </div>
          <div className="space-y-1">
            <FLabel htmlFor="acct-port">Port</FLabel>
            <Input
              id="acct-port"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => set("port", e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox id="acct-secure" checked={form.secure} onChange={(v) => set("secure", v)} />
            <FLabel htmlFor="acct-secure" className="cursor-pointer">
              TLS
            </FLabel>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <FLabel htmlFor="acct-username">Username</FLabel>
            <Input
              id="acct-username"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="ops@example.com"
              required
            />
          </div>
          <div className="space-y-1">
            <FLabel htmlFor="acct-password">
              Password
              {editing && (
                <span className="text-muted-foreground ml-1 text-xs">(leave blank to keep)</span>
              )}
            </FLabel>
            <Input
              id="acct-password"
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              required={!editing}
              autoComplete="new-password"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <FLabel htmlFor="acct-inbox">Inbox folder</FLabel>
            <Input
              id="acct-inbox"
              value={form.inbox}
              onChange={(e) => set("inbox", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <FLabel htmlFor="acct-review">Review mailbox</FLabel>
            <Input
              id="acct-review"
              value={form.reviewMailbox}
              onChange={(e) => set("reviewMailbox", e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <FLabel htmlFor="acct-trash">
            Trash mailbox <span className="text-muted-foreground text-xs">(optional)</span>
          </FLabel>
          <Input
            id="acct-trash"
            value={form.trashMailbox}
            onChange={(e) => set("trashMailbox", e.target.value)}
            placeholder="Trash"
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="acct-enabled" checked={form.enabled} onChange={(v) => set("enabled", v)} />
          <FLabel htmlFor="acct-enabled" className="cursor-pointer">
            Enabled
          </FLabel>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outlined" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" disabled={saving} loading={saving}>
            {editing ? "Save changes" : "Add account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Accounts management pane
// ---------------------------------------------------------------------------

function AccountsPane() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const t = useT();

  const {
    data: accountsData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["mail", "accounts"],
    queryFn: () => callListMailAccounts({ data: {} }),
  });

  const accounts = accountsData?.accounts ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServerMailAccount | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["mail", "accounts"] });

  const handleDelete = async (slug: string) => {
    setDeleting(slug);
    try {
      await callDeleteMailAccount({ data: { slug }, headers: csrfHeaders() });
      toast.success(`Account "${slug}" deleted`);
      invalidate().catch(() => {});
    } catch {
      toast.error(`Failed to delete account "${slug}"`);
    } finally {
      setDeleting(null);
    }
  };

  if (isLoading) {
    return (
      <FCard className="p-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </FCard>
    );
  }

  if (isError) {
    return (
      <div className="p-6">
        <EmptyState
          title={t.empty.mail.accountsFailedTitle}
          description={t.empty.mail.accountsFailedDescription}
          action={
            <Button size="small" variant="outlined" icon={<RefreshCw />} onClick={invalidate}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <>
      <AccountDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditing(null);
        }}
        editing={editing}
        onSaved={() => {
          invalidate().catch(() => {});
        }}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {accounts.length} IMAP account{accounts.length !== 1 ? "s" : ""} configured
          </p>
          {isAdmin && (
            <Button
              size="small"
              variant="outlined"
              icon={<Plus />}
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              Add account
            </Button>
          )}
        </div>

        {accounts.length === 0 ? (
          <EmptyState
            icon={<Server className="size-8" />}
            title={t.empty.mail.accountsEmptyTitle}
            description={t.empty.mail.accountsEmptyDescription}
            action={
              isAdmin ? (
                <Button
                  size="small"
                  icon={<Plus />}
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  Add account
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <FCard key={a.slug} className="p-4 flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{a.slug}</span>
                    <Tag color={a.enabled ? "blue" : "default"} className="text-[11px]">
                      {a.enabled ? "enabled" : "disabled"}
                    </Tag>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.address} · {a.host}:{a.port} {a.secure ? "(TLS)" : "(plain)"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    inbox: {a.inbox} · review: {a.reviewMailbox}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="small"
                      variant="text"
                      className="h-8 w-8"
                      title="Edit"
                      aria-label="Edit"
                      icon={<Pencil />}
                      onClick={() => {
                        setEditing(a);
                        setDialogOpen(true);
                      }}
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          size="small"
                          variant="text"
                          danger
                          className="h-8 w-8"
                          title="Delete"
                          aria-label="Delete"
                          disabled={deleting === a.slug}
                          icon={
                            deleting === a.slug ? <Loader2 className="animate-spin" /> : <Trash2 />
                          }
                        />
                      }
                      title={`Delete account "${a.slug}"?`}
                      description="This will remove the IMAP account configuration. Existing reviews are kept."
                      destructive
                      requireText={a.slug}
                      confirmLabel="Delete"
                      onConfirm={() => {
                        handleDelete(a.slug).catch(() => {});
                      }}
                    />
                  </div>
                )}
              </FCard>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export function MailGuardianPage() {
  const t = useT();
  const { data: mails = [] } = useQuery({
    queryKey: ["mail"],
    queryFn: api.mail,
    refetchInterval: 30_000,
  });

  const pendingCount = mails.filter((m) => m.status === "pending").length;
  const highRiskCount = mails.filter((m) => m.risk === "high").length;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Mail className="size-5" />}
        title={t.nav.mail}
        description={`${pendingCount} pending review · ${highRiskCount} high-risk`}
      />

      <Tabs
        defaultActiveKey="reviews"
        items={[
          {
            key: "reviews",
            label: (
              <span className="inline-flex items-center">
                <Mail className="size-3.5 mr-1.5" />
                Reviews
              </span>
            ),
            children: <ReviewsPane />,
          },
          {
            key: "accounts",
            label: (
              <span className="inline-flex items-center">
                <Settings className="size-3.5 mr-1.5" />
                Accounts
              </span>
            ),
            children: <AccountsPane />,
          },
        ]}
      />
    </div>
  );
}
