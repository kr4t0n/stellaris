import type { CliKind } from "@stellaris/shared";
import { CLI_MARKS } from "../lib/marks.js";

/** A CLI's mark. Decorative: whatever shows it names the CLI in text too. */
export function CliIcon({ cli, size = 16 }: { cli: CliKind; size?: number }) {
  const mark = CLI_MARKS[cli];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <path d={mark.path} fill={mark.fill} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
