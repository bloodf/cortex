// @vitest-environment node
/**
 * dependency-scan tests — compose parsing, ss parsing, and failure safety.
 *
 * Linux-agnostic: the probe layer (exec + compose reads) is injected via
 * `setScanDepsForTests`, and the shared db client is vi.mock'ed so no
 * Postgres is needed. Mirrors the seam style of systemd.test.ts
 * (`setExecutorForTests`), plus a module mock for the DB write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseComposeEdges,
  parseSsEdges,
  scanDependencies,
  setScanDepsForTests,
  type ScanDeps,
} from "@/server/system/dependency-scan";

const dbExecute = vi.fn<(query: unknown) => Promise<{ rowCount: number }>>();

vi.mock("@/server/db/client", () => ({
  db: { execute: (query: unknown) => dbExecute(query) },
}));

const SAMPLE_COMPOSE = `name: hindsight

services:
  api:
    container_name: hindsight-api
    image: ghcr.io/vectorize-io/hindsight:latest
    depends_on:
      - redis
    environment:
      PORT: 3000
      HINDSIGHT_DSN: postgres://hindsight:pw@127.0.0.1:5432/hindsight
    ports:
      - "127.0.0.1:8888:8888"
`;

const SAMPLE_COMPOSE_MAP_FORM = `services:
  api:
    container_name: firecrawl-api
    depends_on:
      redis:
        condition: service_started
      nuq-postgres:
        condition: service_healthy
    environment:
      REDIS_URL: redis://firecrawl-redis:6379/0
      OPENAI_BASE_URL: http://durindoor:20128/v1
`;

const SAMPLE_SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096      127.0.0.1:20128       0.0.0.0:*
LISTEN 0      4096      127.0.0.1:6379        0.0.0.0:*
ESTAB  0      0         192.0.2.4:55128      127.0.0.1:20128 users:(("node",pid=4242,fd=23))
ESTAB  0      0         192.0.2.4:55140      127.0.0.1:6379  users:(("node",pid=4242,fd=24))
ESTAB  0      0         192.0.2.4:55150      127.0.0.1:5432  users:(("node",pid=9999,fd=9))
`;

function makeDeps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    exec: async () => ({ stdout: "", stderr: "" }),
    readComposeFiles: async () => [],
    ...overrides,
  };
}

beforeEach(() => {
  dbExecute.mockReset();
  dbExecute.mockResolvedValue({ rowCount: 0 });
});

afterEach(() => {
  setScanDepsForTests(null);
});

// ---------------------------------------------------------------------------
// parseComposeEdges
// ---------------------------------------------------------------------------

describe("parseComposeEdges", () => {
  it("maps a list-form depends_on to a configured edge", () => {
    const edges = parseComposeEdges("hindsight/docker-compose.yml", SAMPLE_COMPOSE);
    expect(edges).toContainEqual({
      source_slug: "hindsight",
      target_slug: "redis",
      detail: "hindsight/docker-compose.yml: api depends_on redis",
    });
  });

  it("maps env values pointing at known host ports", () => {
    const edges = parseComposeEdges("hindsight/docker-compose.yml", SAMPLE_COMPOSE);
    expect(edges).toContainEqual({
      source_slug: "hindsight",
      target_slug: "postgresql",
      detail: "hindsight/docker-compose.yml: api env references postgresql",
    });
  });

  it("maps map-form depends_on, folds firecrawl private infra, and drops self-edges", () => {
    const edges = parseComposeEdges("firecrawl/docker-compose.yml", SAMPLE_COMPOSE_MAP_FORM);
    // redis / nuq-postgres are firecrawl's own infra → self-edge → filtered.
    expect(edges.some((e) => e.source_slug === "firecrawl" && e.target_slug === "firecrawl")).toBe(
      false,
    );
    expect(edges).toContainEqual({
      source_slug: "firecrawl",
      target_slug: "durindoor",
      detail: "firecrawl/docker-compose.yml: api env references durindoor",
    });
  });

  it("attributes generic service names via container_name, then stack dir", () => {
    // No container_name, service name unmapped → falls back to stack dir.
    const byStack = parseComposeEdges(
      "hindsight/docker-compose.yml",
      `services:\n  api:\n    depends_on:\n      - redis\n`,
    );
    expect(byStack).toContainEqual({
      source_slug: "hindsight",
      target_slug: "redis",
      detail: "hindsight/docker-compose.yml: api depends_on redis",
    });
  });

  it("does not treat REDIS_URL-style env strings as yaml maps", () => {
    // The env LIST form (`- KEY=value`) is the dangerous shape; verify the
    // port inside the value still maps and nothing bogus comes out.
    const listForm = `services:\n  api:\n    environment:\n      - REDIS_URL=redis://cortex-redis:6379/0\n`;
    const listEdges = parseComposeEdges("langfuse/docker-compose.yml", listForm);
    expect(listEdges).toEqual([
      {
        source_slug: "langfuse",
        target_slug: "redis",
        detail: "langfuse/docker-compose.yml: api env references redis",
      },
    ]);
    // Map form of the same shape on a selected service file: container_name-less,
    // so consumer attribution falls back to the stack dir.
    const mapForm = `services:\n  api:\n    environment:\n      REDIS_URL: redis://cortex-redis:6379/0\n`;
    const edges = parseComposeEdges("langfuse/docker-compose.yml", mapForm);
    expect(edges).toEqual([
      {
        source_slug: "langfuse",
        target_slug: "redis",
        detail: "langfuse/docker-compose.yml: api env references redis",
      },
    ]);
  });

  it("skips services and refs with no catalog slug", () => {
    const edges = parseComposeEdges(
      "unknown/docker-compose.yml",
      `services:\n  mystery-box:\n    depends_on:\n      - redis\n`,
    );
    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSsEdges
// ---------------------------------------------------------------------------

describe("parseSsEdges", () => {
  it("maps a LISTEN port to its provider slug", () => {
    const edges = parseSsEdges(SAMPLE_SS, { pidToSlug: new Map([[4242, "hindsight"]]) });
    expect(edges).toContainEqual({
      source_slug: "hindsight",
      target_slug: "durindoor",
      detail: "ss: connection to port 20128",
    });
    expect(edges).toContainEqual({
      source_slug: "hindsight",
      target_slug: "redis",
      detail: "ss: connection to port 6379",
    });
  });

  it("falls back to PORT_TO_SLUG when the LISTEN row is absent", () => {
    // 5432 never appears as LISTEN in SAMPLE_SS — production ss -tnp often
    // omits LISTEN sockets; the static map must still resolve it.
    const edges = parseSsEdges(SAMPLE_SS, { pidToSlug: new Map([[9999, "hindsight"]]) });
    expect(edges).toContainEqual({
      source_slug: "hindsight",
      target_slug: "postgresql",
      detail: "ss: connection to port 5432",
    });
  });

  it("resolves the inbound half of a socket via the local service port", () => {
    // Server-side ESTAB row: local = service port, peer = client ephemeral.
    // The provider must resolve from the local port too, or host-visible
    // half of every connection is silently dropped.
    const inbound = [
      "State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port  Process",
      'ESTAB 0      0       172.17.0.1:5432     172.17.0.9:44812   users:(("postgres",pid=7777,fd=21))',
      'LISTEN 0      4096    0.0.0.0:5432        0.0.0.0:*           users:(("postgres",pid=7777,fd=3))',
    ].join("\n");
    const edges = parseSsEdges(inbound, { pidToSlug: new Map([[7777, "pg-exporter"]]) });
    expect(edges).toEqual([
      {
        source_slug: "pg-exporter",
        target_slug: "postgresql",
        detail: "ss: connection to port 5432",
      },
    ]);
  });

  it("attributes consumers by endpoint IP when pids do not intersect (rootless docker)", () => {
    // Under rootless docker, ss pids live in a user namespace and never
    // match docker inspect host pids — pidToSlug is empty. The bridge IP
    // of the consumer container is the only reliable attribution.
    const bridge = [
      "State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port  Process",
      "ESTAB 0      0       172.18.0.3:51024    172.18.0.2:5432",
      "ESTAB 0      0       172.18.0.3:51025    172.18.0.2:5432",
    ].join("\n");
    const edges = parseSsEdges(bridge, {
      pidToSlug: new Map(),
      ipToSlug: new Map([
        ["172.18.0.3", "pg-exporter"],
        ["172.18.0.2", "postgresql"],
      ]),
    });
    expect(edges).toEqual([
      {
        source_slug: "pg-exporter",
        target_slug: "postgresql",
        detail: "ss: connection to port 5432",
      },
    ]);
  });

  it("skips unattributed pids and self-connections only", () => {
    const pidToSlug = new Map([
      [4242, "durindoor"], // self-edge to 20128 dropped; edge to redis kept
      // pid 9999 unattributed → its 5432 connection dropped
    ]);
    const edges = parseSsEdges(SAMPLE_SS, { pidToSlug });
    expect(edges).toEqual([
      {
        source_slug: "durindoor",
        target_slug: "redis",
        detail: "ss: connection to port 6379",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// scanDependencies — end to end with injected probes + mocked db
// ---------------------------------------------------------------------------

describe("scanDependencies", () => {
  it("upserts configured and observed edges and reports the affected row count", async () => {
    dbExecute.mockResolvedValue({ rowCount: 3 });
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => [
          { path: "/opt/cortex/stacks/hindsight/docker-compose.yml", content: SAMPLE_COMPOSE },
        ],
        exec: async (file, args) => {
          if (file === "/usr/bin/ss") return { stdout: SAMPLE_SS, stderr: "" };
          if (args[0] === "ps") return { stdout: "hindsight-api\n", stderr: "" };
          if (args[0] === "inspect") return { stdout: "4242 172.18.0.3\n", stderr: "" };
          throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
        },
      }),
    );

    const result = await scanDependencies();

    const byKey = new Map(
      result.edges.map((e) => [`${e.source_slug} ${e.target_slug} ${e.kind}`, e]),
    );
    expect(byKey.get("hindsight redis configured")?.source).toBe("detected");
    expect(byKey.get("hindsight postgresql configured")?.source).toBe("detected");
    expect(byKey.get("hindsight durindoor observed")).toMatchObject({
      source: "detected",
      detail: "ss: connection to port 20128",
    });
    expect(result.upserted).toBe(3);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("never throws when exec fails — returns configured edges only", async () => {
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => [
          { path: "/opt/cortex/stacks/hindsight/docker-compose.yml", content: SAMPLE_COMPOSE },
        ],
        exec: async () => {
          throw new Error("ss: command not found");
        },
      }),
    );

    const result = await scanDependencies();

    expect(result.edges.map((e) => e.kind)).toEqual(["configured", "configured"]);
    expect(result.edges.every((e) => e.source === "detected")).toBe(true);
    expect(
      result.edges.some((e) => e.source_slug === "hindsight" && e.target_slug === "redis"),
    ).toBe(true);
  });

  it("survives a failing compose dir read without losing other edges", async () => {
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => {
          throw new Error("EACCES: permission denied");
        },
        exec: async (file, args) => {
          if (file === "/usr/bin/ss") return { stdout: SAMPLE_SS, stderr: "" };
          if (args[0] === "ps") return { stdout: "hindsight-api\n", stderr: "" };
          if (args[0] === "inspect") return { stdout: "4242 172.18.0.3\n", stderr: "" };
          throw new Error("boom");
        },
      }),
    );

    const result = await scanDependencies();
    expect(result.edges).toEqual([
      {
        source_slug: "hindsight",
        target_slug: "durindoor",
        kind: "observed",
        source: "detected",
        detail: "ss: connection to port 20128",
      },
      {
        source_slug: "hindsight",
        target_slug: "redis",
        kind: "observed",
        source: "detected",
        detail: "ss: connection to port 6379",
      },
    ]);
  });

  it("dedupes repeated edges so the multi-row INSERT never touches one row twice", async () => {
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => [
          { path: "/opt/cortex/stacks/hindsight/docker-compose.yml", content: SAMPLE_COMPOSE },
          // Same edge from a second file (different detail) — must collapse.
          { path: "/opt/cortex/stacks/other/docker-compose.yml", content: SAMPLE_COMPOSE },
        ],
      }),
    );

    const result = await scanDependencies();
    const configured = result.edges.filter((e) => e.kind === "configured");
    expect(configured).toHaveLength(2); // redis + postgresql, each once
  });

  it("skips the db write entirely when no edges were found", async () => {
    setScanDepsForTests(makeDeps());
    const result = await scanDependencies();
    expect(result).toEqual({ upserted: 0, edges: [] });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("honors the protected-row rowCount contract (seed/manual conflicts count 0)", async () => {
    // SQL-level protection: DO UPDATE … WHERE source NOT IN ('seed','manual').
    // The scanner must report the REAL affected-row count, not edges.length.
    dbExecute.mockResolvedValue({ rowCount: 1 });
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => [
          { path: "/opt/cortex/stacks/hindsight/docker-compose.yml", content: SAMPLE_COMPOSE },
        ],
      }),
    );

    const result = await scanDependencies();
    expect(result.edges).toHaveLength(2);
    expect(result.upserted).toBe(1);
  });

  it("never throws when the db write fails — returns edges with upserted 0", async () => {
    dbExecute.mockRejectedValue(new Error("connection reset"));
    setScanDepsForTests(
      makeDeps({
        readComposeFiles: async () => [
          { path: "/opt/cortex/stacks/hindsight/docker-compose.yml", content: SAMPLE_COMPOSE },
        ],
      }),
    );

    const result = await scanDependencies();
    expect(result.upserted).toBe(0);
    expect(result.edges).toHaveLength(2);
  });
});
