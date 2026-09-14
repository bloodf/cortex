/**
 * Native Hermes/OpenClaw agent chat bridge.
 *
 * Images use OpenAI image_url content parts. Other uploads are staged inside
 * the selected profile home and referenced as local files for agent tools.
 * No unsupported legacy attachments or reasoning fields are sent upstream.
 * Hermes contract: gateway/platforms/api_server.py at
 * NousResearch/hermes-agent 345cd2b057a452236de401d3534b8502a7465e8d.
 * OpenClaw contract: https://docs.openclaw.ai/gateway/openai-http-api.
 * Hermes installation must enable direct_model_requests for body model overrides.
 *
 * The dashboard transport (ADR-001) is createServerFn RPC and cannot stream,
 * so this bridge is request/response: it returns the full assistant reply.
 * Streaming lives in the P3 WS sidecar.
 *
 * Auth: the profile API validates `Authorization: Bearer <HERMES_API_KEY>`,
 * sourced from the profile's secret env file (`secretPath` in the registry).
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findProfileBySlug } from "@/server/agents/registry";
import { notFoundError, systemError } from "@/server/errors/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAttachment {
  filename: string;
  mime: string;
  dataBase64: string;
}

export interface ChatWithAgentInput {
  text: string;
  attachments?: AgentAttachment[];
  model?: string;
  reasoning?: "low" | "medium" | "high";
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatWithAgentResult {
  reply: string;
  /** Token usage if the profile API reported it (OpenAI-style `usage`). */
  usage?: ChatUsage;
  /** Wall-clock time of the profile API round-trip, in milliseconds. */
  latencyMs: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ---------------------------------------------------------------------------
// Env-file reader (shared by chat + model swap)
// ---------------------------------------------------------------------------

/**
 * Read a single `KEY=value` from a dotenv-style env file. Returns `null` if
 * the file is missing or the key is absent. Honors `#` comments and strips a
 * leading `export `. Surrounding matched quotes are removed.
 *
 * Exported so P1.3 (`setAgentModel`) can reuse it for HERMES_MODEL/REASONING.
 * Never logs values — these files hold secrets.
 */
