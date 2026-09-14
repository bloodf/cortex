import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Pencil, Trash2, Tag } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Modal } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { FLabel } from "@/components/fable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  listAdminBadges,
  createAdminBadge,
  patchAdminBadge,
  deleteAdminBadge,
  type BadgeRow,
} from "./rpc";

interface FormState {
  slug: string;
  label: string;
  color: string;
  textColor: string;
}

const EMPTY_FORM: FormState = { slug: "", label: "", color: "#1f2937", textColor: "#ffffff" };

function BadgeChip({
  label,
  color,
  textColor,
}: {
  label: string;
  color: string;
  textColor: string;
}) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: color, color: textColor }}
    >
      {label}
    </span>
  );
}

export function AdminBadgesPage() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ["badges"], queryFn: listAdminBadges });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BadgeRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["badges"] });

  const createMut = useMutation({
    mutationFn: createAdminBadge,
    onSuccess: () => {
      toast.success("Badge created");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create badge"),
  });
  const patchMut = useMutation({
    mutationFn: patchAdminBadge,
    onSuccess: () => {
      toast.success("Badge updated");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update badge"),
  });
  const deleteMut = useMutation({
    mutationFn: deleteAdminBadge,
    onSuccess: () => {
      toast.success("Badge deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete badge"),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (r: BadgeRow) => {
    setEditing(r);
    setForm({ slug: r.slug, label: r.label, color: r.color, textColor: r.textColor });
    setDialogOpen(true);
  };

  const submit = () => {
    if (editing) patchMut.mutate({ id: editing.id, ...form });
    else createMut.mutate(form);
  };

  const saving = createMut.isPending || patchMut.isPending;
  const canSave = form.slug.trim() !== "" && form.label.trim() !== "";

  const columns: Column<BadgeRow>[] = [
    {
      key: "preview",
      header: "Badge",
      cell: (r) => <BadgeChip label={r.label} color={r.color} textColor={r.textColor} />,
    },
    {
      key: "slug",
      header: "Slug",
      sort: (r) => r.slug,
      cell: (r) => <code className="text-xs">{r.slug}</code>,
    },
    {
      key: "color",
      header: "Colors",
      cell: (r) => (
        <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
          <span className="size-3.5 rounded-sm border" style={{ backgroundColor: r.color }} />
          {r.color}
          <span
            className="size-3.5 rounded-sm border ml-2"
            style={{ backgroundColor: r.textColor }}
          />
          {r.textColor}
        </div>
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
            aria-label={`Edit ${r.label}`}
            onClick={() => openEdit(r)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="small" type="text" aria-label={`Delete ${r.label}`}>
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            }
            title={`Delete ${r.label}?`}
            description="This removes the badge and unassigns it from all services."
            destructive
            confirmLabel="Delete"
            requireText={r.slug}
            onConfirm={() => deleteMut.mutate(r.id)}
          />
        </div>
      ),
    },
  ];

  let confirmLabel: string;
  if (saving) {
    confirmLabel = "Saving…";
  } else if (editing) {
    confirmLabel = "Save changes";
  } else {
    confirmLabel = "Create";
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Tag className="size-5" />}
        title="Manage Badges"
        description={`${data.length} badges`}
        actions={
          <Button size="small" type="primary" onClick={openCreate}>
            <Plus className="size-4 mr-1" />
            Add badge
          </Button>
        }
      />
      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        initialSort="slug"
        filterFn={(r, q) => r.label.toLowerCase().includes(q) || r.slug.includes(q)}
      />

      <Modal
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        title={editing ? `Edit ${editing.label}` : "Add badge"}
        footer={
          <>
            <Button type="default" size="small" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="primary" size="small" onClick={submit} disabled={!canSave || saving}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted-foreground">
          {editing ? "Update the badge." : "Create a new badge chip."}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <FLabel htmlFor="badge-slug">Slug</FLabel>
            <Input
              id="badge-slug"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              placeholder="beta"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="badge-label">Label</FLabel>
            <Input
              id="badge-label"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Beta"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="badge-color">Background</FLabel>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center size-9 shrink-0 border border-border rounded-md bg-transparent">
                <input
                  type="color"
                  aria-label="Background color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  className="size-7 cursor-pointer border-0 bg-transparent p-0"
                />
              </span>
              <Input
                id="badge-color"
                value={form.color}
                onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                className="h-9 font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="badge-text-color">Text color</FLabel>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center size-9 shrink-0 border border-border rounded-md bg-transparent">
                <input
                  type="color"
                  aria-label="Text color"
                  value={form.textColor}
                  onChange={(e) => setForm((f) => ({ ...f, textColor: e.target.value }))}
                  className="size-7 cursor-pointer border-0 bg-transparent p-0"
                />
              </span>
              <Input
                id="badge-text-color"
                value={form.textColor}
                onChange={(e) => setForm((f) => ({ ...f, textColor: e.target.value }))}
                className="h-9 font-mono text-xs"
              />
            </div>
          </div>
          <div className="col-span-2 flex items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">Preview:</span>
            <BadgeChip
              label={form.label || "Label"}
              color={form.color}
              textColor={form.textColor}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
