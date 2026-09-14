import { CopyButton } from "./CopyButton";
import { cn } from "@/lib/utils";

interface Props {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: number;
}

export function CodeBlock({ code, language, className, maxHeight }: Props) {
  return (
    <div
      className={cn("relative group rounded-md border bg-terminal-bg text-terminal-fg", className)}
    >
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 text-[11px] uppercase tracking-wide text-white/50">
        <span>{language ?? "text"}</span>
        <CopyButton value={code} size="xs" className="text-white/70 hover:text-white" />
      </div>
      <pre
        className="overflow-auto p-3 text-xs leading-relaxed font-mono tabular-nums"
        style={{ maxHeight: maxHeight ? `${maxHeight}px` : undefined }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
