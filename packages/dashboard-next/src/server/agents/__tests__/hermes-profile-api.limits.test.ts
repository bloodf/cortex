// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HermesProfile } from "../registry";
import { chatWithAgent } from "../chat";

const state = vi.hoisted(() => ({ profile: undefined as HermesProfile | undefined }));
vi.mock("@/server/agents/registry", () => ({ findProfileBySlug: () => state.profile }));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "native-agent-chat-"));
  const secretPath = path.join(home, "runtime.env");
  fs.writeFileSync(secretPath, "HERMES_API_KEY=synthetic-test-key\n", { mode: 0o600 });
  state.profile = { profile: "example", home, secretPath, apiPort: 18800, runtime: "hermes" };
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("native agent chat attachments", () => {
  it("delivers native image content and ephemeral binary files without traversal", async () => {
    let staged: string | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const {content} = request.messages[0];
      const image = content.find((part: { type: string }) => part.type === "image_url");
      if (image?.image_url.url !== "data:image/png;base64,aW1hZ2U=") {
        return new Response("unsupported native image content", { status: 400 });
      }
      const dirs = fs.readdirSync(home).filter((name) => name.startsWith(".cortex-chat-"));
      expect(dirs).toHaveLength(1);
      staged = path.join(home, dirs[0]);
      expect(fs.statSync(staged).mode & 0o777).toBe(0o700);
      const filenames = fs.readdirSync(staged);
      expect(filenames).toHaveLength(1);
      const uploaded = path.join(staged, filenames[0]);
      expect(fs.statSync(uploaded).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(uploaded)).toEqual(Buffer.from([0, 1, 255]));
      expect(content.some((part: { text?: string }) => part.text?.includes(uploaded))).toBe(true);
      return Response.json({ choices: [{ message: { content: "received image and file" } }] });
    });
    const result = await chatWithAgent("example", { text: "inspect", attachments: [
      { filename: "picture.png", mime: "image/png", dataBase64: "aW1hZ2U=" },
      { filename: "../../escape.bin", mime: "application/octet-stream", dataBase64: "AAH/" },
    ] });
    expect(result.reply).toBe("received image and file");
    expect(fs.existsSync(staged!)).toBe(false);
  });

  it("cleans uploaded bytes when the native gateway fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection failed");
    });
    await expect(chatWithAgent("example", { text: "inspect", attachments: [
      { filename: "document.pdf", mime: "application/pdf", dataBase64: "YQ==" },
    ] })).rejects.toThrow();
    expect(fs.readdirSync(home)).toEqual(["runtime.env"]);
  });

  it("rejects malformed base64 before any gateway request or file creation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(chatWithAgent("example", { text: "inspect", attachments: [
      { filename: "bad.txt", mime: "text/plain", dataBase64: "YR==" },
    ] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual(["runtime.env"]);
  });

  it("does not follow a runtime-swapped staging path during cleanup", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "native-chat-outside-"));
    let victim: string | undefined;
    try {
      vi.stubGlobal("fetch", async () => {
        const name = fs.readdirSync(home).find((entry) => entry.startsWith(".cortex-chat-"))!;
        const dir = path.join(home, name);
        const filename = fs.readdirSync(dir)[0];
        victim = path.join(outside, filename);
        fs.writeFileSync(victim, "must survive");
        fs.renameSync(dir, `${dir}-moved`);
        fs.symlinkSync(outside, dir);
        return Response.json({ choices: [{ message: { content: "done" } }] });
      });
      await chatWithAgent("example", { text: "inspect", attachments: [
        { filename: "document.pdf", mime: "application/pdf", dataBase64: "YQ==" },
      ] });
      expect(fs.readFileSync(victim!, "utf8")).toBe("must survive");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects too many attachments without writing files", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(chatWithAgent("example", { text: "inspect", attachments: Array.from({ length: 9 }, () => ({
      filename: "a.txt", mime: "text/plain", dataBase64: "YQ==",
    })) })).rejects.toThrow();
    expect(fs.readdirSync(home)).toEqual(["runtime.env"]);
  });

  it("routes a raw OpenClaw model override without changing the agent target", async () => {
    state.profile!.runtime = "openclaw";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      if (request.model !== "openclaw/default" || headers.get("x-openclaw-model") !== "example/model") {
        return new Response("unknown agent target", { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "model selected" } }] });
    });
    expect((await chatWithAgent("example", { text: "hi", model: "example/model" })).reply).toBe("model selected");
  });
});
