import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Grid3x3, List, Search, Star, StarOff } from "lucide-react";
import { Block, Button, Input, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { TechIcon } from "@/components/TechIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { FCard, FDot, FToolbar } from "@/components/fable";
import { api } from "@/lib/api/client";
import type { Service } from "@/mocks/types";
import { useT } from "@/hooks/useT";
import { useFavorites } from "@/hooks/useFavorites";
import { cn } from "@/lib/utils";

function ServiceList({
  items,
  view,
  isFavorite,
  onToggle,
}: {
  items: Service[];
  view: "grid" | "list";
  isFavorite: (s: string) => boolean;
  onToggle: (s: string) => void;
}) {
  if (view === "list") {
    return (
      <FCard className="overflow-hidden divide-y">
        {items.map((s) => (
          <div key={s.slug} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30">
            <TechIcon slug={s.slug} name={s.name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FDot
                  status={s.status === "online" ? "ok" : s.status === "offline" ? "err" : "off"}
                />
                <span className="font-medium text-sm truncate">{s.name}</span>
                <Tag variant="outlined" className="text-[11px]">
                  {s.category}
                </Tag>
              </div>
              <p className="text-xs text-muted-foreground truncate">{s.description}</p>
            </div>
            <StatusBadge status={s.status} responseTime={s.responseTime} />
            <button
              onClick={() => onToggle(s.slug)}
              className="text-muted-foreground hover:text-foreground"
              aria-label={
                isFavorite(s.slug)
                  ? `Remove ${s.name} from favorites`
                  : `Add ${s.name} to favorites`
              }
              aria-pressed={isFavorite(s.slug)}
            >
              {isFavorite(s.slug) ? (
                <Star className="size-4 fill-current text-[var(--warning)]" />
              ) : (
                <StarOff className="size-4" />
              )}
            </button>
            <a
              href={s.open_url}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Open ${s.name}`}
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        ))}
      </FCard>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {items.map((s) => (
        <FCard
          key={s.slug}
          className="p-4 hover:elev-2 hover:-translate-y-0.5 hover:border-primary/30 transition-all relative group"
        >
          <div className="w-full">
            <button
              onClick={() => onToggle(s.slug)}
              className="absolute top-2 right-2 opacity-60 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
              aria-label={
                isFavorite(s.slug)
                  ? `Remove ${s.name} from favorites`
                  : `Add ${s.name} to favorites`
              }
              aria-pressed={isFavorite(s.slug)}
            >
              {isFavorite(s.slug) ? (
                <Star className="size-3.5 fill-current text-[var(--warning)]" />
              ) : (
                <StarOff className="size-3.5" />
              )}
            </button>
            <div className="flex items-start gap-3">
              <TechIcon slug={s.slug} name={s.name} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <FDot
                    status={s.status === "online" ? "ok" : s.status === "offline" ? "err" : "off"}
                  />
                  <h3 className="font-semibold text-sm truncate">{s.name}</h3>
                </div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  {s.category}
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground line-clamp-2 min-h-[2lh]">
              {s.description}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <StatusBadge status={s.status} responseTime={s.responseTime} compact />
              <a
                href={s.open_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
                aria-label={`Open ${s.name}`}
              >
                Open <ExternalLink className="size-3" />
              </a>
            </div>
            {s.badges.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {s.badges.slice(0, 3).map((b) => (
                  <span
                    key={b.slug}
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ background: `${b.color}22`, color: b.color }}
                  >
                    {b.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </FCard>
      ))}
    </div>
  );
}

export default function AppsPage() {
  const t = useT();
  const {
    data: services = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["services"],
    queryFn: api.services,
    refetchInterval: 3000,
  });
  const { isFavorite, toggle } = useFavorites();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const [view, setView] = useState<"grid" | "list">("grid");

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(services.map((s) => s.category)))],
    [services],
  );

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return services.filter((s) => {
      if (cat !== "All" && s.category !== cat) return false;
      if (
        ql &&
        !(
          s.name.toLowerCase().includes(ql) ||
          s.slug.includes(ql) ||
          s.description?.toLowerCase().includes(ql)
        )
      ) {
        return false;
      }
      return true;
    });
  }, [services, q, cat]);

  const favs = filtered.filter((s) => isFavorite(s.slug));
  const rest = filtered.filter((s) => !isFavorite(s.slug));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.nav.apps}
        description={`${services.length} active services`}
        actions={
          <div className="flex gap-1 border rounded-md p-0.5 bg-muted/30">
            <Button
              size="small"
              type={view === "grid" ? "primary" : "text"}
              onClick={() => setView("grid")}
              className="h-7 px-2"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
            >
              <Grid3x3 className="size-3.5" />
            </Button>
            <Button
              size="small"
              type={view === "list" ? "primary" : "text"}
              onClick={() => setView("list")}
              className="h-7 px-2"
              aria-label="List view"
              aria-pressed={view === "list"}
            >
              <List className="size-3.5" />
            </Button>
          </div>
        }
      />
      <FToolbar>
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.common.search}
            prefix={<Search className="size-4 text-muted-foreground" aria-hidden />}
            className="h-9"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cn(
                "rounded-full px-3 py-1 text-xs border transition-colors",
                cat === c ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </FToolbar>

      {(() => {
        if (isLoading) {
          return (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Block
                  variant="outlined"
                  key={i}
                  className="h-32 animate-pulse bg-muted/40 border-dashed"
                />
              ))}
            </div>
          );
        }
        if (isError) {
          return (
            <FCard>
              <EmptyState
                icon={<AlertTriangle className="size-8 text-[var(--destructive)]" />}
                title="Failed to load apps"
                description={
                  error instanceof Error ? error.message : "Could not load the apps catalog."
                }
                action={
                  <Button variant="outlined" size="small" onClick={() => refetch()}>
                    Retry
                  </Button>
                }
              />
            </FCard>
          );
        }
        if (filtered.length === 0) {
          return <EmptyState title="No apps match" description="Try clearing filters." />;
        }
        return (
          <div className="space-y-6">
            {favs.length > 0 && (
              <section>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                  Favorites
                </p>
                <ServiceList items={favs} view={view} isFavorite={isFavorite} onToggle={toggle} />
              </section>
            )}
            <section>
              {favs.length > 0 && (
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                  All apps
                </p>
              )}
              <ServiceList items={rest} view={view} isFavorite={isFavorite} onToggle={toggle} />
            </section>
          </div>
        );
      })()}
    </div>
  );
}
