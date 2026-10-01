import type { Member, Runner } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Picker, type Choice } from "../components/Picker.js";
import { useRunners, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** No runner chosen: the citizen's next turn outside a project pins it to one. */
const ANY = "";

function describe(runner: Runner, member: Member): string {
  const cli = member.cli;
  const parts = [
    runner.status,
    runner.clis.length === 0 ? "offers no CLI yet" : runner.clis.join(", "),
    cli !== null && runner.clis.length > 0 && !runner.clis.includes(cli) ? `has no ${cli}` : "",
    runner.capabilities.length === 0 ? "" : runner.capabilities.join(", "),
  ].filter((part) => part !== "");
  return parts.join(" · ");
}

function choicesOf(runners: readonly Runner[], member: Member): Choice[] {
  return [
    {
      value: ANY,
      name: "Any runner",
      id: null,
      description: "Pinned to the least busy runner on its next turn outside a project.",
    },
    ...runners.map((runner) => ({
      value: runner.name,
      name: runner.name,
      id: runner.os,
      description: describe(runner, member),
    })),
  ];
}

/**
 * Chooses the runner a citizen's work outside any project runs on. Its conversations there start
 * afresh on the new runner from its next turn; its memory and skills follow it in its home. Work in
 * a project runs where the project lives, whatever is chosen here.
 */
export function RunnerForm({ member, onDone }: { member: Member; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const runners = useRunners();
  const current = member.homeRunner ?? ANY;
  const [choice, setChoice] = useState(current);
  const save = useMutation({
    mutationFn: () => api.setRunner(member.name, choice === ANY ? null : choice),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["members"] });
      onDone();
    },
  });

  return (
    <form
      aria-label={`Runner of ${member.name}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        {runners.data === undefined ? (
          <p className="min-w-0 flex-1 truncate text-meta">Reading the runners…</p>
        ) : (
          <Picker
            label="Runner"
            choices={choicesOf(runners.data, member)}
            value={choice}
            onChange={setChoice}
          />
        )}
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={save.isPending || choice === current}>
          {save.isPending ? "Saving…" : "Run here"}
        </Button>
      </div>
      <p className="text-meta">
        Its conversations outside projects start afresh there from its next turn; its memory and
        skills follow it. Project work runs where each project lives.
      </p>
      <Failure error={save.error} />
    </form>
  );
}
