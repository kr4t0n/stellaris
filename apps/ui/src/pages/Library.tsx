import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { SharedMemory } from "../components/SharedMemory.js";
import { Panel } from "../components/ui.js";

/** The library: the society's promoted skills and its knowledge topics. */
export function LibraryPage() {
  const roster = useQuery({ queryKey: ["members"], queryFn: api.members });
  return (
    <Panel title="Library">
      <SharedMemory members={roster.data ?? []} />
    </Panel>
  );
}
