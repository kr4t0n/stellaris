import type { ReactNode } from "react";

/** The header every view in the content island opens with. */
export function PaneHeader({
  title,
  subtitle,
  leading,
  trailing,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-line px-4 py-3">
      {leading}
      <div className="min-w-0 flex-1">
        <h2 className="text-heading truncate">{title}</h2>
        {subtitle === undefined ? null : <p className="truncate text-meta">{subtitle}</p>}
      </div>
      {trailing}
    </header>
  );
}

export function PaneNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-10 text-center text-meta" aria-live="polite">
      {children}
    </p>
  );
}
