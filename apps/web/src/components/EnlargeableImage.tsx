import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

/** How an image sits in a post: no taller than a screen of text, no wider than the post. */
export const INLINE_IMAGE = "max-h-[32rem] max-w-full rounded-lg";

/** Whether the markdown being rendered sits inside a link, whose click an image there leaves to it. */
export const InsideLinkContext = createContext(false);

/**
 * An image in a post that opens enlarged over the whole window when clicked, or pressed with
 * Enter or Space once Tab reached it. Enlarged, it shows at its natural size, shrunk to fit the
 * window, never stretched past it; Escape, a click anywhere, or Close puts it away, and focus
 * goes back to the image. An image inside a link, or one that failed to load, stays a plain
 * image, as it was before images enlarged.
 */
export function EnlargeableImage({ src, alt }: { src: string; alt: string }) {
  const insideLink = useContext(InsideLinkContext);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const closed = useCallback(() => {
    // Off the page before focus goes back, since nothing behind an open modal takes focus.
    flushSync(() => setOpen(false));
    button.current?.focus();
  }, []);
  if (insideLink || failed === src) {
    return <img src={src} alt={alt} className={INLINE_IMAGE} />;
  }
  return (
    <>
      {/* As wide as the post, since a button sized by its content would give an image with no
          size of its own, such as an SVG with only a viewBox, no width at all; the image alone
          takes the pointer, so the space beside it is no button. */}
      <button
        ref={button}
        type="button"
        aria-label={`Enlarge ${alt === "" ? "the image" : alt}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="group pointer-events-none block w-full rounded-lg focus-visible:outline-none"
      >
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(src)}
          className={`pointer-events-auto block cursor-zoom-in ${INLINE_IMAGE} group-focus-visible:ring-2 group-focus-visible:ring-fg-primary/30`}
        />
      </button>
      {/* In the body, since a dialog may not sit inside the paragraph that holds the image. */}
      {open
        ? createPortal(<ImageDialog src={src} alt={alt} onClose={closed} />, document.body)
        : null}
    </>
  );
}

/**
 * The enlarged image, as a modal `<dialog>`: `showModal()` puts it in the top layer, over the
 * whole window, while an island's backdrop filter makes the island the containing block of any
 * `position: fixed` box inside it, which would have trapped an overlay drawn in the page there.
 * It closes by leaving the page as Escape or a click happens, never by the browser's `close`
 * event, which comes a task later: a key pressed in between, such as Space on the image to open
 * it again, would find it still open and be lost.
 */
function ImageDialog({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    // Strict mode runs the effect twice, and a dialog already open cannot be opened again.
    if (dialog.current?.open === false) {
      dialog.current.showModal();
    }
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={alt === "" ? "The image" : alt}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-0 size-full max-h-none max-w-none cursor-zoom-out border-0 bg-transparent p-0 text-fg-primary backdrop:bg-black/85"
    >
      {/* Every click in the window bubbles here, Close's too; the keyboard leaves by Escape or
          by Close. */}
      <div
        role="presentation"
        onClick={onClose}
        className="grid size-full grid-rows-[auto_minmax(0,1fr)] gap-2 p-4"
      >
        <header className="flex min-w-0 items-center justify-between gap-3">
          <span className="truncate text-sm text-fg-secondary">{alt}</span>
          <button
            type="button"
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-secondary hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
          >
            ✕
          </button>
        </header>
        <div className="flex min-h-0 items-center justify-center">
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full rounded-lg ring-1 ring-white/10"
          />
        </div>
      </div>
    </dialog>
  );
}
