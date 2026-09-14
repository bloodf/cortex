/**
 * Regression guard: paste-to-attach, drag-drop-to-attach, and
 * attachment-only submit on /agents/$slug/chat.
 *
 * Renders ChatPage directly with useParams/useNavigate stubbed so no TanStack
 * router tree is needed — avoids the id+path conflict that createRoute throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactRouter from "@tanstack/react-router";
import { UIProvider } from "@/hooks/ui-provider";

// ---------------------------------------------------------------------------
// Lazy imports after vi.mock
// ---------------------------------------------------------------------------
import { callAgentChat, api } from "@/lib/api/client";
import { ChatPage } from "@/routes/_authenticated.agents.$slug.chat";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof ReactRouter>("@tanstack/react-router");
  return {
    ...actual,
    useParams: () => ({ slug: "test-agent" }),
    useNavigate: () => vi.fn(),
     
    Link: ({ to, children, ...props }: any) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { username: "admin", is_admin: true }, loading: false }),
}));

vi.mock("@/lib/api/client", () => ({
  callAgentChat: vi.fn(),
  callSetAgentModel: vi.fn(),
  callMintApproval: vi.fn(),
  api: { agents: vi.fn() },
  csrfHeaders: () => ({}),
}));

// ---------------------------------------------------------------------------
// Stub agent
// ---------------------------------------------------------------------------
const STUB_AGENT = {
  slug: "test-agent",
  name: "Test Agent",
  description: "A test agent",
  state: "idle" as const,
  model: "claude-sonnet-4",
  modelProvider: "anthropic",
  health: "healthy" as const,
  hermesUrl: "https://hermes.example.com/test-agent",
  uptimeSec: 0,
  queueDepth: 0,
  requestsPerMin: 0,
  errorRatePct: 0,
  p95LatencyMs: 0,
  lastActivity: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Render helper — no router tree required
// ---------------------------------------------------------------------------
function renderChatPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UIProvider>
        <ChatPage />
      </UIProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Utility — FileList-shaped value from an array of Files.
// readAttachments() only needs Array.from()-ability + index access + .length.
// ---------------------------------------------------------------------------
function makeFileList(files: File[]): FileList {
  return Object.assign([...files], {
    item: (i: number) => files[i] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ChatPage — paste + drop attachments", () => {
  beforeEach(() => {
    vi.mocked(api.agents).mockResolvedValue([STUB_AGENT]);
    vi.mocked(callAgentChat).mockResolvedValue({
      slug: "test-agent",
      reply: "pong",
      latencyMs: 42,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pasting a file into the textarea shows an AttachmentChip preview", async () => {
    const user = userEvent.setup();
    const { container } = renderChatPage();

    // Wait for agent to load and composer to appear.
    const textarea = await waitFor(() => {
      const el = container.querySelector("textarea");
      expect(el).toBeTruthy();
      return el!;
    });

    // text/plain → AttachmentChip renders filename in textContent (not image).
    const file = new File(["hello"], "pasted.txt", { type: "text/plain" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: makeFileList([file]), items: [] },
    });
    fireEvent(textarea, paste);

    await waitFor(() => expect(container.textContent).toContain("pasted.txt"));
  });

  it("dropping a file on the composer wrapper shows an AttachmentChip preview", async () => {
    const user = userEvent.setup();
    const { container } = renderChatPage();

    await waitFor(() => expect(container.querySelector("textarea")).toBeTruthy());

    // text/plain → filename in textContent (image/* only appears in <img alt>).
    const file = new File(["world"], "dropped.txt", { type: "text/plain" });

    const composerWrapper = container.querySelector(".border-t") as HTMLElement;
    expect(composerWrapper).toBeTruthy();

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: makeFileList([file]), items: [] },
    });
    fireEvent(composerWrapper, drop);

    await waitFor(() => expect(container.textContent).toContain("dropped.txt"));
  });

  it("submitting with attachments-only fires callAgentChat with the converted payload", async () => {
    const user = userEvent.setup();
    const { container } = renderChatPage();

    const textarea = await waitFor(() => {
      const el = container.querySelector("textarea");
      expect(el).toBeTruthy();
      return el!;
    });

    const file = new File(["data"], "attach.pdf", { type: "application/pdf" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: makeFileList([file]), items: [] },
    });
    fireEvent(textarea, paste);

    // Wait for AttachmentChip to appear (FileReader resolved).
    await waitFor(() => expect(container.textContent).toContain("attach.pdf"));

    // Submit with empty text — handleSubmit allows pending.length > 0 with "".
    const submitBtn = screen.getByRole("button", { name: /send/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(vi.mocked(callAgentChat)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: "test-agent",
            text: "",
            attachments: expect.arrayContaining([
              expect.objectContaining({ filename: "attach.pdf", mime: "application/pdf" }),
            ]),
          }),
        }),
      );
    });
  });
});
