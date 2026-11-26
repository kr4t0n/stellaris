import type { TurnHistoryEntry } from "@stellaris/shared";
import { useMemo } from "react";
import { namesNothing } from "../lib/api.js";
import { transcriptTurn, type LiveTurn } from "../lib/live.js";
import { useTranscript } from "../lib/session.js";

/**
 * A finished turn from its stored transcript, read only when an entry with one is given, and why it
 * could not be read: never a transcript the board does not have, which is a turn that kept none.
 */
export function useStoredTurn(
  name: string,
  entry: TurnHistoryEntry | undefined,
): { turn: LiveTurn | undefined; loading: boolean; error: Error | null } {
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
    error: namesNothing(transcript.error) ? null : transcript.error,
  };
}
