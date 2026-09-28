import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribe } from "../api/client.js";

/**
 * Keeps every query fresh: any board event invalidates the cache, debounced so a burst of
 * events from one turn refetches once.
 */
export function useBoardEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = subscribe("/events/stream", () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries();
      }, 300);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [queryClient]);
}
