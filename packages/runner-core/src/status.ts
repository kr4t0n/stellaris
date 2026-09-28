import { TurnStatusSchema, type TurnStatus } from "@stellaris/shared";

/**
 * The status object every turn ends with: from a CLI's structured output when it has one,
 * otherwise from a fenced JSON block or a trailing JSON object in the final text.
 */
export function parseTurnStatus(structured: unknown, finalText: string): TurnStatus | null {
  const direct = TurnStatusSchema.safeParse(structured);
  if (direct.success) {
    return direct.data;
  }
  const fenced = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: unknown = null;
  while ((match = fenced.exec(finalText)) !== null) {
    try {
      last = JSON.parse(match[1] ?? "");
    } catch {
      // keep looking
    }
  }
  if (last === null) {
    const brace = finalText.lastIndexOf("{");
    if (brace !== -1) {
      try {
        last = JSON.parse(finalText.slice(brace));
      } catch {
        return null;
      }
    }
  }
  const parsed = TurnStatusSchema.safeParse(last);
  return parsed.success ? parsed.data : null;
}
