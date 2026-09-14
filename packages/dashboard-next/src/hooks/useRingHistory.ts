import { useEffect, useRef, useState } from "react";

/**
 * Keeps a rolling window of values that update whenever `value` changes.
 * Useful for sparkline/area chart history from a polled API.
 */
export function useRingHistory<T>(value: T | undefined, size = 30): T[] {
  const [history, setHistory] = useState<T[]>([]);
  const lastRef = useRef<T | undefined>(undefined);

  useEffect(() => {
    if (value === undefined) return;
    if (lastRef.current === value) return;
    lastRef.current = value;
    setHistory((prev) => {
      const next = [...prev, value];
      return next.length > size ? next.slice(next.length - size) : next;
    });
  }, [value, size]);

  return history;
}
