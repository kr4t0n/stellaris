import type { Member, ModelOption, RoleCharter } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { ApiError } from "../lib/api.js";
import { useModels, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** The CLI's default, as a choice: no model set on the citizen. */
const CLI_DEFAULT = "";

function label(model: ModelOption): string {
  return model.name === model.id ? model.id : `${model.name} · ${model.id}`;
}

/**
 * Chooses the model a citizen's turns run with, from the models its CLI lists, or the CLI's own
 * default. The choice applies from the citizen's next turn.
 */
export function ModelForm({
  member,
  charter,
  observed,
  onDone,
}: {
  member: Member;
  charter: RoleCharter | undefined;
  /** The model the CLI reported on the citizen's latest turn, if any. */
  observed: string | undefined;
  onDone: () => void;
}) {
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
  const fallback = listed.find((model) => model.isDefault);
  // A model set before, or by hand, stays choosable even when the CLI no longer lists it.
  const unlisted =
    member.model !== undefined && !listed.some((model) => model.id === member.model)
      ? member.model
      : null;
  const picked = listed.find((model) => model.id === choice);
  const warm = charter?.resident === true;

  return (
    <form
      aria-label={`Model of ${member.name}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-xs text-fg-tertiary">
        Set to {member.model ?? "the CLI's default"}
        {observed === undefined ? "" : ` · its last turn ran ${observed}`}
      </p>
      {models.isPending ? (
        <p className="text-meta">Asking {member.cli} for its models…</p>
      ) : models.error !== null ? (
        <p role="alert" className="text-xs text-red-400">
          {member.cli} did not list its models:{" "}
          {models.error instanceof ApiError
            ? models.error.message
            : "the board server did not answer"}
        </p>
      ) : (
        <select
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          aria-label="Model"
          className="w-full rounded-lg bg-surface-2/60 px-2.5 py-1.5 text-sm text-fg-primary outline-none"
        >
          <option value={CLI_DEFAULT}>
            CLI default{fallback === undefined ? "" : ` · ${fallback.name}`}
          </option>
          {listed.map((model) => (
            <option key={model.id} value={model.id}>
              {label(model)}
            </option>
          ))}
          {unlisted === null ? null : <option value={unlisted}>{unlisted} · not listed</option>}
        </select>
      )}
      <p className="text-[11px] leading-relaxed text-fg-muted">
        {picked?.description === undefined || picked.description === ""
          ? ""
          : `${picked.description} `}
        From {member.name}'s next turn; its session goes on with the new model
        {warm ? ", and its warm session starts afresh" : ""}.
      </p>
      <div className="flex items-center justify-end gap-2">
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
