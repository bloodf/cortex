import fs from "node:fs";
import path from "node:path";
import { dashboardPaths } from "@/server/paths";

export interface McpServerEntry {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  sources: string[];
}

interface RawMcpServer {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  type?: unknown;
}

function harnessHome(): string {
  return dashboardPaths().home;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addServer(
  merged: Map<string, McpServerEntry>,
  name: string,
  raw: unknown,
  source: string,
): void {
  const server = asRecord(raw) as RawMcpServer | null;
  if (!server) return;
  const url = typeof server.url === "string" ? server.url : undefined;
  const command = typeof server.command === "string" ? server.command : undefined;
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  let transport: McpServerEntry["transport"] = "stdio";
  if (url) {
    transport = server.type === "sse" ? "sse" : "http";
  }

  const existing = merged.get(name);
  if (existing) {
    existing.sources.push(source);
    if (!existing.url && url) existing.url = url;
    if (!existing.command && command) existing.command = command;
    if (!existing.args && args) existing.args = args;
    return;
  }

  merged.set(name, {
    name,
    transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(url ? { url } : {}),
    sources: [source],
  });
}

function collectMcpServers(
  merged: Map<string, McpServerEntry>,
  root: unknown,
  source: string,
): void {
  const obj = asRecord(root);
  const servers = asRecord(obj?.mcpServers);
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) addServer(merged, name, raw, source);
}

export function readMcpServers(): McpServerEntry[] {
  const home = harnessHome();
  const merged = new Map<string, McpServerEntry>();

  const claudeGlobalPath = path.join(home, ".claude.json");
  const claudeGlobal = readJson(claudeGlobalPath);
  collectMcpServers(merged, claudeGlobal, "Claude (global)");

  const projects = asRecord(asRecord(claudeGlobal)?.projects);
  if (projects) {
    for (const [projectPath, projectConfig] of Object.entries(projects)) {
      collectMcpServers(merged, projectConfig, `Claude project: ${projectPath}`);
    }
  }

  collectMcpServers(
    merged,
    readJson(path.join(home, ".claude", ".mcp.json")),
    "Claude (.mcp.json)",
  );
  collectMcpServers(merged, readJson(path.join(home, ".cursor", "mcp.json")), "Cursor");

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
