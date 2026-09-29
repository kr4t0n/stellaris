import type { CSSProperties, ReactNode } from "react";

/**
 * A floating island: a rounded panel inset from the window's edges and floating over the sky,
 * never docked flush against an edge. The caller places it.
 */
export function Island({
  label,
  className,
  style,
  children,
}: {
  label: string;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      style={style}
      className={`absolute flex flex-col overflow-hidden rounded-2xl bg-surface-1/80 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07),0_24px_48px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl ${className}`}
    >
      {children}
    </section>
  );
}
