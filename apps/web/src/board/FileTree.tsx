import type { ReactNode } from "react";

/** A row of a file tree: a folder's button, or a file's button or link. */
export const TREE_ROW =
  "flex w-full items-baseline gap-2 rounded-md py-0.5 text-left text-sm hover:bg-surface-2/40";

/** One level of a file tree; a level below the top hangs from a guide line under its folder. */
export function TreeLevel({ nested, children }: { nested: boolean; children: ReactNode }) {
  return (
    <ul className={nested ? "ml-[5px] border-l border-line-strong pl-2" : "mt-2"}>{children}</ul>
  );
}

/** A folder's row: a button that opens or closes it in place, its name, then what follows it. */
export function FolderRow({
  name,
  open,
  onToggle,
  children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className={TREE_ROW}>
      <span
        aria-hidden="true"
        className={`inline-block w-2.5 shrink-0 text-[10px] text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}
      >
        ▸
      </span>
      <span className="min-w-0 truncate text-fg-primary">{name}/</span>
      {children}
    </button>
  );
}

/** The room a file's row keeps where a folder's has its arrow, so names line up. */
export function FileIndent() {
  return <span aria-hidden="true" className="w-2.5 shrink-0" />;
}
