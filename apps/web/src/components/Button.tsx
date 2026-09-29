import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-fg-primary font-medium text-surface-0 hover:bg-white",
  ghost: "text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary",
} as const;

/** The two buttons the islands use: a solid one for the action, a quiet one for the rest. */
export function Button({
  variant = "ghost",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-7 shrink-0 items-center rounded-md px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}
