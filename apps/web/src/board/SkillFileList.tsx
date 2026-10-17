import type { SkillFileContent } from "@stellaris/shared";
import { useState } from "react";
import { sizeLabel } from "../lib/files.js";

/**
 * The files of a skill's folder beside its SKILL.md, each a row with its size that opens to its
 * text; a proposal's view and a society skill's view list them alike.
 */
export function SkillFileList({ files }: { files: readonly SkillFileContent[] }) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string): void => {
    setShown((was) => {
      const next = new Set(was);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };
  return (
    <ul>
      {files.map((file) => {
        const open = shown.has(file.path);
        return (
          <li key={file.path}>
            <button
              type="button"
              aria-expanded={open}
              title={file.path}
              onClick={() => toggle(file.path)}
              className={`group flex w-full items-baseline gap-2 rounded-md py-0.5 text-left text-sm hover:bg-surface-2/40 ${open ? "bg-surface-2/30" : ""}`}
            >
              <span
                aria-hidden="true"
                className={`inline-block w-2.5 shrink-0 text-[10px] text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}
              >
                ▸
              </span>
              <span
                className={`min-w-0 truncate ${open ? "text-fg-primary" : "text-fg-secondary group-hover:text-fg-primary"}`}
              >
                {file.path}
              </span>
              <span className="shrink-0 text-meta">
                {sizeLabel(file.size)}
                {file.executable ? " · executable" : ""}
              </span>
            </button>
            {open ? (
              file.text === null ? (
                <p className="mt-1 mb-2 ml-[18px] text-meta">
                  A binary file; it is published as it is.
                </p>
              ) : (
                <pre className="mt-1 mb-2 ml-[18px] max-h-96 overflow-auto rounded-lg bg-surface-2/40 p-3 font-mono text-[11px] leading-relaxed text-fg-secondary">
                  {file.text}
                  {file.truncated ? "\n…" : ""}
                </pre>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
