import { useEffect } from "react";

export function useHotkey(match: (e: KeyboardEvent) => boolean, cb: (e: KeyboardEvent) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (match(e)) {
        e.preventDefault();
        cb(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [match, cb]);
}
