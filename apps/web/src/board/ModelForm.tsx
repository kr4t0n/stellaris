import type { Member, ModelOption } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../components/Button.js";
import { ApiError } from "../lib/api.js";
import { useModels, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** The CLI's default, as a choice: no model set on the citizen. */
const CLI_DEFAULT = "";

interface Choice {
  readonly value: string;
  readonly name: string;
  /** The id the CLI takes, when it differs from the name. */
  readonly id: string | null;
  readonly description: string;
}

function choicesOf(listed: readonly ModelOption[], unlisted: string | null): Choice[] {
  const fallback = listed.find((model) => model.isDefault);
  return [
    {
      value: CLI_DEFAULT,
      name: "CLI default",
      id: fallback?.name ?? null,
      description: "Whatever the CLI runs when no model is set.",
    },
    ...listed.map((model) => ({
      value: model.id,
      name: model.name,
      id: model.name === model.id ? null : model.id,
      description: model.description,
    })),
    // A model set before, or by hand, stays choosable even when the CLI no longer lists it.
    ...(unlisted === null
      ? []
      : [{ value: unlisted, name: unlisted, id: null, description: "Not in the CLI's list." }]),
  ];
}

function spoken(choice: Choice | undefined): string {
  return choice === undefined ? "" : `${choice.name}${choice.id === null ? "" : ` · ${choice.id}`}`;
}

/** A dropdown in the islands' look: the choice in the header's type, the list as a floating card. */
function ModelPicker({
  choices,
  value,
  onChange,
}: {
  choices: readonly Choice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = choices.findIndex((choice) => choice.value === value);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    items.current[Math.max(selected, 0)]?.focus();
    const away = (event: PointerEvent): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open, selected]);

  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Escape") {
      // The board closes on Escape too; this one only closes the list.
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const at = items.current.findIndex((item) => item === document.activeElement);
    const next = (at + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
    items.current[next]?.focus();
  };

  const current = choices[selected];
  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <button
        ref={trigger}
        type="button"
        aria-label={`Model: ${spoken(current)}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={open ? move : undefined}
        className="flex h-7 w-full items-center gap-1.5 rounded-md bg-surface-2/60 px-2.5 text-xs text-fg-secondary transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.name}
          {current?.id === null || current === undefined ? null : (
            <span className="text-fg-tertiary"> · {current.id}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className={`text-[10px] text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl bg-surface-1/95 p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_16px_32px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl">
          {choices.map((choice, index) => {
            const chosen = choice.value === value;
            return (
              <button
                key={choice.value}
                ref={(element) => {
                  items.current[index] = element;
                }}
                type="button"
                aria-current={chosen ? "true" : undefined}
                onKeyDown={move}
                onClick={() => {
                  onChange(choice.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none ${
                  chosen ? "bg-surface-2/80" : "hover:bg-surface-2/50 focus-visible:bg-surface-2/50"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg-secondary">
                    {choice.name}
                    {choice.id === null ? null : (
                      <span className="text-fg-tertiary"> · {choice.id}</span>
                    )}
                  </span>
                  {choice.description === "" ? null : (
                    <span className="block truncate text-[11px] text-fg-muted">
                      {choice.description}
                    </span>
                  )}
                </span>
                <span aria-hidden="true" className="w-3 shrink-0 pt-px text-[11px] text-fg-primary">
                  {chosen ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Chooses the model a citizen's turns run with, from the models its CLI lists, or the CLI's own
 * default. The choice applies from the citizen's next turn.
 */
export function ModelForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const models = useModels(member.cli);
  const current = member.model ?? CLI_DEFAULT;
  const [choice, setChoice] = useState(current);
  const save = useMutation({
    mutationFn: () => api.setModel(member.name, choice === CLI_DEFAULT ? null : choice),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["members"] });
      onDone();
    },
  });

  const listed = models.data ?? [];
  const unlisted =
    member.model !== undefined && !listed.some((model) => model.id === member.model)
      ? member.model
      : null;

  return (
    <form
      aria-label={`Model of ${member.name}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        {models.isPending ? (
          <p className="min-w-0 flex-1 truncate text-meta">Asking {member.cli} for its models…</p>
        ) : models.error !== null ? (
          <p role="alert" className="min-w-0 flex-1 truncate text-xs text-red-400">
            {member.cli} did not list its models:{" "}
            {models.error instanceof ApiError
              ? models.error.message
              : "the board server did not answer"}
          </p>
        ) : (
          <ModelPicker choices={choicesOf(listed, unlisted)} value={choice} onChange={setChoice} />
        )}
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={save.isPending || choice === current || models.error !== null}
        >
          {save.isPending ? "Saving…" : "Use this model"}
        </Button>
      </div>
      <Failure error={save.error} />
    </form>
  );
}
