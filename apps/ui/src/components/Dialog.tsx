import { useEffect, useRef, type ReactNode } from "react";
import { Button, ErrorNote } from "./ui.js";

/**
 * A modal on the native dialog element: the browser traps focus, closes on Escape, and restores
 * focus afterwards, which is exactly the behavior a confirmation needs and nothing we should
 * reimplement.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      className="m-auto w-[28rem] max-w-[90vw] rounded-lg border border-board-border bg-board-panel p-0 text-board-text shadow-2xl backdrop:bg-black/60"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
        className="flex flex-col gap-3 p-4"
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="text-sm text-board-muted">{children}</div>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" tone={tone} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
