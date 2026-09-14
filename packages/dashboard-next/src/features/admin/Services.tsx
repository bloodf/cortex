import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Modal, Select, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { TechIcon } from "@/components/TechIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { DataTable, type Column } from "@/components/DataTable";
import { FLabel } from "@/components/fable";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { Service } from "@/mocks/types";
import {
  listAdminServices,
  createAdminService,
  patchAdminService,
  deleteAdminService,
  type ServiceCreateData,
} from "./rpc";

type HealthType = NonNullable<ServiceCreateData["healthType"]>;
type Kind = NonNullable<ServiceCreateData["kind"]>;

const HEALTH_TYPES: HealthType[] = ["http", "tcp", "docker", "systemd", "process"];
const KINDS: Kind[] = ["app", "service", "docker", "process", "dashboard-launcher"];

interface FormState {
  slug: string;
  name: string;
  category: string;
  healthType: HealthType;
  kind: Kind;
  healthUrl: string;
  openUrl: string;
  description: string;
}

const EMPTY_FORM: FormState = {
  slug: "",
  name: "",
  category: "",
  healthType: "http",
  kind: "service",
  healthUrl: "",
  openUrl: "",
  description: "",
};

export function AdminServicesPage() {
  const qc = useQueryClient();
  // Distinct key from api.services (which is web-UI-filtered under ["services"]).
  // Sharing one key collided: the webui subset clobbered this "all services"
  // view (admin showed 0) and vice-versa (Apps went empty).
  const { data = [], isLoading } = useQuery({
    queryKey: ["services", "all"],
    queryFn: listAdminServices,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["services"] });

  const createMut = useMutation({
    mutationFn: createAdminService,
    onSuccess: () => {
      toast.success("Service created");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create service"),
  });

  const patchMut = useMutation({
    mutationFn: patchAdminService,
    onSuccess: () => {
      toast.success("Service updated");
      setDialogOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update service"),
  });

  const deleteMut = useMutation({
    mutationFn: deleteAdminService,
    onSuccess: () => {
      toast.success("Service deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete service"),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (r: Service) => {
    setEditing(r);
    setForm({
      slug: r.slug,
      name: r.name,
      category: r.category,
      healthType: r.health_type,
      kind: r.kind,
      healthUrl: r.health_url ?? "",
      openUrl: r.open_url ?? "",
      description: r.description ?? "",
    });
    setDialogOpen(true);
  };

  const submit = () => {
    if (editing) {
      patchMut.mutate({
        id: editing.id,
        slug: form.slug,
        name: form.name,
        category: form.category,
        healthType: form.healthType,
        kind: form.kind,
        healthUrl: form.healthUrl || null,
        openUrl: form.openUrl || null,
        description: form.description || null,
      });
    } else {
      createMut.mutate({
        slug: form.slug,
        name: form.name,
        category: form.category,
        healthType: form.healthType,
        kind: form.kind,
        healthUrl: form.healthUrl || null,
        openUrl: form.openUrl || null,
        description: form.description || null,
      });
    }
  };

  const saving = createMut.isPending || patchMut.isPending;
  const canSave = form.slug.trim() !== "" && form.name.trim() !== "" && form.category.trim() !== "";

  const columns: Column<Service>[] = [
    {
      key: "name",
      header: "Service",
      sort: (r) => r.name,
      cell: (r) => (
        <div className="flex items-center gap-2.5">
          <TechIcon slug={r.slug} name={r.name} size={24} />
          <div>
            <div className="font-medium text-foreground">{r.name}</div>
            <div className="text-xs text-muted-foreground">{r.slug}</div>
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      sort: (r) => r.category,
      cell: (r) => <span className="text-muted-foreground">{r.category}</span>,
    },
    {
      key: "kind",
      header: "Kind",
      sort: (r) => r.kind,
      cell: (r) => (
        <Tag variant="outlined" className="text-[11px]">
          {r.kind}
        </Tag>
      ),
    },
    {
      key: "type",
      header: "Health",
      sort: (r) => r.health_type,
      cell: (r) => <code className="text-xs">{r.health_type}</code>,
    },
    {
      key: "status",
      header: "Status",
      sort: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "active",
      header: "Active",
      cell: (r) => (
        <Tag variant={r.is_active ? "filled" : "borderless"} className="text-[11px]">
          {r.is_active ? "Yes" : "No"}
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
            description="This will remove the service from the registry."
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
        title="Manage Services"
        description={`${data.length} services registered`}
        actions={
          <Button size="small" type="primary" onClick={openCreate}>
            <Plus className="size-4 mr-1" />
            Add service
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
          r.category.toLowerCase().includes(q)
        }
      />

      <Modal
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        title={editing ? `Edit ${editing.name}` : "Add service"}
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
          {editing
            ? "Update the service registry entry."
            : "Register a new service in the catalog."}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-slug">Slug</FLabel>
            <Input
              id="svc-slug"
              value={form.slug}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              placeholder="my-service"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-name">Name</FLabel>
            <Input
              id="svc-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="My Service"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-category">Category</FLabel>
            <Input
              id="svc-category"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="infra"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-kind">Kind</FLabel>
            <Select
              id="svc-kind"
              value={form.kind}
              onChange={(v) => setForm((f) => ({ ...f, kind: v as Kind }))}
              options={KINDS.map((k) => ({ label: k, value: k }))}
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-health-type">Health type</FLabel>
            <Select
              id="svc-health-type"
              value={form.healthType}
              onChange={(v) => setForm((f) => ({ ...f, healthType: v as HealthType }))}
              options={HEALTH_TYPES.map((t) => ({ label: t, value: t }))}
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-health-url">Health URL</FLabel>
            <Input
              id="svc-health-url"
              value={form.healthUrl}
              onChange={(e) => setForm((f) => ({ ...f, healthUrl: e.target.value }))}
              placeholder="https://…"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <FLabel htmlFor="svc-open-url">Open URL</FLabel>
            <Input
              id="svc-open-url"
              value={form.openUrl}
              onChange={(e) => setForm((f) => ({ ...f, openUrl: e.target.value }))}
              placeholder="https://…"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5 col-span-2">
            <FLabel htmlFor="svc-description">Description</FLabel>
            <Input
              id="svc-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="h-9"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
