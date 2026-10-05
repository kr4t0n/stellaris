import type { PendingEnrollment, Project, Runner } from "@stellaris/shared";
import { useSearch } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { ago } from "../lib/format.js";
import { useEnrollments, useNow, useProjects, useRunners, useSession } from "../lib/session.js";
import { Section } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { sameCode, suggestRunnerName } from "./runners.js";
import { Failure, FIELD } from "./ThreadForms.js";

function offers(clis: readonly string[], capabilities: readonly string[]): string {
  return [clis.length === 0 ? "no CLI" : clis.join(", "), ...capabilities].join(" · ");
}

/** One runner waiting to join: what its machine offers, and the name it would join under. */
function WaitingRunner({
  enrollment,
  taken,
  followed,
  now,
}: {
  enrollment: PendingEnrollment;
  taken: readonly string[];
  /** Whether this is the code the address named, as when the user followed the runner's link. */
  followed: boolean;
  now: number;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const [name, setName] = useState(() => suggestRunnerName(enrollment.hostname, taken));
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ["enrollments"] });
    void client.invalidateQueries({ queryKey: ["runners"] });
  };
  const approve = useMutation({
    mutationFn: () => api.approveEnrollment(enrollment.userCode, name.trim()),
    onSuccess: refresh,
  });
  const deny = useMutation({
    mutationFn: () => api.denyEnrollment(enrollment.userCode),
    onSuccess: refresh,
  });
  const busy = approve.isPending || deny.isPending;

  return (
    <li
      className={`rounded-xl border px-3 py-3 ${followed ? "border-amber-500/40 bg-amber-500/5" : "border-line"}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
          {enrollment.hostname}
        </span>
        <code className="shrink-0 font-mono text-sm text-fg-primary">{enrollment.userCode}</code>
      </div>
      <p className="mt-0.5 truncate text-meta">
        {enrollment.os} · {offers(enrollment.clis, enrollment.capabilities)} · runner{" "}
        {enrollment.version} · asked {ago(enrollment.requestedAt, now)}
      </p>
      <form
        aria-label={`Approve ${enrollment.hostname}`}
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          approve.mutate();
        }}
      >
        <input
          value={name}
          maxLength={32}
          spellCheck={false}
          aria-label="Runner name"
          onChange={(event) => setName(event.target.value)}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <Button onClick={() => deny.mutate()} disabled={busy}>
          Deny
        </Button>
        <Button variant="primary" type="submit" disabled={busy || name.trim() === ""}>
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
      </form>
      <div className="mt-1.5">
        <Failure error={approve.error ?? deny.error} />
      </div>
    </li>
  );
}

function RunnerRow({
  runner,
  projects,
  now,
}: {
  runner: Runner;
  projects: Project[];
  now: number;
}) {
  const living = projects
    .filter((project) => project.runner === runner.name && project.archived === undefined)
    .map((project) => project.slug);
  return (
    <li className="py-1.5">
      <p className="flex items-baseline gap-2 text-sm">
        <span
          aria-hidden="true"
          className={runner.status === "connected" ? "text-emerald-400" : "text-fg-muted"}
        >
          ●
        </span>
        <span className="text-fg-primary">{runner.name}</span>
        <span className="min-w-0 flex-1 truncate text-meta">
          {runner.status === "connected"
            ? "connected"
            : `away${runner.lastSeen === undefined ? "" : `, last seen ${ago(runner.lastSeen, now)}`}`}{" "}
          · {runner.os} · {offers(runner.clis, runner.capabilities)}
        </span>
      </p>
      {living.length === 0 ? null : (
        <p className="ml-5 truncate text-meta">projects: {living.join(", ")}</p>
      )}
    </li>
  );
}

/**
 * The society's runners and those asking to join. A runner started without a token asks the board
 * to enroll it and prints a link here with its code; approving it under a name registers it, and
 * the runner picks up its token on its next poll.
 */
export function RunnersView() {
  const { code } = useSearch({ from: "/runners" });
  const enrollments = useEnrollments();
  const runners = useRunners();
  const projects = useProjects();
  const now = useNow(30_000);
  const waiting = enrollments.data ?? [];
  const taken = (runners.data ?? []).map((runner) => runner.name);
  const connected = (runners.data ?? []).filter((runner) => runner.status === "connected").length;
  const followed =
    code === undefined ? undefined : waiting.find((each) => sameCode(each.userCode, code));
  const ordered =
    followed === undefined ? waiting : [followed, ...waiting.filter((each) => each !== followed)];

  return (
    <>
      <PaneHeader
        title="Runners"
        subtitle={`${connected} connected · ${waiting.length === 0 ? "none" : waiting.length} waiting for approval`}
      />
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="Waiting for approval">
          {code !== undefined && enrollments.data !== undefined && followed === undefined ? (
            <output className="mb-2 block text-meta">
              No runner waits with the code {code}. It may have been approved, denied, or expired; a
              runner whose code expired asks again with a new one.
            </output>
          ) : null}
          {enrollments.data === undefined ? (
            <p className="text-meta">Reading the runners that wait…</p>
          ) : waiting.length === 0 ? (
            <p className="text-meta">
              None. A runner started with STELLARIS_SERVER_URL set to this board and no token prints
              a code to approve here.
            </p>
          ) : (
            <ul className="space-y-2">
              {ordered.map((enrollment) => (
                <WaitingRunner
                  key={enrollment.userCode}
                  enrollment={enrollment}
                  taken={taken}
                  followed={enrollment === followed}
                  now={now}
                />
              ))}
            </ul>
          )}
        </Section>
        <Section title="Registered">
          {runners.data === undefined ? (
            <PaneNote>Reading the runners…</PaneNote>
          ) : runners.data.length === 0 ? (
            <p className="text-meta">No runners yet.</p>
          ) : (
            <ul>
              {runners.data.map((runner) => (
                <RunnerRow
                  key={runner.name}
                  runner={runner}
                  projects={projects.data ?? []}
                  now={now}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
