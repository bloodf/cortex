/**
 * Shared attachment primitives — used by the agent chat page and the agent
 * generator page. Keep a single source of truth for the type, caps, helpers,
 * and UI chip so the two pages stay in sync.
 */
import { FileText, X } from "lucide-react";
import { toast } from "sonner";
import { bytes } from "@/lib/format";

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export interface PendingAttachment {
  filename: string;
  mime: string;
  dataBase64: string;
}

// ---------------------------------------------------------------------------
// Caps — enforced by the profile API (P1.1)
// ---------------------------------------------------------------------------

/** Maximum combined decoded bytes across all attachments in a single message. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Maximum number of attachments per message. */
export const MAX_ATTACHMENTS = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate decoded bytes of an already-read base64 attachment. */
export function decodedBytes(att: PendingAttachment): number {
  const len = att.dataBase64.length;
  const pad = att.dataBase64.endsWith("==") ? 2 : att.dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

// ---------------------------------------------------------------------------
// UI — AttachmentChip
// ---------------------------------------------------------------------------

/** A single attachment chip / thumbnail. `onRemove` present ⇒ pending (composer). */
export function AttachmentChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove?: () => void;
}) {
  const isImage = att.mime.startsWith("image/");
  const size = decodedBytes(att);
  if (isImage) {
    return (
      <div className="group/att relative size-16 shrink-0 overflow-hidden rounded-md border bg-muted/30">
        {/* data: URL preview — the base64 we already hold, no extra fetch. */}
        <img
          src={`data:${att.mime};base64,${att.dataBase64}`}
          alt={att.filename}
          className="size-full object-cover"
        />
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${att.filename}`}
            onClick={onRemove}
            className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/att:opacity-100"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    );
  }
  return (
    <span className="inline-flex max-w-[200px] items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate" title={att.filename}>
        {att.filename}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{bytes(size)}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${att.filename}`}
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// File-pick helper
// ---------------------------------------------------------------------------

/**
 * Read a FileList into base64 attachments, enforcing the per-message count and
 * combined-size caps. Calls `onAdd` for each accepted file (async, once the
 * FileReader fires) and `onError` for any rejection.
 *
 * Callers pass the current pending list so the cap arithmetic is correct even
 * when multiple files are picked at once.
 *
 * @param files      The FileList from the <input type="file"> change event.
 * @param existing   The attachments already pending in the composer.
 * @param onAdd      Called with one attachment once its FileReader resolves.
 * @param onError    Called with a user-facing error message on rejection.
 */
export function readAttachments(
  files: FileList | null,
  existing: PendingAttachment[],
  onAdd: (att: PendingAttachment) => void,
  onError?: (message: string, description?: string) => void,
): void {
  if (!files) return;
  const fileArr = Array.from(files);
  if (fileArr.length === 0) return;

  const reportError =
    onError ?? ((msg, desc) => toast.error(msg, desc ? { description: desc } : undefined));

  if (existing.length + fileArr.length > MAX_ATTACHMENTS) {
    reportError("Too many attachments", `At most ${MAX_ATTACHMENTS} per message.`);
    return;
  }

  let runningBytes = existing.reduce((sum, p) => sum + decodedBytes(p), 0);

  for (const file of fileArr) {
    if (runningBytes + file.size > MAX_ATTACHMENT_BYTES) {
      reportError(
        `${file.name} exceeds the combined limit`,
        `Max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB total per message.`,
      );
      continue;
    }
    runningBytes += file.size;

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      onAdd({ filename: file.name, mime: file.type || "application/octet-stream", dataBase64 });
    };
    reader.onerror = () => {
      reportError(`Failed to read ${file.name}`);
    };
    reader.readAsDataURL(file);
  }
}
