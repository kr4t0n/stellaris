import type { PendingEnrollment, Runner } from "@stellaris/shared";
import { useSearch } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { ago } from "../lib/format.js";
import { useEnrollments, useNow, useProjects, useRunners, useSession } from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { sameCode, suggestRunnerName } from "./runners.js";
import { Failure, FIELD } from "./ThreadForms.js";

/** Connected runners first, each group by name. */
function byStatus(a: Runner, b: Runner): number {
  return (
    Number(a.status !== "connected") - Number(b.status !== "connected") ||
    a.name.localeCompare(b.name)
  );
}

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

/**
 * The society's runners, one row each in columns as the citizens are: its CLIs, name, OS,
 * capabilities, the projects living on it, and whether it is connected; above them, those asking to
 * join. A runner started without a token asks the board to enroll it and prints a link here with its
 * code; approving it under a name registers it, and the runner picks up its token on its next poll.
 */
export function RunnersView() {
  const { code } = useSearch({ from: "/runners" });
  const enrollments = useEnrollments();
  const runners = useRunners();
  const projects = useProjects();
  const now = useNow(30_000);
  const waiting = enrollments.data ?? [];
  const taken = (runners.data ?? []).map((runner) => runner.name);
  const registered = (runners.data ?? []).toSorted(byStatus);
  const connected = registered.filter((runner) => runner.status === "connected").length;
  const away = registered.length - connected;
  const followed =
    code === undefined ? undefined : waiting.find((each) => sameCode(each.userCode, code));
  const ordered =
    followed === undefined ? waiting : [followed, ...waiting.filter((each) => each !== followed)];
  const living = (runner: Runner): string[] =>
    (projects.data ?? [])
      .filter((project) => project.runner === runner.name && project.archived === undefined)
      .map((project) => project.slug);

  return (
    <>
      <PaneHeader
        title="Runners"
        subtitle={[
          `${connected} connected`,
          ...(away === 0 ? [] : [`${away} away`]),
          ...(waiting.length === 0 ? [] : [`${waiting.length} waiting for approval`]),
        ].join(" · ")}
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {code !== undefined && enrollments.data !== undefined && followed === undefined ? (
          <output className="block px-2 pb-2 text-meta">
            No runner waits with the code {code}. It may have been approved, denied, or expired; a
            runner whose code expired asks again with a new one.
          </output>
        ) : null}
        {ordered.length === 0 ? null : (
          <ul aria-label="Waiting for approval" className="space-y-2 px-2 pb-3">
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
        {runners.data === undefined ? (
          <PaneNote>Reading the runners…</PaneNote>
        ) : registered.length === 0 ? (
          <p className="px-2 py-2 text-meta">No runners yet.</p>
        ) : null}
        {/* Rows are subgrids of one grid, so each column is as wide as its widest cell. */}
        <ul
          aria-label="Registered"
          className="grid grid-cols-[auto_auto_auto_minmax(0,max-content)_minmax(3rem,1fr)_auto] gap-x-3"
        >
          {registered.map((runner) => {
            const clis = runner.clis.length === 0 ? "no CLI" : runner.clis.join(", ");
            const places = living(runner);
            const lives = places.length === 0 ? "no projects" : places.join(", ");
            const state =
              runner.status === "connected"
                ? { label: "connected", detail: "connected", tone: "text-fg-muted" }
                : {
                    label: "away",
                    detail: `away${runner.lastSeen === undefined ? "" : `, last seen ${ago(runner.lastSeen, now)}`}`,
                    tone: "text-amber-300",
                  };
            return (
              <li
                key={runner.name}
                className="col-span-full grid grid-cols-subgrid items-center rounded-lg px-2 py-1.5 text-sm"
              >
                <span className="flex items-center gap-1" title={clis}>
                  {runner.clis.map((cli) => (
                    <CliIcon key={cli} cli={cli} size={13} />
                  ))}
                  <span className="sr-only">{clis}</span>
                </span>
                <span className="text-fg-primary">{runner.name}</span>
                <span className="text-fg-secondary">{runner.os}</span>
                <span
                  className="truncate text-xs text-fg-muted"
                  title={runner.capabilities.join(", ")}
                >
                  {runner.capabilities.join(", ")}
                </span>
                <span className="truncate text-xs text-fg-muted" title={lives}>
                  {lives}
                </span>
                <span className={`text-right text-xs ${state.tone}`} title={state.detail}>
                  {state.label}
                </span>
              </li>
            );
          })}
        </ul>
        {enrollments.data === undefined || waiting.length > 0 ? null : (
          <p className="mt-2 border-t border-line px-2 pt-2 text-meta">
            A runner started with STELLARIS_SERVER_URL set to this board and no token asks to join
            here, with a code to approve.
          </p>
        )}
      </div>
    </>
  );
}
