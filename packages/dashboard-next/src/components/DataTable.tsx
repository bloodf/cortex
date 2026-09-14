import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Search,
} from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, Checkbox, Input, Select } from "@lobehub/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Local-mode sort accessor. Server mode sorts by column `key`. */
  sort?: (row: T) => string | number;
  /** Set to false on a column with a `sort` accessor to disable server sorting. */
  serverSortable?: boolean;
  className?: string;
  width?: string;
}

export interface ServerListParams {
  q: string;
  page: number;
  pageSize: number;
  sortKey: string | null;
  sortDir: "asc" | "desc";
}
export interface ServerListResult<T> {
  rows: T[];
  total: number;
}
export interface ServerSource<T> {
  /** Stable query-key prefix; pagination/search state is appended automatically. */
  queryKey: readonly unknown[];
  fetch: (params: ServerListParams) => Promise<ServerListResult<T>>;
  /** Refetch interval in ms while mounted. */
  refetchInterval?: number;
}

function SortIcon({
  sortKey,
  columnKey,
  sortDir,
}: {
  sortKey: string | null;
  columnKey: string;
  sortDir: "asc" | "desc";
}) {
  if (sortKey !== columnKey) return <ArrowUpDown className="size-3 opacity-50" />;
  return sortDir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />;
}

interface Props<T> {
  rows?: T[];
  columns: Column<T>[];
  filterFn?: (row: T, q: string) => boolean;
  initialSort?: string;
  initialSortDir?: "asc" | "desc";
  empty?: ReactNode;
  loading?: boolean;
  density?: "comfortable" | "compact";
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  paginate?: boolean;
  pageSizeOptions?: number[];
  selectable?: boolean;
  rowKey?: (row: T) => string;
  selectionToolbar?: (selected: T[], clear: () => void) => ReactNode;
  onRowContextMenu?: (row: T, e: React.MouseEvent) => void;
  /** Drive rows from a server-side API. Disables local filter/sort/paginate. */
  server?: ServerSource<T>;
}

const DEBOUNCE_MS = 300;

