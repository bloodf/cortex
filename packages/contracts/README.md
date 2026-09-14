# @cortexos/contracts

> Shared typed contracts + Zod schemas for every CortexOS dashboard entity.
> The single source of truth for the wire shape between client and server.

This package is the result of M1-WS1 of the dashboard revamp. It is a
**leaf library** — no circular dependencies to other workspace packages,
no native bindings, one runtime dependency (`zod`).

## What it contains

| Module | Purpose |
|---|---|
| `primitives.ts` | Branded types (`UserId`, `ServiceId`, etc.) + reusable Zod primitive schemas (`zUuidV4`, `zSlug`, `zSha256`, …) |
| `query.ts` | `Page<T>` envelope, `PageInput`, `SortDir`, `Filter<T>`, cursor codec |
| `errors.ts` | Discriminated-union error model — every server response is one of `ValidationError`, `AuthRequired`, `PermissionDenied`, `NotFound`, `Conflict`, `RateLimit`, `ApprovalRequired`, `ApprovalExpired`, `ApprovalReplay`, `DependencyFailed`, `SystemError` |
| `audit.ts` | Hash-chained audit event shape + the canonical hash algorithm + `verifyChain` walker |
| `approval.ts` | HMAC-SHA256 confirmation tokens: `actionHashOf`, `issueApprovalToken`, `verifyApprovalToken` — single-use, 60s TTL, session-bound |
| `entities/*.ts` | Every domain entity: User, Session, Service, Badge, ServiceHealthSnapshot, UptimeStat, SystemData, NetworkData, ProcessInfo, DockerContainer/Image/Volume/Network/Action, IncusInstance/Image/Config/Shell, SystemdUnit/Action, AlertRule/Event, OperationalAlert, ApprovalRequest, DashboardCommandAudit, TerminalSession/Command, EnvLine/File, Project, NotificationEntry, BackupSnapshot, ScheduledJob, AppPreference, DashboardLayout, WidgetConfig, LogEntry, AIToolDefinition, AIRequest/Response, MailReview, Agent, AgentFile |
| `schemas/index.ts` | Re-export of every Zod schema, one path for mock handlers and server routes |
| `scripts/build-json-schemas.mjs` | Emits one `*.json` per schema to `dist/schemas-json/` for OpenAPI / MSW / contract tests |

## Versions

- `zod` 3.25.x (pinned; v3 is required by `zod-to-json-schema` 3.x, which
  has not been updated for zod v4's new `_def` shape)
- TypeScript 5.5+, strict mode, `noUncheckedIndexedAccess`
- Node 22+ (matches the rest of the monorepo)

## Quick start

```ts
import {
  ServiceSchema,
  ServiceInputSchema,
  PageInputSchema,
  buildPage,
  CortexErrorSchema,
  issueApprovalToken,
  verifyApprovalToken,
  actionHashOf,
  // …or import the types only
  type Service,
  type Page,
  type ServiceInput,
  type ApprovalClaims,
} from '@cortexos/contracts';
```

### SvelteKit — form actions

```ts
// src/routes/admin/services/+page.server.ts
import { ServiceInputSchema } from '@cortexos/contracts';
import type { Actions } from './$types';

export const actions: Actions = {
  create: async ({ request }) => {
    const form = await request.formData();
    const raw = Object.fromEntries(form.entries());
    const parsed = ServiceInputSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(400, { errors: parsed.error.flatten() });
    }
    const service = await db.services.insert(parsed.data);
    return { service };
  },
};
```

### SvelteKit — remote `query` for reads

```ts
// src/lib/server/queries/services.ts
import { query } from '$app/server';
import { ServiceSchema, PageInputSchema, buildPage } from '@cortexos/contracts';

export const listServices = query(async (input: unknown) => {
  const params = PageInputSchema.parse(input);
  const { rows, total } = await db.services.list(params);
  return buildPage(
    rows.map((r) => ServiceSchema.parse(r)),
    total,
    params,
    new Date().toISOString(),
  );
});
```

### SvelteKit — `+server.ts` returning a discriminated error

```ts
// src/routes/api/services/+server.ts
import { json } from '@sveltejs/kit';
import { CortexErrorSchema, NotFoundErrorSchema, httpStatusFor } from '@cortexos/contracts';

const service = await db.services.find(slug);
if (!service) {
  const err = NotFoundErrorSchema.parse({
    code: 'not_found',
    message: 'service not found',
    resource: 'service',
  });
  return json(CortexErrorSchema.parse(err), { status: httpStatusFor(err) });
}
return json({ service });
```

### Approval flow (THREAT_MODEL §3)

```ts
import {
  actionHashOf,
  issueApprovalToken,
  verifyApprovalToken,
  APPROVAL_TOKEN_HEADER,
  ApprovalClassSchema,
  deriveCortexSessionId, // server-only — see /api/ai/session-binding.ts in the existing app
} from '@cortexos/contracts';

// 1. Server: mint a token after the user types the confirmation phrase.
const actionHash = actionHashOf({ tool: 'systemd.restart', name: 'cortex-dashboard' });
const { token, expiresAt } = issueApprovalToken({
  actionHash,
  sessionId: deriveCortexSessionId(userId, sessionToken), // server-derived, never client-supplied
  userId,
  class: 'destructive',
  secret: process.env.CORTEX_CONFIRMATION_HMAC_SECRET!,
});

// 2. Client: re-issue the action with the token in the header.
await fetch(`/api/systemd/actions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    [APPROVAL_TOKEN_HEADER]: token, // 'x-cortex-approval-token'
  },
  body: JSON.stringify({ action: 'restart', name: 'cortex-dashboard' }),
});

