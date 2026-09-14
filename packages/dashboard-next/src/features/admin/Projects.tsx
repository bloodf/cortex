import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Pencil, Trash2, FolderGit2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Modal, Select, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { FLabel } from "@/components/fable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  listAdminProjects,
  createAdminProject,
  patchAdminProject,
  deleteAdminProject,
  type ProjectRow,
  type MessagingMode,
} from "./rpc";

const MESSAGING_MODES: MessagingMode[] = ["single", "distributed"];

interface FormState {
  slug: string;
  name: string;
  repoUrl: string;
  primaryPmAccount: string;
  messagingMode: MessagingMode;
}

const EMPTY_FORM: FormState = {
  slug: "",
  name: "",
  repoUrl: "",
  primaryPmAccount: "",
  messagingMode: "single",
};

export function AdminProjectsPage() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: listAdminProjects,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["projects"] });

  const createMut = useMutation({
    mutationFn: createAdminProject,
    onSuccess: () => {
      toast.success("Project created");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create project"),
  });
  const patchMut = useMutation({
    mutationFn: patchAdminProject,
    onSuccess: () => {
      toast.success("Project updated");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update project"),
  });
  const deleteMut = useMutation({
    mutationFn: deleteAdminProject,
    onSuccess: () => {
      toast.success("Project deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete project"),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (r: ProjectRow) => {
    setEditing(r);
    setForm({
      slug: r.slug,
      name: r.name,
      repoUrl: r.repoUrl ?? "",
      primaryPmAccount: r.primaryPmAccount ?? "",
      messagingMode: r.messagingMode,
    });
    setDialogOpen(true);
  };

  const submit = () => {
    const payload = {
      slug: form.slug,
      name: form.name,
      repoUrl: form.repoUrl.trim() || null,
      primaryPmAccount: form.primaryPmAccount.trim() || null,
      messagingMode: form.messagingMode,
    };
    if (editing) patchMut.mutate({ id: editing.id, ...payload });
    else createMut.mutate(payload);
  };

  const saving = createMut.isPending || patchMut.isPending;
  const canSave = form.slug.trim() !== "" && form.name.trim() !== "";

  const columns: Column<ProjectRow>[] = [
    {
      key: "name",
      header: "Project",
      sort: (r) => r.name,
      cell: (r) => (
        <div>
          <div className="font-medium text-foreground">{r.name}</div>
          <div className="text-xs text-muted-foreground font-mono">{r.slug}</div>
        </div>
      ),
    },
    {
      key: "repoUrl",
      header: "Repository",
      cell: (r) =>
        r.repoUrl ? (
          <a
            href={r.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline font-mono"
          >
            {r.repoUrl}
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: "primaryPmAccount",
      header: "PM account",
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{r.primaryPmAccount ?? "—"}</span>
      ),
    },
    {
      key: "messagingMode",
      header: "Messaging",
      sort: (r) => r.messagingMode,
      cell: (r) => (
        <Tag variant="outlined" className="text-[11px]">
          {r.messagingMode}
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
            title={`Delete ${r.name}?`}
            description="This removes the project and its messaging routes (instances are unlinked, not destroyed)."
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
        icon={<FolderGit2 className="size-5" />}
        title="Manage Projects"
        description={`${data.length} projects`}
        actions={
          <Button size="small" type="primary" onClick={openCreate}>
            <Plus className="size-4 mr-1" />
            Add project
          </Button>
        }
      />
      <DataTable
        rows={data}
        columns={columns}
        loading={isLoading}
        initialSort="name"
        filterFn={(r, q) =>
          r.name.toLowerCase().includes(q) ||
          r.slug.includes(q) ||
          (r.primaryPmAccount ?? "").toLowerCase().includes(q)
        }
      />

      <Modal
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        title={editing ? `Edit ${editing.name}` : "Add project"}
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
          {editing ? "Update the project." : "Create a new project."}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <FLabel htmlFor="proj-slug">Slug</FLabel>
            <Input
              id="proj-slug"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              placeholder="my-project"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="proj-name">Name</FLabel>
            <Input
              id="proj-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="My Project"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5 col-span-2">
            <FLabel htmlFor="proj-repo">Repository URL</FLabel>
            <Input
              id="proj-repo"
              value={form.repoUrl}
              onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
              placeholder="https://github.com/org/repo"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="proj-pm">PM account</FLabel>
            <Input
              id="proj-pm"
              value={form.primaryPmAccount}
              onChange={(e) => setForm((f) => ({ ...f, primaryPmAccount: e.target.value }))}
              placeholder="@operator"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="proj-mode">Messaging mode</FLabel>
            <Select
              id="proj-mode"
              value={form.messagingMode}
              onChange={(v) => setForm((f) => ({ ...f, messagingMode: v as MessagingMode }))}
              options={MESSAGING_MODES.map((m) => ({ label: m, value: m }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
