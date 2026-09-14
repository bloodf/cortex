/**
 * Query, pagination, sort, and filter conventions for CortexOS contracts.
 *
 * One consistent shape across every list endpoint. The `Page<T>` envelope is
 * what the SvelteKit server route returns; the `PageInput` is what the client
 * sends. `Filter<T>` is a discriminated union of comparison operators over the
 * fields of `T`.
 *
 * Design notes:
 * - The pagination is **cursor + offset hybrid** — `offset` for shallow pages
 *   (admin tables), `cursor` for stable infinite-scroll (alerts). The server
 *   honours whichever is provided.
 * - `SortDir` is a single-character enum (`"asc" | "desc"`) for terse URLs.
 * - The filter is intentionally restricted to a small set of operators so the
 *   SQL can be generated safely (no string interpolation of user input).
 *
 * @module
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export const SortDirSchema = z.enum(['asc', 'desc']);
export type SortDir = z.infer<typeof SortDirSchema>;

/** Default sort direction. */
export const DEFAULT_SORT_DIR: SortDir = 'asc';

/**
 * A single sort spec. The `field` is intentionally a `string` (not a literal
 * union) so the schema accepts unknown fields at runtime; the server is
 * expected to reject unknown fields against an allowlist. The client uses
 * `z.infer` to type the field names it knows about.
 */
export const SortSpecSchema = z.object({
  field: z.string().min(1).max(64),
  dir: SortDirSchema.default(DEFAULT_SORT_DIR),
});
export type SortSpec = z.infer<typeof SortSpecSchema>;

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Filter operators. The string-literal set is what the SQL generator is
 * allowed to emit. New operators require an explicit addition here AND a
 * matching branch in the SQL builder — do not add operator names ad-hoc.
 */
export const FilterOpSchema = z.enum([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'nin',
  'contains',
  'startsWith',
  'isNull',
  'isNotNull',
]);
export type FilterOp = z.infer<typeof FilterOpSchema>;

/**
 * A single filter clause. The `value` is `unknown` because the filter
 * operates over arbitrary field types (string, number, enum). The server is
 * expected to coerce per the field's declared type before building the SQL.
 */
export const FilterClauseSchema = z.object({
  field: z.string().min(1).max(64),
  op: FilterOpSchema,
  value: z.unknown().optional(),
});
export type FilterClause = z.infer<typeof FilterClauseSchema>;

/**
 * A filter is a list of AND-combined clauses. OR groups are not exposed at
 * this layer — if a route needs OR, the server builds a server-specific
 * filter and the client gets a narrower typed query.
 */
export const FilterSchema = z.array(FilterClauseSchema).max(32);
export type Filter = z.infer<typeof FilterSchema>;

// ---------------------------------------------------------------------------
// Page envelope (response)
// ---------------------------------------------------------------------------

/**
 * The page envelope returned by every list endpoint. The `data` field is
 * generic so each route can supply its own element type.
 */
export const PageSchema = <T extends z.ZodTypeAny>(item: T): z.ZodType<Page<z.infer<T>>> =>
  z.object({
    data: z.array(item),
    /** Total count of items matching the filter, ignoring limit/offset. */
    total: z.number().int().min(0),
    /** Echo of the limit used. */
    limit: z.number().int().min(1).max(1000),
    /** Echo of the offset used. */
    offset: z.number().int().min(0),
    /** Cursor for the next page; null when there are no more items. */
    nextCursor: z.string().min(1).max(256).nullable(),
    /** Timestamp the page was assembled (server clock, ISO-8601). */
    timestamp: z.string().datetime({ offset: true }),
  });
export interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Page input (request)
// ---------------------------------------------------------------------------

/**
 * Standard page input. Used by every list endpoint. The defaults match
 * the common case (first 50, no filter, no sort).
 */
export const PageInputSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
  /** Optional cursor (overrides offset when both are present). */
  cursor: z.string().min(1).max(256).optional(),
  sort: z.array(SortSpecSchema).max(4).default([]),
  filter: FilterSchema.default([]),
  /** Free-text search across the entity's indexed text fields. */
  q: z.string().min(0).max(256).optional(),
});
export type PageInput = z.infer<typeof PageInputSchema>;

/** Default page input. */
export const DEFAULT_PAGE_INPUT: PageInput = {
  limit: 50,
  offset: 0,
  sort: [],
  filter: [],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next offset for a page. Returns `null` when the next page
 * would be empty (i.e. `offset + limit >= total`).
 */
export const nextOffset = (page: {
  offset: number;
  limit: number;
  total: number;
}): number | null => {
  const consumed = page.offset + page.limit;
  return consumed >= page.total ? null : consumed;
};

/**
 * Build a `Page<T>` from a raw list + total count, computing the
 * `nextCursor` for the caller. The cursor is opaque; clients should treat
 * it as a string. We use `nextOffset` encoded as base64 to keep cursors
 * stable across small reorderings (cursor consumers should fall back to
 * offset on cursor-not-found).
 */
const encodeCursor = (state: { offset: number }): string => {
  // Base64-URL-encode a tiny JSON. Stable, no new dep.
  const json = JSON.stringify(state);
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(json, 'utf8').toString('base64url')
      : btoa(json).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64;
};

export const buildPage = <T>(
  data: T[],
  total: number,
  input: PageInput,
  nowIso: string,
): Page<T> => {
  const { limit } = input;
  const { offset } = input;
  const next = nextOffset({ offset, limit, total });
  const nextCursor = next === null ? null : encodeCursor({ offset: next });
  return {
    data,
    total,
    limit,
    offset,
    nextCursor,
    timestamp: nowIso,
  };
};

/** Decode a cursor produced by `encodeCursor`. Returns `null` on parse fail. */
export const decodeCursor = (cursor: string): { offset: number } | null => {
  try {
    const pad = '='.repeat((4 - (cursor.length % 4)) % 4);
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const json =
      typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('utf8') : atob(b64);
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'offset' in parsed &&
      typeof parsed.offset === 'number'
    ) {
      return { offset: (parsed as { offset: number }).offset };
    }
    return null;
  } catch {
    return null;
  }
};
