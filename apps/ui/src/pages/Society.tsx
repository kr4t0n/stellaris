import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardEvent } from "@stellaris/shared";
import { useState } from "react";
import { api } from "../api/client.js";
import { Button, Empty, ErrorNote, Field, inputClass, Panel, Pill } from "../components/ui.js";
import { shortId, timeAgo } from "../lib/format.js";

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function Operations({ events }: { events: readonly BoardEvent[] }) {
  const completed = events.filter((event) => event.type === "turn.completed");
  const failed = events.filter((event) => event.type === "turn.failed");
  const merges = events.filter((event) => event.type === "merge.completed");
  const mergeFailures = events.filter((event) => event.type === "merge.failed");
  const cost = completed.reduce((sum, event) => sum + numberOf(event.payload["costUsd"]), 0);
  const turns = events
    .filter((event) => event.type === "turn.completed" || event.type === "turn.failed")
    .slice(-15)
    .toReversed();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Turns completed", completed.length],
          ["Turns failed", failed.length],
          ["Merges landed", merges.length],
          ["Merges failed", mergeFailures.length],
          ["Metered spend", `$${cost.toFixed(2)}`],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="rounded border border-board-border bg-board-bg/60 p-3"
          >
            <div className="text-xs text-board-muted">{label}</div>
            <div className="text-lg font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <ul className="space-y-1 text-xs">
        {turns.map((event) => (
          <li
            key={event.id}
            className="flex gap-2 rounded border border-board-border bg-board-bg/60 px-2 py-1"
          >
            <span className="text-board-muted">{timeAgo(event.ts)}</span>
            <span className={event.type === "turn.failed" ? "text-rose-300" : "text-emerald-300"}>
              {event.actor} · {stringOf(event.payload["trigger"])}
            </span>
            <span className="truncate text-board-muted">
              {stringOf(event.payload["summary"]) || stringOf(event.payload["error"])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Society: who is here, how the scheduler is doing, and what governance is waiting. */
export function SocietyPage() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const roles = useQuery({ queryKey: ["roles"], queryFn: api.roles });
  const runners = useQuery({ queryKey: ["runners"], queryFn: api.runners });
  const proposals = useQuery({ queryKey: ["proposals"], queryFn: api.proposals });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const scheduler = useQuery({
    queryKey: ["scheduler"],
    queryFn: api.scheduler,
    refetchInterval: 5_000,
  });
  const events = useQuery({ queryKey: ["events"], queryFn: () => api.events(null, 2000) });
  const toggle = useMutation({
    mutationFn: () => (scheduler.data?.paused ? api.resume() : api.pause()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const members = (agents.data ?? []).filter((agent) => agent.cli !== null);
  const [wakeAgent, setWakeAgent] = useState("");
  const [wakeProject, setWakeProject] = useState("");
  const wake = useMutation({
    mutationFn: () => api.wake(wakeAgent, wakeProject, "manual wake from the board"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scheduler"] }),
  });
  const agentForWake = members.find((agent) => agent.name === wakeAgent);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Society</h1>

      <Panel
        title="Scheduler"
        actions={
          <Button
            tone={scheduler.data?.paused ? "primary" : "danger"}
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
          >
            {scheduler.data?.paused ? "Resume" : "Pause all wakeups"}
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill
            className={
              scheduler.data?.paused
                ? "border-amber-800 text-amber-300"
                : "border-emerald-800 text-emerald-300"
            }
          >
            {scheduler.data?.paused ? "paused" : "running"}
          </Pill>
          {(scheduler.data?.running ?? []).map((pair) => (
            <Pill key={pair} className="border-emerald-800 text-emerald-300">
              {pair} in a turn
            </Pill>
          ))}
          {(scheduler.data?.pending ?? []).map((pair) => (
            <Pill key={pair} className="border-board-border text-board-muted">
              {pair} queued
            </Pill>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (wakeAgent.length > 0 && wakeProject.length > 0) wake.mutate();
          }}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <Field label="Wake agent">
            <select
              value={wakeAgent}
              onChange={(event) => setWakeAgent(event.target.value)}
              className={inputClass}
            >
              <option value="">choose</option>
              {members.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="On project">
            <select
              value={wakeProject}
              onChange={(event) => setWakeProject(event.target.value)}
              className={inputClass}
            >
              <option value="">choose</option>
              {(
                agentForWake?.memberships ?? (projects.data ?? []).map((project) => project.slug)
              ).map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </Field>
          <Button
            type="submit"
            disabled={wake.isPending || wakeAgent.length === 0 || wakeProject.length === 0}
          >
            Wake now
          </Button>
          <ErrorNote error={wake.error ?? toggle.error} />
        </form>
      </Panel>

      <Panel title={`Members (${members.length})`}>
        {members.length === 0 ? <Empty>No agents yet. Add one with the admin CLI.</Empty> : null}
        <table className="w-full text-left text-sm">
          <tbody>
            {members.map((agent) => (
              <tr key={agent.name} className="border-t border-board-border">
                <td className="py-1.5 pr-2 font-semibold">{agent.name}</td>
                <td className="py-1.5 pr-2">{agent.role}</td>
                <td className="py-1.5 pr-2 text-board-muted">{agent.cli}</td>
                <td className="py-1.5 pr-2 text-board-muted">
                  {agent.memberships.join(", ") || "no projects"}
                </td>
                <td className="py-1.5 text-board-muted">{agent.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Roles">
        <ul className="space-y-2 text-sm">
          {(roles.data ?? []).map((role) => (
            <li key={role.name} className="rounded border border-board-border bg-board-bg/60 p-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{role.name}</span>
                <span className="text-xs text-board-muted">repo: {role.repoPermission}</span>
              </div>
              <p className="mt-1 text-board-muted">{role.purpose}</p>
              <p className="mt-1 text-xs text-board-muted">verbs: {role.verbs.join(", ")}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Runners">
        <ul className="text-sm">
          {(runners.data ?? []).map((runner) => (
            <li key={runner.name} className="flex gap-3">
              <span className="font-semibold">{runner.name}</span>
              <span className="text-board-muted">{runner.os}</span>
              <span className="text-board-muted">
                {runner.capabilities.join(", ") || "no declared capabilities"}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`Proposals (${(proposals.data ?? []).length})`}>
        {(proposals.data ?? []).length === 0 ? <Empty>No proposals yet.</Empty> : null}
        <ul className="space-y-1 text-sm">
          {(proposals.data ?? []).toReversed().map((proposal) => (
            <li key={proposal.id} className="flex gap-3">
              <span className="text-board-muted">{shortId(proposal.id)}</span>
              <span>{proposal.kind}</span>
              <span className="text-board-muted">by @{proposal.proposedBy}</span>
              <Pill className="border-board-border">{proposal.status}</Pill>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Operations">
        <Operations events={events.data ?? []} />
      </Panel>
    </div>
  );
}
