// @vitest-environment node
/**
 * readAgentFiles tests — the recursive reader behind the Inspect dialog.
 *
 * The dialog must surface an agent's human-readable config WITHOUT ever leaking
 * credentials. These tests pin the security contract that makes that safe:
 *   - recurses into nested config dirs and returns text files;
 *   - NEVER descends into secret dirs (mcp-tokens, secrets, auth, …);
 *   - NEVER reads credential-named files (channel_directory.json, *token*, .env);
 *   - skips hidden files, binaries (NUL byte / binary extensions), and oversized
 *     files;
 *   - redacts credential-shaped substrings that slip through in otherwise-safe
 *     files (defense in depth);
 *   - returns [] for a missing home instead of throwing.
 *
 * A regression that re-enabled any secret path would fail here — these are the
 * tests that would have caught a leak before it shipped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readAgentFiles } from "@/server/agents/files";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, data: string | Buffer): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

describe("readAgentFiles", () => {
  it("returns [] for a non-existent home without throwing", () => {
    expect(readAgentFiles(path.join(home, "nope"))).toEqual([]);
  });

  it("reads top-level and nested text files, sorted by path", () => {
    write("config.yaml", "profile: x\n");
    write("AGENTS.md", "# agents\n");
    write("sub/nested.json", '{"a":1}\n');

    const files = readAgentFiles(home);
    const paths = files.map((f) => f.path);

    expect(paths).toEqual(["AGENTS.md", "config.yaml", "sub/nested.json"]);
    expect(files.find((f) => f.path === "config.yaml")?.content).toBe("profile: x\n");
    expect(files.find((f) => f.path === "config.yaml")?.language).toBe("yaml");
    expect(files.find((f) => f.path === "sub/nested.json")?.language).toBe("json");
  });

  it("never descends into secret directories", () => {
    write("config.yaml", "ok\n");
    write("mcp-tokens/granola.json", '{"access_token":"super-secret-value-123456"}\n');
    write("secrets/db.yaml", "password: hunter2hunter2\n");
    write("auth/oauth.json", '{"refresh_token":"abcdefabcdefabcdef"}\n');

    const paths = readAgentFiles(home).map((f) => f.path);

    expect(paths).toEqual(["config.yaml"]);
    expect(paths.some((p) => p.includes("mcp-tokens"))).toBe(false);
    expect(paths.some((p) => p.includes("secret"))).toBe(false);
    expect(paths.some((p) => p.includes("auth"))).toBe(false);
  });

  it("skips secret-shaped dirs regardless of hyphen/underscore variant", () => {
    write("config.yaml", "ok\n");
    write("mcp_tokens/x.json", '{"access_token":"aaaaaaaaaaaaaaaa"}\n');
    write("oauth-store/y.json", '{"refresh_token":"bbbbbbbbbbbbbbbb"}\n');
    write("api-keys/z.json", '{"api_key":"cccccccccccccccc"}\n');
    write("credentials/c.yaml", "password: dddddddddddddddd\n");

    expect(readAgentFiles(home).map((f) => f.path)).toEqual(["config.yaml"]);
  });

  it("never reads credential-named files even outside secret dirs", () => {
    write("config.yaml", "ok\n");
    write("channel_directory.json", '{"chat":"123"}\n');
    write("my-token.json", '{"t":"x"}\n');
    write(".env", "SECRET=1\n");
    write("api_key.txt", "abc\n");

    const paths = readAgentFiles(home).map((f) => f.path);

    expect(paths).toEqual(["config.yaml"]);
  });

  it("skips hidden files, binary extensions, and binary content", () => {
    write("config.yaml", "ok\n");
    write(".update_check", "hidden\n");
    write("state.db", "sqlitebinary\n");
    write("avatar.png", "pngdata\n");
    write("blob.txt", Buffer.from([0x68, 0x00, 0x69])); // NUL byte → binary

    const paths = readAgentFiles(home).map((f) => f.path);

    expect(paths).toEqual(["config.yaml"]);
  });

  it("skips files larger than the per-file cap", () => {
    write("config.yaml", "ok\n");
    write("huge.md", "x".repeat(300 * 1024)); // > 256 KiB

    const paths = readAgentFiles(home).map((f) => f.path);

    expect(paths).toEqual(["config.yaml"]);
  });

  it("redacts credential-shaped substrings that slip through in safe files", () => {
    write(
      "config.yaml",
      `${[
        "telegram: 1234567890:AABBccddeeffgghhiijjkkllmmnnooppqqrr",
        "github: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "openai_key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        "header: Bearer abcdefghijklmnopqrstuvwxyz123456",
        "note: a normal line stays intact",
      ].join("\n")  }\n`,
    );

    const content = readAgentFiles(home).find((f) => f.path === "config.yaml")?.content ?? "";

    expect(content).not.toContain("1234567890:AABB");
    expect(content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(content).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("Bearer [REDACTED]");
    expect(content).toContain("a normal line stays intact");
  });
});
