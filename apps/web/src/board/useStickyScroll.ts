import { useLayoutEffect, useRef, useState } from "react";

/** How far from the end, in pixels, the reader still counts as at the end. */
const NEAR_END = 80;

function distanceToEnd(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/**
 * Keeps a scrolling list at its newest item while the reader is there, as chat does, and leaves it
 * alone once the reader scrolls up to read history. With `stick` off, as while a view shows the
 * message a link named, the list starts where the reader is taken instead. With `follow` off, as
 * in a task's view, whose thread comes after its plan, the list never moves by itself.
 *
 * `away` says the reader is away from the end, and `jump` takes them back, pinning the list there
 * again where it follows. `unseen` counts the `ids` newer than the newest the reader was at the end
 * with, or that the list opened with; ids are ULIDs, which sort as strings.
 */
export function useStickyScroll({
  stick = true,
  follow = true,
  ids = [],
}: {
  stick?: boolean | undefined;
  follow?: boolean | undefined;
  ids?: readonly string[] | undefined;
} = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(stick && follow);
  // A smooth jump passes through places away from the end; it holds the pin until it arrives, or
  // until the reader scrolls back up.
  const jumping = useRef<number | null>(null);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const newest = ids.at(-1) ?? null;
  const [seen, setSeen] = useState<string | null>(null);
  // Before the pin below: a re-render must not pull the list back from where a link took it.
  useLayoutEffect(() => {
    if (!stick || !follow) {
      atEnd.current = false;
    }
  }, [stick, follow]);
  // After every render: new items grow the list, and a reader at the end of a list that follows
  // stays there, as does a jump under way.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    if (atEnd.current) {
      if (jumping.current === null) {
        if (follow) {
          element.scrollTop = element.scrollHeight;
        }
      } else if (jumping.current !== element.scrollHeight) {
        // The list grew under the jump: aim it at the new end.
        jumping.current = element.scrollHeight;
        element.scrollTo({ top: element.scrollHeight, behavior: scrollBehavior() });
      }
    }
  });
  // Once new items are in: whether they reach past the end where the reader is, as when a link took
  // them to a message, and the newest the reader has seen, which is everything the list opened with.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const isAway = jumping.current === null && distanceToEnd(element) >= NEAR_END;
    setAway(isAway);
    setSeen((current) => (isAway && current !== null ? current : newest));
  }, [newest]);
  const onScroll = (): void => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const near = distanceToEnd(element) < NEAR_END;
    if (near || element.scrollTop < lastTop.current) {
      jumping.current = null;
    }
    lastTop.current = element.scrollTop;
    atEnd.current = near || jumping.current !== null;
    setAway(!atEnd.current);
    if (atEnd.current) {
      setSeen(newest);
    }
  };
  /** Takes the reader to the newest item, and with `focus` moves focus there too. */
  const jump = ({ focus = false }: { focus?: boolean | undefined } = {}): void => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    atEnd.current = true;
    jumping.current = element.scrollHeight;
    lastTop.current = element.scrollTop;
    setAway(false);
    setSeen(newest);
    const behavior = scrollBehavior();
    // A smooth scroll takes longer the further it goes, so a long way is skipped and only the last
    // screen glides.
    const glideFrom = element.scrollHeight - 2 * element.clientHeight;
    if (behavior === "smooth" && element.scrollTop < glideFrom) {
      element.scrollTop = glideFrom;
    }
    element.scrollTo({ top: element.scrollHeight, behavior });
    const latest = [...element.querySelectorAll("article")].at(-1) ?? element.lastElementChild;
    if (focus && latest instanceof HTMLElement) {
      if (!latest.hasAttribute("tabindex")) {
        latest.setAttribute("tabindex", "-1");
      }
      latest.focus({ preventScroll: true });
    }
  };
  const unseen = seen === null ? 0 : ids.filter((id) => id > seen).length;
  return { ref, onScroll, away, unseen: away ? unseen : 0, jump };
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}
