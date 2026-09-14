import { Modal } from "@lobehub/ui";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

const GROUPS: { label: string; items: { keys: string[]; label: string }[] }[] = [
  {
    label: "Navigation",
    items: [
      { keys: ["⌘", "K"], label: "Open command palette" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["G", "O"], label: "Go to Overview" },
      { keys: ["G", "A"], label: "Go to Apps" },
      { keys: ["G", "D"], label: "Go to Docker" },
      { keys: ["G", "I"], label: "Go to Incus" },
      { keys: ["G", "T"], label: "Go to Terminal" },
    ],
  },
  {
    label: "Actions",
    items: [
      { keys: ["⌘", "/"], label: "Toggle theme" },
      { keys: ["⌘", "B"], label: "Toggle sidebar" },
      { keys: ["Esc"], label: "Close dialog / palette" },
    ],
  },
  {
    label: "Tables",
    items: [
      { keys: ["↑", "↓"], label: "Move selection" },
      { keys: ["Enter"], label: "Open row" },
      { keys: ["/"], label: "Focus search" },
    ],
  },
];

export function KeyboardShortcuts({ open, onOpenChange }: Props) {
  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="Keyboard shortcuts"
      footer={null}
      width={640}
    >
      <p className="text-sm text-muted-foreground mb-4">
        Cortex is keyboard-first. Press{" "}
        <kbd className="px-1.5 py-0.5 border rounded text-xs">?</kbd> any time to view these.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map((g) => (
          <div key={g.label}>
            <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 font-semibold">
              {g.label}
            </h3>
            <ul className="space-y-1.5">
              {g.items.map((it) => (
                <li key={it.label} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{it.label}</span>
                  <span className="flex gap-1">
                    {it.keys.map((k) => (
                      <kbd
                        key={k}
                        className="px-1.5 py-0.5 border rounded text-[11px] font-mono bg-muted/40 min-w-[22px] text-center"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}
