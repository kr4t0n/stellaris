import type { TurnHistoryEntry } from "@stellaris/shared";
import { useMemo } from "react";
import { transcriptTurn, type LiveTurn } from "../lib/live.js";
import { useTranscript } from "../lib/session.js";

/** A finished turn from its stored transcript, read only when an entry with one is given. */
export function useStoredTurn(
  name: string,
  entry: TurnHistoryEntry | undefined,
): { turn: LiveTurn | undefined; loading: boolean; missing: boolean } {
  const transcript = useTranscript(name, entry?.turnId ?? null);
  const turn = useMemo(
    () =>
      entry === undefined || transcript.data === undefined
        ? undefined
        : transcriptTurn(transcript.data, name, entry.project, entry),
    [entry, transcript.data, name],
  );
  return {
    turn,
    loading: entry?.turnId !== undefined && transcript.isPending,
    missing: entry !== undefined && (entry.turnId === undefined || transcript.isError),
  };
}
