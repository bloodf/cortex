export default function reportLovableError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const events = (window as unknown as Record<string, unknown>)["__lovableEvents"] as
    { captureException?: (...args: unknown[]) => void } | undefined;
  events?.captureException?.(
    error,
    {
      source: "react_error_boundary",
      route: window.location.pathname,
      ...context,
    },
    {
      mechanism: "react_error_boundary",
      handled: false,
      severity: "error",
    },
  );
}
