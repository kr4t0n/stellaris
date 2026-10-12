import { useLayoutEffect, useRef } from "react";

/**
 * Keeps a scrolling list at its newest item while the reader is there, as chat does, and leaves it
 * alone once the reader scrolls up to read history. With `stick` off, as while a view shows the
 * message a link named, the list starts where the reader is taken instead.
 */
export function useStickyScroll(stick = true) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(stick);
  // Before the pin below: a re-render must not pull the list back from where a link took it.
  useLayoutEffect(() => {
    if (!stick) {
      atEnd.current = false;
    }
  }, [stick]);
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
