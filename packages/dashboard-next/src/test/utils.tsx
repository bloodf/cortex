import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import makeQueryClient from "./query-client";

interface ProvidersProps {
  children: ReactNode;
  client?: QueryClient;
}

export default function TestProviders({ children, client }: ProvidersProps) {
  const qc = client ?? makeQueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
