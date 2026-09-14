import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api/client";

/**
 * Surfaces newly-created alerts from the live alert-history API as sonner toasts.
 * Mounted once at the app shell level.
 */
export function IncidentToaster() {
  const { data: alerts = [], isFetched } = useQuery({
    queryKey: ["alerts", "history"],
    queryFn: api.alerts.history,
    // 30s: incident toasts don't need 4s latency, and the global mount on
    // every page must not pressure the server-fn rate limiter.
    refetchInterval: 30_000,
  });
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (!isFetched) return;
    // Skip the very first batch — they're seed data, not "new".
    if (!primed.current) {
      alerts.forEach((a) => seen.current.add(a.id));
      primed.current = true;
      return;
    }
    alerts.forEach((a) => {
      if (seen.current.has(a.id)) return;
      seen.current.add(a.id);
      const title = `${a.serviceName}: ${a.message}`;
      if (a.status === "fired") toast.error(title, { description: a.ruleName });
      else if (a.status === "resolved") toast.success(title, { description: a.ruleName });
      else toast.info(title, { description: a.ruleName });
    });
  }, [alerts, isFetched]);

  return null;
}