export function readEnvValue(filePath: string, key: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const deexported = trimmed.replace(/^export\s+/, "");
    const eq = deexported.indexOf("=");
    if (eq <= 0) continue;
    const k = deexported.slice(0, eq).trim();
    if (k !== key) continue;
    let v = deexported.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// chatWithAgent — POST /v1/chat/completions to the profile API
// ---------------------------------------------------------------------------

/**
 * Send a chat turn (text + optional attachments + optional model override) to
 * a Hermes profile's local API and return the assistant reply.
 *
 * Throws:
 *   - `notFoundError` if the slug is not in the registry
 *   - `systemError`   if the profile has no port/secret, the API returns
 *                      non-200 / is unreachable, or attachments are rejected
 */
export async function chatWithAgent(
  slug: string,
  input: ChatWithAgentInput,
): Promise<ChatWithAgentResult> {
  const profile = findProfileBySlug(slug);
  if (!profile) {
    throw notFoundError(`agent '${slug}' is not a known profile`, "agent");
  }
  if (!profile.apiPort) {
    throw systemError(`profile '${slug}' has no apiPort`);
  }
  if (!profile.secretPath) {
    throw systemError(`profile '${slug}' has no secretPath`);
  }
  const key = readEnvValue(profile.secretPath, "HERMES_API_KEY");
  if (!key) {
    throw systemError(`HERMES_API_KEY missing in ${profile.secretPath}`);
  }

  const runtime = profile.runtime ?? "hermes";
  if (runtime === "openclaw" && input.reasoning) {
    throw systemError("OpenClaw chat completions does not support per-request reasoning; configure the agent reasoning default instead");
  }
  const attachments = input.attachments ?? [];
  if (attachments.length > 8) throw systemError("too_many_attachments");
  const maxBytes = 25 * 1024 * 1024;
  let totalBytes = 0;
  const decoded = attachments.map((attachment) => {
    if (!attachment.filename || attachment.filename.length > 255 ||
      !/^[a-zA-Z0-9!#$&+.^_-]+\/[a-zA-Z0-9!#$&+.^_*-]+$/.test(attachment.mime) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.dataBase64)) {
      throw systemError("bad_attachment");
    }
    let paddingBytes = 0;
    if (attachment.dataBase64.endsWith("==")) paddingBytes = 2;
    else if (attachment.dataBase64.endsWith("=")) paddingBytes = 1;
    const estimatedBytes = attachment.dataBase64.length / 4 * 3 - paddingBytes;
    totalBytes += estimatedBytes;
    if (totalBytes > maxBytes) throw systemError("attachments_too_large");
    const data = Buffer.from(attachment.dataBase64, "base64");
    if (data.toString("base64") !== attachment.dataBase64) throw systemError("bad_attachment");
    return { attachment, data };
  });

  let stagingDir: string | undefined;
  let stagingFd: number | undefined;
  let stagingHome: string | undefined;
  let stagingOwner: fs.Stats | undefined;
  const stagedNames: string[] = [];
  let outcome: { result: ChatWithAgentResult } | { error: unknown };
  try {
    const content: ({ type: "text"; text: string } | {
      type: "image_url"; image_url: { url: string };
    })[] = [{ type: "text", text: input.text }];
    for (const { attachment, data } of decoded) {
      if (/^image\/(?:png|jpeg|gif|webp|heic|heif)$/.test(attachment.mime)) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${attachment.mime};base64,${attachment.dataBase64}` },
        });
      } else {
        if (!stagingDir) {
          stagingHome = fs.realpathSync(profile.home);
          stagingOwner = fs.statSync(stagingHome);
          stagingDir = fs.mkdtempSync(path.join(stagingHome, ".cortex-chat-"));
          stagingFd = fs.openSync(stagingDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          const created = fs.fstatSync(stagingFd);
          if (created.uid !== process.getuid?.() || (created.mode & 0o777) !== 0o700) {
            throw systemError("unsafe attachment staging directory");
          }
        }
        const extension = path.extname(attachment.filename);
        const name = randomUUID() + (/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : "");
        // Hold the directory inode across writes: a runtime-owned home can
        // rename children. Never follow its replacement path as root.
        const fd = fs.openSync(`/proc/self/fd/${stagingFd}/${name}`,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        stagedNames.push(name);
        try {
          fs.writeFileSync(fd, data);
          fs.fchownSync(fd, stagingOwner!.uid, stagingOwner!.gid);
        } finally {
          fs.closeSync(fd);
        }
        const target = path.join(stagingDir, name);
        content.push({
          type: "text",
          text: `Attached local file ${JSON.stringify(attachment.filename)} (${attachment.mime}): ${JSON.stringify(target)}. Use your file tools to inspect it if needed; its contents have not been read into this message. Available only during this request.`,
        });
      }
    }
    if (stagingDir && stagingFd !== undefined) {
      const held = fs.fstatSync(stagingFd);
      const current = fs.lstatSync(stagingDir);
      if (current.dev !== held.dev || current.ino !== held.ino ||
        fs.realpathSync(stagingDir) !== stagingDir || path.dirname(stagingDir) !== stagingHome) {
        throw systemError("attachment staging directory changed");
      }
      fs.fchownSync(stagingFd, stagingOwner!.uid, stagingOwner!.gid);
    }
    const body = JSON.stringify({
      messages: [{ role: "user", content: attachments.length ? content : input.text }],
      model: runtime === "openclaw" ? "openclaw/default" : input.model,
      model_options: runtime === "hermes" && input.reasoning
        ? { reasoning: { enabled: true, effort: input.reasoning } }
        : undefined,
      stream: false,
    });
    // Native API limits apply to inline image JSON, not staged binary uploads.
    if (Buffer.byteLength(body) > (runtime === "hermes" ? 10_000_000 : 20 * 1024 * 1024)) {
      throw systemError("attachments_too_large");
    }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${profile.apiPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(runtime === "openclaw" && input.model ? { "x-openclaw-model": input.model } : {}),
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown error";
    throw systemError(`profile API for '${slug}' unreachable: ${detail}`);
  }

  if (res.status === 413) {
    throw systemError(`profile API for '${slug}': attachments_too_large`);
  }
  if (res.status === 400) {
    const err = await safeJson(res);
    throw systemError(
      `profile API for '${slug}': ${err?.error === "bad_attachment" ? "bad_attachment" : "bad_request"}`,
    );
  }
  if (!res.ok) {
    throw systemError(`profile API for '${slug}' returned ${res.status}`);
  }

  const data = (await safeJson(res)) as ChatCompletionResponse | null;
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (reply === undefined || reply === "") {
    throw systemError(`profile API for '${slug}' returned an empty or malformed completion`);
  }
  const latencyMs = Date.now() - startedAt;
  const u = data?.usage;
  const usage: ChatUsage | undefined =
    u && (u.prompt_tokens != null || u.completion_tokens != null || u.total_tokens != null)
      ? {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        }
      : undefined;
  outcome = { result: { reply, usage, latencyMs } };
  } catch (error) {
    outcome = { error };
  }
  if (stagingFd !== undefined) {
    // Preserve the request's failure, or the first cleanup failure, while
    // attempting every unlink and always closing the held directory.
    for (const name of stagedNames) {
      try {
        // Never traverse a replacement tree the agent can modify.
        fs.unlinkSync(`/proc/self/fd/${stagingFd}/${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !("error" in outcome)) {
          outcome = { error };
        }
      }
    }
    try {
      const held = fs.fstatSync(stagingFd);
      const current = stagingDir && fs.lstatSync(stagingDir, { throwIfNoEntry: false });
      if (current && current.dev === held.dev && current.ino === held.ino) fs.rmdirSync(stagingDir!);
    } catch (error) {
      if (!("error" in outcome)) outcome = { error };
    }
    try {
      fs.closeSync(stagingFd);
    } catch (error) {
      if (!("error" in outcome)) outcome = { error };
    }
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}
