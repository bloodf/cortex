import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

const ListMcpServersInput = z.object({}).strict();

const listMcpServersGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ListMcpServersInput,
  surface: "mcp",
  action: "mcp.list",
  handler: async () => {
    const { readMcpServers } = await import("@/server/mcp/registry");
    return { servers: readMcpServers() };
  },
});
export const listMcpServers = createServerFn({ method: "GET" })
  .middleware([listMcpServersGate])
  .handler(serverFnNoop);
