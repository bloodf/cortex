import { useQuery } from "@tanstack/react-query";
import { Boxes, Plug } from "lucide-react";
import { Tag } from "@lobehub/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FCard } from "@/components/fable";
import { api } from "@/lib/api/client";
import type { McpServerEntry } from "@/lib/api/client";

function commandText(server: McpServerEntry): string {
  if (server.url) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

export default function McpsPage() {
  const {
    data: servers = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: api.mcpServers,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Plug className="size-5" />}
        title="MCP Servers"
        description="AI harness MCP declarations from Claude and Cursor configs."
      />

      {isLoading ? (
        <FCard className="p-6">
          <EmptyState title="Loading MCP servers…" />
        </FCard>
      ) : isError ? (
        <FCard className="p-6">
          <EmptyState
            icon={<Boxes className="size-8" />}
            title="Couldn't load MCP servers"
            description="The request failed — it will retry automatically."
          />
        </FCard>
      ) : servers.length === 0 ? (
        <FCard className="p-6">
          <EmptyState
            icon={<Boxes className="size-8" />}
            title="No MCP servers"
            description="No MCP server declarations were found in the configured harness home."
          />
        </FCard>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <FCard key={server.name} className="p-4 transition-shadow hover:elev-2">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold truncate">{server.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {server.sources.length} source(s)
                    </p>
                  </div>
                  <Tag variant="outlined" className="uppercase text-[11px]">
                    {server.transport}
                  </Tag>
                </div>

                <pre className="rounded-md bg-muted/50 p-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
                  {commandText(server) || "(no command/url)"}
                </pre>

                <div className="flex flex-wrap gap-1">
                  {server.sources.map((source) => (
                    <Tag key={source} className="text-[11px]">
                      {source}
                    </Tag>
                  ))}
                </div>
              </div>
            </FCard>
          ))}
        </div>
      )}
    </div>
  );
}
