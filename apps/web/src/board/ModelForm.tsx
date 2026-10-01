import type { Member, ModelOption } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Picker, type Choice } from "../components/Picker.js";
import { ApiError } from "../lib/api.js";
import { useModels, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** The CLI's default, as a choice: no model set on the citizen. */
const CLI_DEFAULT = "";

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
          <Picker
            label="Model"
            choices={choicesOf(listed, unlisted)}
            value={choice}
            onChange={setChoice}
          />
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
