import { useEffect, useRef, useState } from "react";
import { api, isLiveTurnEvent, subscribe, type LiveTurnEvent } from "../api/client.js";

const KEEP = 400;

/** The live picture: recent agent events, replayed from the server's buffer and then streamed. */
export function useLiveTurns(): LiveTurnEvent[] {
  const [events, setEvents] = useState<LiveTurnEvent[]>([]);
  const lastSeq = useRef(0);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    const append = (items: LiveTurnEvent[]): void => {
      const fresh = items.filter((item) => item.seq > lastSeq.current);
      if (fresh.length === 0) return;
      lastSeq.current = fresh[fresh.length - 1]?.seq ?? lastSeq.current;
      setEvents((current) => {
        const next = [...current, ...fresh];
        return next.length > KEEP ? next.slice(next.length - KEEP) : next;
      });
    };
    const start = async (): Promise<void> => {
      const page = await api.recentTurns(0);
      if (cancelled) return;
      append(page.events);
      stop = subscribe(`/turns/stream?since=${lastSeq.current}`, (message) => {
        if (message.event !== "turn") return;
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (isLiveTurnEvent(parsed)) append([parsed]);
        } catch {
          // ignore malformed frames
        }
      });
    };
    void start();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return events;
}
