import { useQuery } from "@tanstack/react-query";
import { Network as NetIcon, ArrowDown, ArrowUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { FCard } from "@/components/fable";
import { EmptyState } from "@/components/EmptyState";
import { CardSkeleton } from "@/components/skeletons";
import { api } from "@/lib/api/client";
import { useT } from "@/hooks/useT";
import { bytes, kbps } from "@/lib/format";

export function NetworkPage() {
  const t = useT();
  const {
    data: net,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["network"],
    queryFn: api.network,
    refetchInterval: 3000,
  });
  const interfaces = net?.interfaces ?? [];
  const totalRx = interfaces.reduce((a, i) => a + i.rxKbps, 0);
  const totalTx = interfaces.reduce((a, i) => a + i.txKbps, 0);
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<NetIcon className="size-5" />}
        title={t.nav.network}
        description={`${interfaces.length} interfaces`}
      />
      {isError && (
        <EmptyState
          icon={<NetIcon className="size-6" />}
          title="Couldn't load network data"
          description="The request failed — it will retry automatically."
        />
      )}
      {isLoading && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} lines={2} />
          ))}
        </div>
      )}
      {/* Only render metrics once data has loaded — avoids a flash of
          misleading all-zero values during load and under the error state. */}
      {net && (
        <>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <MetricCard
              label="Rx Total"
              value={kbps(totalRx)}
              icon={<ArrowDown className="size-4" />}
            />
            <MetricCard
              label="Tx Total"
              value={kbps(totalTx)}
              icon={<ArrowUp className="size-4" />}
            />
            <MetricCard
              label="Lifetime Rx"
              value={bytes(interfaces.reduce((a, i) => a + i.rxBytesTotal, 0))}
            />
            <MetricCard
              label="Lifetime Tx"
              value={bytes(interfaces.reduce((a, i) => a + i.txBytesTotal, 0))}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {interfaces.map((i) => (
              <FCard key={i.name}>
                <div className="w-full">
                  <div className="flex flex-col space-y-1.5 p-6 pb-2">
                    <div className="font-semibold leading-none tracking-tight text-sm font-mono">
                      {i.name}
                    </div>
                  </div>
                  <div className="p-6 pt-0 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rx</span>
                      <span className="tabular-nums">{kbps(i.rxKbps)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tx</span>
                      <span className="tabular-nums">{kbps(i.txKbps)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rx total</span>
                      <span className="tabular-nums text-xs">{bytes(i.rxBytesTotal)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tx total</span>
                      <span className="tabular-nums text-xs">{bytes(i.txBytesTotal)}</span>
                    </div>
                  </div>
                </div>
              </FCard>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
