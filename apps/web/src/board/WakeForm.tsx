import type { Member } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { useSession } from "../lib/session.js";
import { scopeName } from "./citizen.js";
import { Failure, FIELD } from "./ThreadForms.js";

type Kind = "manual" | "reflection";

/**
 * Wakes a citizen by hand in one of its scopes, for a working turn or a reflection. The wake is
 * queued like any other, so the reason reaches the citizen with the rest of its prompt.
 */
export function WakeForm({
  member,
  scopes,
  preferred,
  running,
  paused,
  onDone,
}: {
  member: Member;
  scopes: readonly string[];
  /** The scope to offer first, such as the one the view shows. */
  preferred: string | null;
  running: readonly string[];
  paused: boolean;
  onDone: () => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const [kind, setKind] = useState<Kind>("manual");
  const [scope, setScope] = useState(
    preferred !== null && scopes.includes(preferred) ? preferred : (scopes[0] ?? ""),
  );
  const [reason, setReason] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);

  const wake = useMutation({
    mutationFn: () =>
      api.wake({
        agent: member.name,
        project: scope,
        kind,
        ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["scheduler"] });
      onDone();
    },
  });

  const where = scopeName(scope);
  const what =
    kind === "reflection"
      ? `Asks ${member.name} to reflect at ${where}: consolidate its memory, skills, and profile, and take no new work. It restarts the reflection clock.`
      : `Starts a turn for ${member.name} at ${where} as soon as the scheduler takes it.`;
  const after = paused
    ? " The society is paused, so it waits until you resume."
    : running.includes(scope)
      ? ` ${member.name} is in a turn there now; this one follows it.`
      : "";

  return (
    <form
      aria-label={`Wake ${member.name}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        wake.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">Kind of turn</legend>
          {(["manual", "reflection"] as const).map((each) => (
            <label
              key={each}
              className={`cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors has-focus-visible:ring-2 has-focus-visible:ring-fg-primary/30 ${
                kind === each
                  ? "bg-surface-2 text-fg-primary"
                  : "text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary"
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={each}
                checked={kind === each}
                onChange={() => setKind(each)}
                className="sr-only"
              />
              {each === "manual" ? "A turn" : "A reflection"}
            </label>
          ))}
        </fieldset>
        <label className="ml-auto flex items-center gap-2 text-xs text-fg-tertiary">
          at
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            aria-label="Where"
            className="rounded-md bg-surface-2/60 px-2 py-1 text-xs text-fg-primary outline-none"
          >
            {scopes.map((each) => (
              <option key={each} value={each}>
                {scopeName(each)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        ref={field}
        value={reason}
        rows={2}
        placeholder={
          kind === "reflection"
            ? "Anything to reflect on in particular? Optional."
            : "What should it look at? It reads this as the reason it was woken."
        }
        aria-label="Reason"
        onChange={(event) => setReason(event.target.value)}
        className={`${FIELD} resize-none`}
      />
      <p className="text-[11px] leading-relaxed text-fg-muted">
        {what}
        {after} Each turn costs money.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={wake.isPending || scope === ""}>
          {wake.isPending
            ? "Waking…"
            : kind === "reflection"
              ? "Ask for a reflection"
              : `Wake ${member.name}`}
        </Button>
      </div>
      <Failure error={wake.error} />
    </form>
  );
}