// 3. Server: verify before dispatch. The token is single-use; after this
//    call the in-memory store returns false on `isLive(...)`.
const claims = verifyApprovalToken({
  token,
  expectedActionHash: actionHash,
  expectedSessionId,
  secret: process.env.CORTEX_CONFIRMATION_HMAC_SECRET!,
  isLive: (nonce) => store.has(nonce),
  markConsumed: (nonce) => store.delete(nonce),
});
if (!claims) return /* 403 / 409 / 410 — see errors.ts */;
```

### Hash-chained audit (THREAT_MODEL §6.4)

```ts
import {
  AuditEventSchema,
  payloadHashOf,
  nextChainHash,
  verifyChain,
  AUDIT_GENESIS_HASH,
} from '@cortexos/contracts';

// Server-side write: compute `payloadHash` and `currHash` from the previous row.
const prevRow = await db.auditLog.latest();
const payloadHash = payloadHashOf(payload);
const currHash = nextChainHash({
  prevId: prevRow?.id ?? 'genesis',
  prevPayloadHash: prevRow?.payload_hash ?? AUDIT_GENESIS_HASH,
  prevTsUnixMicros: prevRow?.ts_unix_micros ?? 0,
  prevCurrHash: prevRow?.curr_hash ?? null,
});
const event = AuditEventSchema.parse({
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  tsUnixMicros: Date.now() * 1000,
  surface: 'systemd',
  action: 'restart',
  actorUserId: userId,
  payload,
  payloadHash,
  prevHash: prevRow?.curr_hash ?? null,
  currHash,
});
await db.auditLog.insert(event);
```

## JSON Schema export

`pnpm run build` emits one `*.json` per schema into `dist/schemas-json/`,
plus an `index.json` registry. These are consumed by:

- **MSW handlers** — build a valid response body from the JSON shape.
- **`+server.ts` routes** — return a `Response` whose body passes the schema.
- **`pnpm run test:contract`** (per M0-F §8) — every route's response is
  parsed with the corresponding schema; a mismatch fails the build.

Example:

```ts
import userSchemaJson from '@cortexos/contracts/schemas-json/UserSchema.json' with { type: 'json' };
import Ajv from 'ajv';
const validate = new Ajv().compile(userSchemaJson);
const ok = validate(someResponseBody);
```

(Or use any other JSON-Schema validator; the output is Draft-07.)

## Build

```bash
pnpm run build          # tsc → dist/ + node scripts/build-json-schemas.mjs → dist/schemas-json/
pnpm run typecheck      # tsc --noEmit
pnpm run test           # vitest run
pnpm run test:coverage  # vitest run --coverage
pnpm run test:watch     # vitest (watch mode)
```

The build is a single-shot script — no daemon, no incremental cache. The
`dist/` is fully self-contained and ships with `package.json`'s `files`
field.

## Test discipline

- 241 tests across 6 files.
- ≥ 80 % line / statement / branch / function coverage (currently 99 %).
- Every entity schema has at least one **valid input** test, at least one
  **invalid input** test, and at least one **round-trip** test
  (`parse → JSON.stringify → parse`).
- The audit chain walker is tested with both a valid chain and a
  tampered one (returns the index of the first break).
- The approval flow is tested for: happy path, wrong action hash, wrong
  session id, wrong secret, expired, single-use replay, malformed token,
  missing dot separator.

## Boundaries

- **No native deps.** The package has no `authenticate-pam`, no `pg`,
  no `ssh2`. It is pure TypeScript + Zod + the Node `crypto` module
  (for the HMAC and hash chain).
- **No I/O.** The package reads no files, makes no network calls. The
  approval token store is the **caller's** concern — `verifyApprovalToken`
  takes `isLive` / `markConsumed` callbacks so the store can be in-memory
  (v1) or DB-backed (v1.1 per THREAT_MODEL D-01).
- **No business logic.** The package is contracts only. It is the shape
  between client and server, not the actions those shapes describe.

## Threat-model traceability

| Threat-model item | Where it lives in this package |
|---|---|
| SR-001 (cookie attrs) | n/a — cookie shape is in `SessionSchema`; the attrs are set by the server, not the contract |
| SR-003 (admin group) | `ADMIN_GROUP_NAME = 'cortexos-admin'` in `entities/user.ts` |
| SR-020 / SR-051 (terminal allowlist) | `IncusShellOpSchema`, `TerminalOpSchema` (closed enums) |
| SR-030 (name allowlist) | The regexes in `zSlug`, `DockerActionInputSchema.name`, `SystemdActionInputSchema.name`, `IncusInstanceSchema.name` — caller is expected to apply an allowlist in addition |
| SR-071 / SR-072 (env reveal / pre-write hash) | `EnvEditInputSchema.preWriteHash` |
| SR-090 (audit hash chain) | `audit.ts` (whole file) |
| SR-103 (signed policy.json) | n/a — the policy itself is out of scope; `AIPolicyClassSchema` is the contract for what the policy produces |
| SR-120 (approval flow) | `approval.ts` (whole file) |
| SR-121 (single-use) | `verifyApprovalToken` + `isLive` callback (caller owns the store) |
| SR-200 (rate-limit errors) | `RateLimitErrorSchema` with `retryAfter`, `windowSec`, `limit` |

## What this package is NOT

- **Not an ORM.** No database client, no query builder.
- **Not a service client.** No HTTP client; the wire format is the contract.
- **Not a mock server.** The MSW handlers (in `@cortexos/dashboard`) consume
  the JSON schemas; the contracts package is a passive dependency.

## License

MIT — see [`LICENSE`](../../LICENSE) at the repo root.
