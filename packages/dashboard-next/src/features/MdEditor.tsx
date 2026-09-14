import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Save, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Editor, EditorProvider } from "@lobehub/editor/react";
import { ReactEditorContent } from "@lobehub/editor";
import type { IEditor } from "@lobehub/editor";

import { Button, Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FCard } from "@/components/fable";
import { api, callWriteMdFile, callMintApproval } from "@/lib/api/client";
import type { MdFileEntry } from "@/lib/api/client";
import { APPROVAL_ACTIONS } from "@/lib/api/approval-actions";
import { csrfHeaders } from "@/lib/csrf";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// @lobehub/editor React 19 verification
// --------------------------------------
// Verified against @lobehub/editor@4.20.3 d.ts + peers (react ^19.0.0, antd
// ^6.1.1, @lobehub/ui ^5.0.0 — all satisfied by the Phase 0 install). The
// markdown editor is `Editor` (+ `ReactEditorContent` child, `content` /
// `type: "markdown"`); onTextChange hands the IEditor kernel whose
// `getDocument('markdown').write(lexical)` serializes the current markdown.
// Runtime fallback (if the editor breaks under React 19): swap the <Editor>
// block for a plain <textarea> bound to `draft` + a `streamdown` preview —
// the load/save flow is editor-agnostic (only the draft source changes).
// ---------------------------------------------------------------------------

export function MdEditorPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const filesQuery = useQuery({
    queryKey: ["notes", "files"],
    queryFn: () => api.notes.list(),
  });

  const fileQuery = useQuery({
    queryKey: ["notes", "file", selected],
    enabled: selected !== null,
    queryFn: () => api.notes.read(selected!),
  });

  // Reset the draft when a new file finishes loading.
  const loadedPath = fileQuery.data?.path ?? null;
  useEffect(() => {
    if (fileQuery.data) {
      setDraft(fileQuery.data.content);
      setDirty(false);
    }
  }, [fileQuery.data]);

  async function openFile(file: MdFileEntry) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setSelected(file.path);
    setDirty(false);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      // 1. Mint a single-use approval token bound to the FULL payload.
      const mint = await callMintApproval({
        data: { action: APPROVAL_ACTIONS.notesWrite, payload: { path: selected, content: draft } },
        headers: csrfHeaders(),
      });
      // 2. Submit with CSRF + approval token (pipeline consumes the header).
      await callWriteMdFile({
        data: { path: selected, content: draft },
        headers: { ...csrfHeaders(), "x-cortex-approval-token": mint.token },
      });
      setDirty(false);
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["notes", "file", selected] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const files = filesQuery.data ?? [];
  const docs = files.filter((f) => f.root === "docs");
  const prompts = files.filter((f) => f.root === "prompts");

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FileText className="size-5" />}
        title={t.nav.notes}
        description="Edit Cortex docs and prompts — saves require approval"
        actions={
          <Button
            type="primary"
            onClick={save}
            disabled={!selected || !dirty || saving}
            size="small"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* File browser */}
        <FCard className="h-[calc(100vh-220px)] overflow-y-auto p-2">
          {filesQuery.isLoading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading files…
            </div>
          )}
          {filesQuery.isError && (
            <EmptyState
              icon={<FolderOpen className="size-8" />}
              title="Failed to list files"
              description="notes.list RPC errored"
            />
          )}
          {!filesQuery.isLoading && files.length === 0 && (
            <EmptyState
              icon={<FolderOpen className="size-8" />}
              title="No markdown files"
              description="Nothing in the configured docs or prompts directories."
            />
          )}
          {(["docs", "prompts"] as const).map((root) => {
            const group = root === "docs" ? docs : prompts;
            if (group.length === 0) return null;
            return (
              <div key={root} className="mb-2">
                <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {root}
                </div>
                {group.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => openFile(f)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent",
                      selected === f.path && "bg-accent font-medium",
                    )}
                    title={f.path}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </FCard>

        {/* Editor */}
        <FCard className="flex h-[calc(100vh-220px)] flex-col p-3">
          {!selected && (
            <EmptyState
              icon={<FileText className="size-8" />}
              title="Select a file"
              description="Pick a markdown file from the browser"
            />
          )}
          {selected && fileQuery.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {selected && fileQuery.isError && (
            <EmptyState
              icon={<FileText className="size-8" />}
              title="Failed to load file"
              description={selected}
            />
          )}
          {selected && fileQuery.data && (
            <>
              <div className="mb-2 flex items-center gap-2 border-b pb-2">
                <span className="truncate font-mono text-xs text-muted-foreground">{selected}</span>
                {dirty && <Tag color="gold">unsaved</Tag>}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <EditorProvider>
                  <Editor
                    key={loadedPath ?? "empty"}
                    onTextChange={(editor: IEditor) => {
                      // getDocument('markdown') returns the markdown
                      // DataSource; .write(lexicalEditor) serializes the
                      // current document to a markdown string.
                      const ds = editor.getDocument("markdown");
                      const lexical = editor.getLexicalEditor();
                      if (!ds || !lexical) return;
                      const md = ds.write(lexical);
                      const text = typeof md === "string" ? md : String(md ?? "");
                      setDraft(text);
                      setDirty(text !== fileQuery.data.content);
                    }}
                    className="min-h-full"
                  >
                    <ReactEditorContent content={fileQuery.data.content} type="markdown" />
                  </Editor>
                </EditorProvider>
              </div>
            </>
          )}
        </FCard>
      </div>
    </div>
  );
}
