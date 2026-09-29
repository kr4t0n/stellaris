import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Markdown } from "../components/Markdown.js";
import { Button, Empty, ErrorNote, Field, inputClass, Panel, Pill } from "../components/ui.js";
import { useLiveTurns } from "../hooks/useLiveTurns.js";
import { clockTime, describeToolInput, timeAgo } from "../lib/format.js";
import { citizenRoute } from "../router.js";

/** One citizen: who it is, what it has done, what it remembers, and what it is doing right now. */
export function CitizenPage() {
  const { name } = citizenRoute.useParams();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ["members"], queryFn: api.members });
  const roles = useQuery({ queryKey: ["roles"], queryFn: api.roles });
  const turns = useQuery({ queryKey: ["turns", name], queryFn: () => api.turns(name, 50) });
  const memory = useQuery({ queryKey: ["memory", name], queryFn: () => api.memory(name) });
  const live = useLiveTurns()
    .filter((item) => item.agent === name)
    .slice(-60);
  const member = members.data?.find((entry) => entry.name === name);
  const charter = roles.data?.find((role) => role.name === member?.role);
  const scopes = [
    ...(member?.memberships ?? []),
    ...(charter?.societyScope === true ? ["society"] : []),
  ];
  const [scope, setScope] = useState<string | null>(null);
  const chosen = scope ?? scopes[0] ?? null;
  const wake = useMutation({
    mutationFn: (kind: "manual" | "reflection") =>
      api.wake(
        name,
        chosen ?? "society",
        kind === "reflection"
          ? "reflection from the playground"
          : "manual wake from the playground",
        kind,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const spend = (turns.data ?? []).reduce((sum, turn) => sum + turn.costUsd, 0);

  if (members.data !== undefined && member === undefined) {
    return <Empty>No citizen named {name}.</Empty>;
  }
  return (
    <div className="space-y-4">
      <Panel title={member?.name ?? name}>
        {member === undefined ? null : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Pill className="border-board-border">{member.role}</Pill>
              <Pill className="border-board-border">{member.cli ?? "no CLI"}</Pill>
              <Pill className="border-board-border">
                {member.lastModel ?? member.model ?? "cli default"}
              </Pill>
              {member.status === "retired" ? (
                <Pill className="border-board-border text-board-muted">retired</Pill>
              ) : null}
              {member.resident ? (
                <Pill className="border-sky-800 text-sky-300">resident</Pill>
              ) : null}
              <span className="text-board-muted">
                {member.memberships.length === 0
                  ? "no projects"
                  : `projects ${member.memberships.join(", ")}`}
              </span>
            </div>
            <Markdown>
              {member.profile.trim().length === 0 ? "_No profile yet._" : member.profile}
            </Markdown>
            <div className="text-xs text-board-muted">
              {member.claimsHeld} claim(s) held · {member.tasksDone} done · skills:{" "}
              {member.skills.length === 0 ? "none" : member.skills.join(", ")}
              {member.lastTurnOutcome === undefined ? "" : ` · last turn ${member.lastTurnOutcome}`}
            </div>
            {member.status === "active" && member.cli !== null ? (
              <div className="flex flex-wrap items-end gap-2 pt-1">
                <Field label="Scope">
                  <select
                    value={chosen ?? ""}
                    onChange={(event) => setScope(event.target.value)}
                    className={inputClass}
                  >
                    {scopes.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  onClick={() => wake.mutate("manual")}
                  disabled={wake.isPending || chosen === null}
                >
                  Wake now
                </Button>
                <Button
                  onClick={() => wake.mutate("reflection")}
                  disabled={wake.isPending || chosen === null}
                >
                  Reflect now
                </Button>
                <ErrorNote error={wake.error} />
              </div>
            ) : null}
          </div>
        )}
      </Panel>

      <Panel title="Right now">
        {live.length === 0 ? (
          <Empty>Nothing on the live stream from this citizen.</Empty>
        ) : (
          <ul className="space-y-0.5 font-mono text-xs">
            {live.map((item) => (
              <li key={item.seq} className="flex gap-2">
                <span className="shrink-0 text-board-muted">{clockTime(item.ts)}</span>
                <span className="truncate">
                  {item.event.type === "tool_call"
                    ? `${item.event.name} ${describeToolInput(item.event.input)}`
                    : item.event.type === "text"
                      ? item.event.delta
                      : item.event.type === "turn_completed"
                        ? `turn ${item.event.exitReason}${item.event.status === null ? "" : `: ${item.event.status.summary}`}`
                        : item.event.type}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Turns (${turns.data?.length ?? 0}, $${spend.toFixed(2)})`}>
        {(turns.data ?? []).length === 0 ? <Empty>No turns yet.</Empty> : null}
        <ul className="space-y-1 text-xs">
          {(turns.data ?? []).toReversed().map((turn) => (
            <li
              key={turn.id}
              className="flex flex-wrap gap-2 rounded border border-board-border bg-board-bg/60 px-2 py-1"
            >
              <span className="text-board-muted">{timeAgo(turn.ts)}</span>
              <span className={turn.outcome === "failed" ? "text-rose-300" : "text-emerald-300"}>
                {turn.trigger} on {turn.project}
              </span>
              {turn.model === null ? null : <span className="text-board-muted">{turn.model}</span>}
              {turn.costUsd > 0 ? (
                <span className="text-amber-300">${turn.costUsd.toFixed(2)}</span>
              ) : null}
              <span className="w-full truncate text-board-muted">
                {turn.summary ?? turn.error ?? ""}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Memory core">
        {memory.data === undefined ? null : memory.data.body.trim().length === 0 ? (
          <Empty>Empty.</Empty>
        ) : (
          <Markdown>{memory.data.body}</Markdown>
        )}
      </Panel>
    </div>
  );
}
