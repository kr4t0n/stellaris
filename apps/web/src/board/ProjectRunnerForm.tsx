import type { Member, Project, ProjectMoved, Runner } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Picker, type Choice } from "../components/Picker.js";
import { ApiError } from "../lib/api.js";
import { useMembers, useRunners, useSession } from "../lib/session.js";
import { Failure } from "./ThreadForms.js";

/** What a runner lacks of what a project's turns need: its members' CLIs and its capabilities. */
export function lacksFor(runner: Runner, project: Project, members: readonly Member[]): string[] {
  const lacking = members
    .filter(
      (member) =>
        member.status === "active" &&
        project.members.includes(member.name) &&
        member.cli !== null &&
        !runner.clis.includes(member.cli),
    )
    .map((member) => `has no ${member.cli} for ${member.name}`);
  for (const capability of project.requiredCapabilities) {
    if (!runner.capabilities.includes(capability)) {
      lacking.push(`lacks ${capability}`);
    }
  }
  return lacking;
}

function choicesOf(
  runners: readonly Runner[],
  project: Project,
  members: readonly Member[],
): Choice[] {
  return runners.map((runner) => ({
    value: runner.name,
    name: runner.name,
    id: runner.os,
    description: [
      runner.name === project.runner ? "here now" : "",
      runner.status,
      runner.clis.length === 0 ? "offers no CLI yet" : runner.clis.join(", "),
      runner.capabilities.join(", "),
      ...lacksFor(runner, project, members),
    ]
      .filter((part) => part !== "")
      .join(" · "),
  }));
}

/**
 * Moves a project to another runner, which takes its repository with every branch and tag; the
 * board answers once the move has ended. While the runner it lives on is away nothing can travel,
 * and the board's refusal says what would stay there, which the user may accept.
 */
export function ProjectRunnerForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const runners = useRunners();
  const members = useMembers();
  const current = project.runner ?? "";
  const [choice, setChoice] = useState(current);
  // The old runner kept its copy, which the user is told before the form closes.
  const [kept, setKept] = useState<{ runner: string; detail: string } | null>(null);
  const move = useMutation({
    mutationFn: (withoutBranches: boolean) =>
      api.moveProject(project.slug, choice, withoutBranches),
    onSuccess: async (moved: ProjectMoved) => {
      await client.invalidateQueries({ queryKey: ["projects"] });
      if (moved.released?.ok === false) {
        setKept({ runner: moved.project.runner ?? choice, detail: moved.released.detail });
        return;
      }
      onDone();
    },
  });
  const away = move.error instanceof ApiError && move.error.code === "SOURCE_AWAY";

  if (kept !== null) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/20 p-3">
        <output className="block min-w-0 flex-1 text-sm text-fg-secondary">
          On {kept.runner}. {kept.detail}.
        </output>
        <Button onClick={onDone}>Done</Button>
      </div>
    );
  }

  return (
    <form
      aria-label={`Runner of ${project.slug}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        move.mutate(false);
      }}
    >
      <div className="flex items-center gap-2">
        {runners.data === undefined ? (
          <p className="min-w-0 flex-1 truncate text-meta">Reading the runners…</p>
        ) : (
          <Picker
            label="Runner"
            choices={choicesOf(runners.data, project, members.data ?? [])}
            value={choice}
            onChange={(value) => {
              setChoice(value);
              move.reset();
            }}
          />
        )}
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={move.isPending || choice === current || choice === ""}
        >
          {move.isPending ? "Moving…" : "Move here"}
        </Button>
      </div>
      <Failure error={move.error} />
      {away && !move.isPending ? (
        <div className="flex justify-end">
          <Button onClick={() => move.mutate(true)}>Move without them</Button>
        </div>
      ) : null}
    </form>
  );
}
