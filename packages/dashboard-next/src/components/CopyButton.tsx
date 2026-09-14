import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@lobehub/ui";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  className,
  size = "sm",
}: {
  value: string;
  className?: string;
  size?: "sm" | "xs";
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="text"
      shape="circle"
      size="small"
      className={cn(size === "xs" ? "!h-6 !w-6" : "!h-7 !w-7", className)}
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      aria-label="Copy"
    >
      {done ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
