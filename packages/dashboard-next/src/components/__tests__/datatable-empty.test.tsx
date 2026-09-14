import { describe, it, expect } from "vitest";
import { render, screen, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";

interface Row {
  id: string;
  name: string;
}

const cols: Column<Row>[] = [{ key: "name", header: "Name", cell: (r) => r.name }];

// DataTable always mounts a (disabled-in-local-mode) useQuery, so it needs a client.
function renderWithClient(ui: React.ReactNode): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("DataTable empty prop", () => {
  it("renders the bare 'No results' cell when empty and no `empty` prop is given", () => {
    renderWithClient(<DataTable rows={[]} columns={cols} paginate={false} />);
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("renders the provided `empty` node in place of the bare cell when empty", () => {
    renderWithClient(
      <DataTable
        rows={[]}
        columns={cols}
        paginate={false}
        empty={<EmptyState title="Nothing here yet" description="Come back later." />}
      />,
    );
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("Come back later.")).toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("shows an honest error row (not 'No results') when a server fetch rejects", async () => {
    renderWithClient(
      <DataTable
        columns={cols}
        paginate={false}
        empty={<EmptyState title="Nothing here yet" />}
        server={{
          queryKey: ["boom"],
          fetch: () => Promise.reject(new Error("upstream down")),
        }}
      />,
    );
    expect(await screen.findByText(/Failed to load/i)).toBeInTheDocument();
    // It must NOT show the empty state, which would imply "no data" rather than
    // "the request errored".
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("does not render the empty state when rows are present", () => {
    renderWithClient(
      <DataTable
        rows={[{ id: "1", name: "Alpha" }]}
        columns={cols}
        paginate={false}
        empty={<EmptyState title="Nothing here yet" />}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });
});
