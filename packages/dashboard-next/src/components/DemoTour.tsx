import { useEffect, useState } from "react";
import { X, ArrowRight } from "lucide-react";
import { Button } from "@lobehub/ui";

const KEY = "cortex.tour.v1.dismissed";
const STEPS = [
  {
    title: "Welcome to Cortex",
    body: "Live control for this host — services, Docker, Incus, storage, mail, and more, all from one place.",
  },
  {
    title: "Keyboard-first",
    body: "Press ⌘K to open the command palette. Press ? for the full shortcut list.",
  },
  {
    title: "Make Overview yours",
    body: "On the Overview page, hit Edit to rearrange or hide widgets. Your layout is saved on this device.",
  },
];

export function DemoTour() {
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setStep(0);
    } catch {
      /* noop */
    }
  }, []);

  if (step === null) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* noop */
    }
    setStep(null);
  };

  return (
    <div
      role="dialog"
      aria-label={s.title}
      className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border/60 bg-popover/95 backdrop-blur elev-sheet animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex items-start gap-2 p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Tour · {step + 1} / {STEPS.length}
          </div>
          <h3 className="mt-1.5 text-sm font-semibold">{s.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
        </div>
        <button
          onClick={dismiss}
          aria-label="Close tour"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2.5">
        <button onClick={dismiss} className="text-xs text-muted-foreground hover:text-foreground">
          Skip
        </button>
        <Button type="primary" size="small" onClick={() => (last ? dismiss() : setStep(step + 1))}>
          {last ? (
            "Got it"
          ) : (
            <>
              Next
              <ArrowRight className="size-3.5 ml-1" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
