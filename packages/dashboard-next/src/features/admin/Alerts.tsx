import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Modal, Select, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { TableSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/EmptyState";
import { FLabel } from "@/components/fable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { api, callCreateAlert, callPatchAlert, callDeleteAlert } from "@/lib/api/client";
import { csrfHeaders } from "@/lib/csrf";
import type { AlertRule } from "@/mocks/types";

type Condition = "offline" | "online" | "response_time";
const CONDITIONS: Condition[] = ["offline", "online", "response_time"];

interface FormState {
  serviceId: string;
  name: string;
  condition: Condition;
  thresholdMs: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  serviceId: "",
  name: "",
  condition: "offline",
  thresholdMs: "",
  enabled: true,
};

export function AdminAlertsPage() {
  const qc = useQueryClient();
  const {
    data = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: ["alerts", "rules"], queryFn: api.alerts.rules });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["alerts", "rules"] });

  const createMut = useMutation({
    mutationFn: (f: FormState) =>
      callCreateAlert({
        data: {
          serviceId: Number(f.serviceId),
          name: f.name,
          condition: f.condition,
          thresholdMs: f.thresholdMs ? Number(f.thresholdMs) : null,
          enabled: f.enabled,
        },
        headers: csrfHeaders(),
      }),
    onSuccess: () => {
      toast.success("Alert rule created");
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: () => toast.error("Failed to create alert rule"),
  });

  const patchMut = useMutation({
    mutationFn: (f: FormState & { id: number }) =>
      callPatchAlert({
        data: {
          id: f.id,
          name: f.name,
          condition: f.condition,
          thresholdMs: f.thresholdMs ? Number(f.thresholdMs) : null,
          enabled: f.enabled,
        },
        headers: csrfHeaders(),
      }),
    onSuccess: () => {
      toast.success("Alert rule updated");
      setDialogOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      invalidate();
    },
    onError: () => toast.error("Failed to update alert rule"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => callDeleteAlert({ data: { id }, headers: csrfHeaders() }),
    onSuccess: () => {
      toast.success("Alert rule deleted");
      invalidate();
    },
    onError: () => toast.error("Failed to delete alert rule"),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (r: AlertRule) => {
    setEditing(r);
    setForm({
      serviceId: String(r.service_id),
      name: r.name,
      condition: r.condition,
      thresholdMs: r.threshold_ms ? String(r.threshold_ms) : "",
      enabled: r.enabled,
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.serviceId || !form.name) {
      toast.error("Service ID and name are required");
      return;
    }
    if (editing) {
      patchMut.mutate({ ...form, id: Number(editing.id) });
    } else {
      createMut.mutate(form);
    }
  };

  const isPending = createMut.isPending || patchMut.isPending;

  const columns: Column<AlertRule>[] = [
    {
      key: "name",
      header: "Rule",
      sort: (r) => r.name,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "service",
      header: "Service ID",
      sort: (r) => r.service_id,
      cell: (r) => <code className="text-xs text-muted-foreground">#{r.service_id}</code>,
    },
    {
      key: "condition",
      header: "Condition",
      sort: (r) => r.condition,
      cell: (r) => (
        <Tag variant="outlined" className="text-[11px]">
          {r.condition}
        </Tag>
      ),
    },
    {
      key: "threshold",
      header: "Threshold",
      cell: (r) => (
        <span className="tabular-nums text-xs">{r.threshold_ms ? `${r.threshold_ms}ms` : "—"}</span>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (r) => (
        <Tag variant={r.enabled ? "filled" : "borderless"} className="text-[11px]">
          {r.enabled ? "on" : "off"}
        </Tag>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "text-right",
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button
            size="small"
            type="text"
            aria-label={`Edit ${r.name}`}
            onClick={() => openEdit(r)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="small" type="text" aria-label={`Delete ${r.name}`}>
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            }
            title={`Delete rule "${r.name}"?`}
            destructive
            confirmLabel="Delete"
            onConfirm={() => deleteMut.mutate(Number(r.id))}
          />
        </div>
      ),
    },
  ];

  let tablePanel;
  if (isLoading) {
    tablePanel = <TableSkeleton rows={6} cols={5} />;
  } else if (isError) {
    tablePanel = (
      <EmptyState
        title="Failed to load alert rules"
        description="Could not reach the alerts service."
        action={
          <Button
            size="small"
            type="default"
            onClick={() => qc.invalidateQueries({ queryKey: ["alerts", "rules"] })}
          >
            Retry
          </Button>
        }
      />
    );
  } else {
    tablePanel = (
      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        initialSort="name"
        filterFn={(r, q) => r.name.toLowerCase().includes(q)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alert Rules (Admin)"
        description={`${data.length} rules · ${data.filter((r) => r.enabled).length} enabled`}
        actions={
          <Button size="small" type="primary" onClick={openCreate}>
            <Plus className="size-4 mr-1" />
            New rule
          </Button>
        }
      />

      {tablePanel}

      <Modal
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        title={editing ? "Edit alert rule" : "New alert rule"}
        footer={
          <>
            <Button type="default" onClick={() => setDialogOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} disabled={isPending}>
              {isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
              {editing ? "Save changes" : "Create rule"}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          {editing
            ? "Update the alert rule configuration."
            : "Create a new alert rule for a service."}
        </p>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <FLabel htmlFor="ar-service-id">Service ID</FLabel>
            <Input
              id="ar-service-id"
              type="number"
              placeholder="e.g. 1"
              value={form.serviceId}
              disabled={!!editing}
              className="[appearance:textfield]"
              onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <FLabel htmlFor="ar-name">Rule name</FLabel>
            <Input
              id="ar-name"
              placeholder="e.g. API offline"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <FLabel htmlFor="ar-condition">Condition</FLabel>
            <Select
              id="ar-condition"
              value={form.condition}
              onChange={(v) => setForm((f) => ({ ...f, condition: v as Condition }))}
              options={CONDITIONS.map((c) => ({ label: c, value: c }))}
            />
          </div>

          {form.condition === "response_time" && (
            <div className="space-y-1.5">
              <FLabel htmlFor="ar-threshold">Threshold (ms)</FLabel>
              <Input
                id="ar-threshold"
                type="number"
                placeholder="e.g. 2000"
                value={form.thresholdMs}
                className="[appearance:textfield]"
                onChange={(e) => setForm((f) => ({ ...f, thresholdMs: e.target.value }))}
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              id="ar-enabled"
              type="checkbox"
              className="size-4"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            <FLabel htmlFor="ar-enabled">Enabled</FLabel>
          </div>
        </div>
      </Modal>
    </div>
  );
}
