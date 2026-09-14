import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Star, Download, BadgeCheck, Loader2, PackageX, RotateCw } from "lucide-react";
import { Streamdown } from "streamdown";

import { Button, Input, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { DetailDrawer, type DetailTab } from "@/components/DetailDrawer";
import { EmptyState } from "@/components/EmptyState";
import { CopyButton } from "@/components/CopyButton";
import { TechIcon } from "@/components/TechIcon";
import { api, type DockerHubSearchResult } from "@/lib/api/client";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Category presets — Docker Hub's search endpoint has no category taxonomy,
// so each preset is a curated keyword appended to the query server-side.
// ---------------------------------------------------------------------------

const CATEGORIES: { label: string; keyword: string }[] = [
  { label: "Databases", keyword: "database" },
  { label: "Monitoring", keyword: "monitoring" },
  { label: "Media", keyword: "media" },
  { label: "AI/LLM", keyword: "llm" },
  { label: "Networking", keyword: "network" },
  { label: "Dev Tools", keyword: "devops" },
  { label: "Automation", keyword: "automation" },
];

const DEBOUNCE_MS = 400;

function compactCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function DockerSearchPage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<DockerHubSearchResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const activeKeyword = CATEGORIES.find((c) => c.label === category)?.keyword;

  const search = useQuery({
    queryKey: ["docker-hub-search", debounced, activeKeyword],
    // Category-only browse: the keyword doubles as the query when the input
    // is empty (searchDockerHub appends the category to the query server-side,
    // so an empty query + category = browsing that keyword).
    queryFn: () =>
      api.registry.search({
        query: debounced || activeKeyword!,
        ...(debounced && activeKeyword ? { category: activeKeyword } : {}),
      }),
    enabled: debounced.length > 0 || activeKeyword !== undefined,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ["docker-hub-image", selected?.namespace, selected?.name],
    queryFn: () => api.registry.image({ namespace: selected!.namespace, name: selected!.name }),
    enabled: selected !== null,
    staleTime: 5 * 60_000,
  });

  const detailTabs = useMemo((): DetailTab[] => {
    const d = detail.data;
    return [
      {
        id: "readme",
        label: "README",
        content: detail.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading README…
          </div>
        ) : detail.isError ? (
          <EmptyState
            icon={<PackageX className="size-8" />}
            title="Failed to load image details"
            description="Docker Hub did not respond. Retry, or pick another image."
            action={
              <Button variant="outlined" size="small" onClick={() => detail.refetch()}>
                <RotateCw className="size-3.5" /> Retry
              </Button>
            }
          />
        ) : d?.fullDescription ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <Streamdown>{d.fullDescription}</Streamdown>
          </div>
        ) : (
          <EmptyState
            title="No README"
            description="This image has no description on Docker Hub."
          />
        ),
      },
      {
        id: "tags",
        label: "Tags",
        content: (
          <div className="space-y-2">
            {d && d.tags.length > 0 ? (
              d.tags.map((t) => (
                <div key={t.name} className="rounded-lg border border-border px-3 py-2">
                  <div className="font-mono text-sm font-medium">{t.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {t.images.map((img, i) => (
                      <Tag key={i} className="font-mono text-xs">
                        {img.architecture} · {bytes(img.size)}
                      </Tag>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState title="No tags" description="No recent tags reported by Docker Hub." />
            )}
          </div>
        ),
      },
      {
        id: "run",
        label: "Run reference",
        content: (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Installation is manual / prompt-driven — there is no one-click install by design. Use
              this reference command in a terminal or an installer prompt.
            </p>
            {selected && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code className="flex-1 text-sm">
                  docker run {selected.namespace}/{selected.name}
                </code>
                <CopyButton value={`docker run ${selected.namespace}/${selected.name}`} />
              </div>
            )}
          </div>
        ),
      },
    ];
  }, [detail.data, detail.isLoading, detail.isError, detail.refetch, selected]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Search className="size-5" />}
        title="Image Search"
        description="Search Docker Hub for images to run on the host."
      />

      <div className="space-y-3">
        <div className="relative max-w-lg">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Docker Hub (e.g. postgres, nginx, ollama)…"
            prefix={<Search className="size-4 text-muted-foreground" aria-hidden />}
            aria-label="Search Docker Hub"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <Button
              key={c.label}
              type={category === c.label ? "primary" : "default"}
              variant={category === c.label ? undefined : "outlined"}
              size="small"
              className="!rounded-full"
              onClick={() => setCategory(category === c.label ? null : c.label)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </div>

      {debounced.length === 0 && !activeKeyword ? (
        <EmptyState
          icon={<Search className="size-8" />}
          title="Search for an image"
          description="Type a name or pick a category to browse Docker Hub."
        />
      ) : search.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching Docker Hub…
        </div>
      ) : search.isError ? (
        <EmptyState
          icon={<PackageX className="size-8" />}
          title="Search failed"
          description="Docker Hub did not respond. Check connectivity and retry."
          action={
            <Button variant="outlined" size="small" onClick={() => search.refetch()}>
              <RotateCw className="size-3.5" /> Retry
            </Button>
          }
        />
      ) : (search.data?.results.length ?? 0) === 0 ? (
        <EmptyState
          icon={<PackageX className="size-8" />}
          title="No images found"
          description="Try a different query or clear the category filter."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {search.data!.results.map((r) => (
            <button
              key={`${r.namespace}/${r.name}`}
              type="button"
              onClick={() => setSelected(r)}
              className={cn(
                "flex items-start gap-3 rounded-xl border border-border bg-card elev-1 p-3 text-left transition-all",
                "hover:elev-2 hover:-translate-y-0.5",
              )}
            >
              <TechIcon slug={r.name} name={r.name} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-sm font-medium">
                    {r.namespace === "library" ? r.name : `${r.namespace}/${r.name}`}
                  </span>
                  {r.isOfficial && (
                    <Tag className="!h-4 shrink-0 !px-1 text-[11px]">
                      <BadgeCheck className="size-3" /> Official
                    </Tag>
                  )}
                </div>
                {r.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {r.description}
                  </p>
                )}
                <div className="mt-1.5 flex gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Star className="size-3" /> {compactCount(r.starCount)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Download className="size-3" /> {compactCount(r.pullCount)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <DetailDrawer
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
        title={selected ? `${selected.namespace}/${selected.name}` : ""}
        description={selected?.description}
        tabs={detailTabs}
      />
    </div>
  );
}

export default DockerSearchPage;
