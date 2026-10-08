import type { EffortOption, Member, ModelOption } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Picker, type Choice } from "../components/Picker.js";
import { ApiError } from "../lib/api.js";
import { useModels, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** The CLI's default, as a choice: no model set on the citizen. */
const CLI_DEFAULT = "";
/** The model's default, as a choice: no effort set on the citizen. */
const MODEL_DEFAULT = "";

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

function effortChoicesOf(model: ModelOption | undefined, unlisted: string | null): Choice[] {
  return [
    {
      value: MODEL_DEFAULT,
      name: "Default",
      id: model?.defaultEffort ?? null,
      description: "Whatever the model runs unset.",
    },
    ...(model?.efforts ?? []).map((effort) => ({
      value: effort.id,
      name: effort.id,
      id: null,
      description: effort.description,
    })),
    ...(unlisted === null
      ? []
      : [{ value: unlisted, name: unlisted, id: null, description: "Not in the model's list." }]),
  ];
}

/**
 * Chooses the model a citizen's turns run with, from the models its CLI lists, or the CLI's own
 * default, and the reasoning effort, from the levels the chosen model lists, or the model's own
 * default. Both apply from the citizen's next turn.
 */
export function ModelForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const models = useModels(member.cli);
  const current = member.model ?? CLI_DEFAULT;
  const currentEffort = member.effort ?? MODEL_DEFAULT;
  const [choice, setChoice] = useState(current);
  const [effort, setEffort] = useState(currentEffort);
  const save = useMutation({
    mutationFn: async () => {
      if (choice !== current) {
        await api.setModel(member.name, choice === CLI_DEFAULT ? null : choice);
      }
      if (effort !== currentEffort) {
        await api.setEffort(member.name, effort === MODEL_DEFAULT ? null : effort);
      }
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ["members"] }),
    onSuccess: onDone,
  });

  const listed = models.data ?? [];
  const unlisted =
    member.model !== undefined && !listed.some((model) => model.id === member.model)
      ? member.model
      : null;
  const modelOf = (value: string): ModelOption | undefined =>
    listed.find((model) => (value === CLI_DEFAULT ? model.isDefault : model.id === value));
  const efforts: readonly EffortOption[] = modelOf(choice)?.efforts ?? [];
  const effortUnlisted =
    effort !== MODEL_DEFAULT && !efforts.some((each) => each.id === effort) ? effort : null;
  // A model that takes none of the effort chosen drops it for its own default.
  const chooseModel = (value: string): void => {
    setChoice(value);
    const offered = modelOf(value)?.efforts ?? [];
    if (effort !== MODEL_DEFAULT && !offered.some((each) => each.id === effort)) {
      setEffort(MODEL_DEFAULT);
    }
  };
  const changed = choice !== current || effort !== currentEffort;

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
          <>
            <Picker
              label="Model"
              choices={choicesOf(listed, unlisted)}
              value={choice}
              onChange={chooseModel}
            />
            {efforts.length === 0 && effortUnlisted === null ? null : (
              <div className="flex w-32 shrink-0">
                <Picker
                  label="Effort"
                  choices={effortChoicesOf(modelOf(choice), effortUnlisted)}
                  value={effort}
                  onChange={setEffort}
                  listClassName="right-0 w-64"
                />
              </div>
            )}
          </>
        )}
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={save.isPending || !changed || models.error !== null}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Failure error={save.error} />
    </form>
  );
}
