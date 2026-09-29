import { useLayoutEffect, useRef } from "react";

/**
 * Keeps a scrolling list at its newest item while the reader is there, as chat does, and leaves it
 * alone once the reader scrolls up to read history.
 */
export function useStickyScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // After every render: new items grow the list, and a reader at the end stays there.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && atEnd.current) {
      element.scrollTop = element.scrollHeight;
    }
  });
  const onScroll = (): void => {
    const element = ref.current;
    if (element !== null) {
      atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }
  };
  return { ref, onScroll };
}