export function DataTable<T>({
  rows: localRows,
  columns,
  filterFn,
  initialSort,
  initialSortDir = "asc",
  empty,
  loading: loadingProp,
  density = "comfortable",
  searchPlaceholder = "Search…",
  toolbar,
  pageSize: initialPageSize = 25,
  paginate = true,
  pageSizeOptions = [10, 25, 50, 100],
  selectable,
  rowKey,
  selectionToolbar,
  onRowContextMenu,
  server,
}: Props<T>) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(initialSort ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Debounce search input
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(q), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  useEffect(() => {
    setPage(0);
  }, [pageSize, debouncedQ]);

  // ----- Server mode -----
  const serverQuery = useQuery({
    queryKey: server
      ? [...server.queryKey, "page", page, pageSize, debouncedQ, sortKey, sortDir]
      : ["__noop__"],
    queryFn: () => server!.fetch({ q: debouncedQ, page, pageSize, sortKey, sortDir }),
    enabled: !!server,
    placeholderData: keepPreviousData,
    refetchInterval: server?.refetchInterval,
  });

  const serverRows = useMemo(
    () => (server ? (serverQuery.data?.rows ?? []) : null),
    [server, serverQuery.data],
  );
  const serverTotal = server ? (serverQuery.data?.total ?? 0) : 0;
  const isServerLoading = server ? serverQuery.isLoading && !serverQuery.data : false;
  const isServerFetching = server ? serverQuery.isFetching : false;
  const loading = server ? isServerLoading : !!loadingProp;
  // A failed server fetch must not masquerade as an empty table ("No results"
  // when the request actually errored). Show an honest error row instead.
  const serverError = server ? serverQuery.isError && !serverQuery.data : false;

  // ----- Local mode (when no server) -----
  const rows = useMemo(() => localRows ?? [], [localRows]);
  const filtered = useMemo(() => {
    if (server) return [];
    if (!debouncedQ || !filterFn) return rows;
    return rows.filter((r) => filterFn(r, debouncedQ.toLowerCase()));
  }, [rows, debouncedQ, filterFn, server]);

  const sortedLocal = useMemo(() => {
    if (server) return [];
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sort!(a);
      const bv = col.sort!(b);
      if (av === bv) return 0;
      const d = av > bv ? 1 : -1;
      return sortDir === "asc" ? d : -d;
    });
  }, [filtered, sortKey, sortDir, columns, server]);

  const total = server ? serverTotal : sortedLocal.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages - 1);
  const view = useMemo<T[]>(() => {
    if (server) return serverRows ?? [];
    if (paginate) return sortedLocal.slice(safePage * pageSize, (safePage + 1) * pageSize);
    return sortedLocal;
  }, [server, serverRows, paginate, sortedLocal, safePage, pageSize]);

  const isSortable = (c: Column<T>) => (server ? (c.serverSortable ?? !!c.sort) : !!c.sort);
  const toggleSort = (k: string) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  // ----- Selection -----
  const selectedRows = useMemo(
    () => (selectable && rowKey ? view.filter((r) => selected.has(rowKey(r))) : []),
    [view, selected, selectable, rowKey],
  );
  const clearSelection = () => setSelected(new Set());
  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allOnPageSelected =
    selectable && rowKey && view.length > 0 && view.every((r) => selected.has(rowKey(r)));
  const toggleAllOnPage = () => {
    if (!selectable || !rowKey) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) view.forEach((r) => next.delete(rowKey(r)));
      else view.forEach((r) => next.add(rowKey(r)));
      return next;
    });
  };

  const showSelectionBar = selectable && selectedRows.length > 0 && selectionToolbar;
  const showSearch = !!server || !!filterFn;

  let tbodyContent: ReactNode;
  if (loading) {
    tbodyContent = Array.from({ length: 6 }).map((_, i) => (
      <tr key={i} className="h-11 border-b last:border-0" aria-hidden>
        {selectable && (
          <td className="px-3 py-2">
            <div className="size-4 rounded bg-muted/70 animate-pulse motion-reduce:animate-none" />
          </td>
        )}
        {columns.map((c, ci) => {
          let widthClass: string;
          if (ci === 0) widthClass = "w-3/4";
          else if (ci === columns.length - 1) widthClass = "w-1/3";
          else widthClass = "w-2/3";
          return (
            <td key={c.key} className={cn("px-3", density === "compact" ? "py-2" : "py-3")}>
              <div
                className={cn(
                  "h-3 rounded bg-muted/70 animate-pulse motion-reduce:animate-none",
                  widthClass,
                )}
              />
            </td>
          );
        })}
      </tr>
    ));
  } else if (serverError) {
    tbodyContent = (
      <tr>
        <td
          colSpan={columns.length + (selectable ? 1 : 0)}
          className="px-3 py-10 text-center text-destructive text-sm"
          role="alert"
        >
          Failed to load. The request errored — it will retry automatically.
        </td>
      </tr>
    );
  } else if (view.length === 0) {
    tbodyContent = (
      <tr>
        <td colSpan={columns.length + (selectable ? 1 : 0)}>
          {empty ?? <EmptyState title="No results" />}
        </td>
      </tr>
    );
  } else {
    tbodyContent = view.map((row, i) => {
      const id = rowKey ? rowKey(row) : String(i);
      const isSel = selectable && rowKey ? selected.has(id) : false;
      return (
        <tr
          key={id}
          className={cn("h-11 border-b last:border-0 hover:bg-muted/50", isSel && "bg-primary/5")}
          onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(row, e) : undefined}
        >
          {selectable && (
            <td className="px-3 py-2">
              <Checkbox
                checked={isSel}
                onChange={() => rowKey && toggleRow(rowKey(row))}
                role="checkbox"
                aria-checked={isSel}
                aria-label="Select row"
              />
            </td>
          )}
          {columns.map((c, ci) => (
            <td
              key={c.key}
              className={cn(
                "px-3",
                density === "compact" ? "py-1.5" : "py-2.5",
                ci === 0 && "font-medium",
                c.className,
              )}
            >
              {c.cell(row)}
            </td>
          ))}
        </tr>
      );
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {showSearch && (
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              prefix={<Search className="size-4 text-muted-foreground" aria-hidden />}
              suffix={
                server && isServerFetching ? (
                  <Loader2
                    className="size-3.5 text-muted-foreground animate-spin motion-reduce:hidden"
                    aria-hidden
                  />
                ) : (
                  <span className="size-3.5" aria-hidden />
                )
              }
              className="h-9"
            />
          </div>
        )}
        <div className="flex-1" />
        {showSelectionBar ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs">
            <span className="font-medium">{selectedRows.length} selected</span>
            {selectionToolbar(selectedRows, clearSelection)}
            <Button size="small" type="text" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        ) : (
          toolbar
        )}
      </div>
      <div className="rounded-xl border border-border bg-card elev-1 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b sticky top-0 z-10 bg-card/95 backdrop-blur text-left text-xs uppercase tracking-wide text-muted-foreground">
                {selectable && (
                  <th className="w-9 px-3 py-2">
                    <Checkbox
                      checked={!!allOnPageSelected}
                      onChange={toggleAllOnPage}
                      role="checkbox"
                      aria-checked={!!allOnPageSelected}
                      aria-label="Select all rows on this page"
                    />
                  </th>
                )}
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={cn("font-medium px-3 py-2", c.className)}
                    style={{ width: c.width }}
                  >
                    {isSortable(c) ? (
                      <button
                        onClick={() => toggleSort(c.key)}
                        aria-label={`Sort by ${typeof c.header === "string" ? c.header : c.key}`}
                        className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      >
                        {c.header}
                        <SortIcon sortKey={sortKey} columnKey={c.key} sortDir={sortDir} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{tbodyContent}</tbody>
          </table>
        </div>
        {paginate && total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>
                {`${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, total)} of ${total}`}
              </span>
              <span className="hidden sm:inline">·</span>
              <span className="hidden sm:inline">Rows per page</span>
              <Select
                value={String(pageSize)}
                onChange={(v) => setPageSize(Number(v))}
                className="w-[72px]"
                size="small"
                aria-label="Rows per page"
                options={pageSizeOptions.map((n) => ({ label: String(n), value: String(n) }))}
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-2">
                Page {safePage + 1} / {pages}
              </span>
              <Button
                type="default"
                variant="outlined"
                shape="circle"
                size="small"
                disabled={safePage === 0}
                onClick={() => setPage(0)}
                aria-label="First page"
              >
                <ChevronsLeft className="size-3.5" />
              </Button>
              <Button
                type="default"
                variant="outlined"
                shape="circle"
                size="small"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                type="default"
                variant="outlined"
                shape="circle"
                size="small"
                disabled={safePage >= pages - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                <ChevronRight className="size-3.5" />
              </Button>
              <Button
                type="default"
                variant="outlined"
                shape="circle"
                size="small"
                disabled={safePage >= pages - 1}
                onClick={() => setPage(pages - 1)}
                aria-label="Last page"
              >
                <ChevronsRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
