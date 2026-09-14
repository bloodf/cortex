// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEnvValue } from "@/lib/api/env-browser.functions";

let dir: string;
let file: string;

const ORIGINAL = `# CortexOS env
# comment line
DB_HOST=127.0.0.1
DB_PASSWORD=oldsecret
EMPTY=
QUOTED="has spaces"

TRAILING=1
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envwrite-"));
  file = join(dir, ".env");
  writeFileSync(file, ORIGINAL, "utf-8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeEnvValue", () => {
  it("replaces only the target key and preserves every other line", async () => {
    const ok = await writeEnvValue(file, "DB_PASSWORD", "newsecret");
    expect(ok).toBe(true);
    const text = readFileSync(file, "utf-8");
    expect(text).toContain("DB_PASSWORD=newsecret");
    expect(text).toContain("DB_HOST=127.0.0.1");
    expect(text).toContain("# comment line");
    expect(text).toContain("TRAILING=1");
    // The comment count and other keys are untouched.
    expect(text.match(/^#/gm)?.length).toBe(2);
  });

  it("quotes values containing whitespace or shell-significant characters", async () => {
    await writeEnvValue(file, "DB_HOST", "a b$c");
    const text = readFileSync(file, "utf-8");
    expect(text).toContain('DB_HOST="a b$c"');
  });

  it("does not quote a simple value", async () => {
    await writeEnvValue(file, "DB_HOST", "db.internal");
    expect(readFileSync(file, "utf-8")).toContain("DB_HOST=db.internal");
  });

  it("returns false when the key is absent (no write)", async () => {
    const before = readFileSync(file, "utf-8");
    const ok = await writeEnvValue(file, "DOES_NOT_EXIST", "x");
    expect(ok).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("escapes embedded quotes when quoting", async () => {
    await writeEnvValue(file, "EMPTY", 'a"b');
    expect(readFileSync(file, "utf-8")).toContain('EMPTY="a\\"b"');
  });
});
