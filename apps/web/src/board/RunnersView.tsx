import type { CliKind, PendingEnrollment, Runner } from "@stellaris/shared";
import { useSearch } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { ago } from "../lib/format.js";
import {
  useEnrollments,
  useMembers,
  useNow,
  useProjects,
  useRunners,
  useServerVersion,
  useSession,
} from "../lib/session.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { PlanQuota } from "./Quota.js";
import {
  heldClis,
  identityGap,
  offVersion,
  runnerState,
  sameCode,
  suggestRunnerName,
} from "./runners.js";
import { Failure, FIELD } from "./ThreadForms.js";

/** The forms a runner's row opens under it. */
type Form = "rename" | "remove";

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
  // The suggestion follows the runners list, which may arrive or change after the enrollment, until
  // the user types a name of their own.
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? suggestRunnerName(enrollment.hostname, taken);
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
  const field = useRef<HTMLInputElement>(null);

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
          // As in a rename, a refusal leaves the focus in the field.
          field.current?.focus();
          if (!busy && name.trim() !== "") {
            approve.mutate();
          }
        }}
      >
        <input
          ref={field}
          value={name}
          maxLength={32}
          spellCheck={false}
          aria-label="Runner name"
          onChange={(event) => setTyped(event.target.value)}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <Button
          aria-disabled={busy}
          onClick={() => {
            if (!busy) {
              deny.mutate();
            }
          }}
        >
          Deny
        </Button>
        <Button variant="primary" type="submit" aria-disabled={busy || name.trim() === ""}>
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
      </form>
      <div className="mt-1.5">
        <Failure error={approve.error ?? deny.error} />
      </div>
    </li>
  );
}

/** Two bars to pause, a triangle to resume. Decorative: its button's label says what it does. */
function PauseMark({ paused }: { paused: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" className="shrink-0">
      <path
        d={paused ? "M3 1.5v9l7.5-4.5z" : "M2.5 1.5h2.5v9h-2.5zM7 1.5h2.5v9h-2.5z"}
        fill="currentColor"
      />
    </svg>
  );
}

/** A pencil, to rename. Decorative: its button's label says what it does. */
function RenameMark() {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" className="shrink-0">
      <path
        d="M8.25 1.5l2.25 2.25-6.5 6.5H1.75V8z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A bin, to remove. Decorative: its button's label says what it does. */
function RemoveMark() {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true" className="shrink-0">
      <path
        d="M1.75 3h8.5M4.5 3V1.75h3V3M2.75 3l.5 7.25h5.5L9.25 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The removal of a runner, under its row: what it changes, the citizens pinned there, who are
 * pinned again on their next turn, the archived projects that lived there, and its token, which
 * stops working. The board refuses while a project lives there, anything runs there, or it is
 * connected and not paused, saying what.
 */
function RemoveRunner({
  runner,
  pinned,
  archived,
  onDone,
}: {
  runner: string;
  pinned: readonly string[];
  archived: readonly string[];
  onDone: (removed: boolean) => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const remove = useMutation({
    mutationFn: () => api.removeRunner(runner),
    onSuccess: async () => {
      await Promise.all(
        ["runners", "projects", "members", "models"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onDone(true);
    },
  });
  const changes = [
    ...(pinned.length === 0 ? [] : [`unpins ${pinned.join(", ")}`]),
    ...(archived.length === 0 ? [] : [`clears archived ${archived.join(", ")}`]),
    "its token stops working",
  ].join(" · ");
  return (
    <form
      aria-label={`Remove ${runner}`}
      className="col-span-full mt-1.5 mb-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!remove.isPending) {
          remove.mutate();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-meta">
          {changes.charAt(0).toUpperCase()}
          {changes.slice(1)}
        </p>
        {/* Never `disabled`, which would drop the keyboard's focus to the page. */}
        <Button
          ref={cancel}
          aria-disabled={remove.isPending}
          onClick={() => {
            if (!remove.isPending) {
              onDone(false);
            }
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" type="submit" aria-disabled={remove.isPending}>
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
      <div className="mt-1.5">
        <Failure error={remove.error} />
      </div>
    </form>
  );
}

/**
 * A runner's new name, under its row. The board renames it with every project, pin, and session
 * that names it, and refuses while anything runs there, saying what; the runner keeps its token.
 */
function RenameRunner({ runner, onDone }: { runner: string; onDone: (renamed?: string) => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [name, setName] = useState(runner);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.select(), []);
  const rename = useMutation({
    mutationFn: () => api.renameRunner(runner, name.trim()),
    onSuccess: async (renamed) => {
      await Promise.all(
        ["runners", "projects", "members", "models"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onDone(renamed.runner.name);
    },
  });
  const unchanged = name.trim() === "" || name.trim() === runner;
  return (
    <form
      aria-label={`Rename ${runner}`}
      className="col-span-full mt-1.5 mb-1"
      onSubmit={(event) => {
        event.preventDefault();
        // The focus waits in the field, wherever the press came from, so a refusal leaves it
        // where the name is changed.
        field.current?.focus();
        if (!unchanged && !rename.isPending) {
          rename.mutate();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={field}
          value={name}
          maxLength={32}
          spellCheck={false}
          aria-label="New name"
          onChange={(event) => setName(event.target.value)}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        {/* Never `disabled`, which would drop the keyboard's focus to the page. */}
        <Button
          aria-disabled={rename.isPending}
          onClick={() => {
            if (!rename.isPending) {
              onDone();
            }
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" type="submit" aria-disabled={rename.isPending || unchanged}>
          {rename.isPending ? "Renaming…" : "Rename"}
        </Button>
      </div>
      <div className="mt-1.5">
        <Failure error={rename.error} />
      </div>
    </form>
  );
}

/**
 * The society's runners, one row each in columns as the citizens are: its CLIs, name, OS, version,
 * marked when it is not the server's, capabilities, the projects living on it, whether it is
 * connected or paused, its pause, its rename, and its removal; above them, those asking to join. A runner started without a
 * token asks the board to enroll it and prints a link here with its code; approving it under a name
 * registers it, and the runner picks up its token on its next poll. Each CLI's mark pauses that CLI
 * on the runner alone. Under them, each CLI login's plan quota.
 */
export function RunnersView() {
  const { code } = useSearch({ from: "/runners" });
  const { api } = useSession();
  const client = useQueryClient();
  // Pending until the runners are read again, so a control never offers the state it just left.
  // A press meanwhile does nothing, a second one before the next render included, which is why
  // a ref holds it; the control stays enabled, so it keeps the keyboard's focus.
  const changing = useRef(false);
  const pause = useMutation({
    mutationFn: ({ runner, paused, cli }: { runner: string; paused: boolean; cli?: CliKind }) =>
      api.setRunnerPaused(runner, paused, cli),
    onSettled: async () => {
      try {
        await client.invalidateQueries({ queryKey: ["runners"] });
      } finally {
        changing.current = false;
      }
    },
  });
  const toggle = (change: { runner: string; paused: boolean; cli?: CliKind }): void => {
    if (!changing.current) {
      changing.current = true;
      pause.mutate(change);
    }
  };
  // The runner whose rename or removal is open, and the control that takes the focus back when it
  // closes, a rename's under the name it has then; after a removal, the list has it.
  const [opened, setOpened] = useState<{ runner: string; form: Form } | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const controls = useRef(new Map<string, HTMLElement>());
  const control = (key: string) => (element: HTMLElement | null) => {
    if (element === null) {
      controls.current.delete(key);
    } else {
      controls.current.set(key, element);
    }
  };
  const members = useMembers();
  const enrollments = useEnrollments();
  const runners = useRunners();
  const projects = useProjects();
  const server = useServerVersion().data;
  const now = useNow(30_000);
  const waiting = enrollments.data ?? [];
  const taken = (runners.data ?? []).map((runner) => runner.name);
  const registered = (runners.data ?? []).toSorted(byStatus);
  const connected = registered.filter((runner) => runner.status === "connected").length;
  const away = registered.length - connected;
  const off = registered.filter((runner) => offVersion(runner, server)).length;
  const unidentified = registered.filter((runner) => identityGap(runner) !== null).length;
  const paused = registered.filter(
    (runner) =>
      runner.paused !== undefined ||
      runner.clis.some((cli) => runner.pausedClis?.[cli] !== undefined),
  ).length;
  const limited = registered.filter((runner) =>
    heldClis(runner, now).some((hold) => !hold.paused),
  ).length;
  const followed =
    code === undefined ? undefined : waiting.find((each) => sameCode(each.userCode, code));
  const ordered =
    followed === undefined ? waiting : [followed, ...waiting.filter((each) => each !== followed)];
  useEffect(() => {
    const element = refocus === null ? undefined : controls.current.get(refocus);
    if (element !== undefined) {
      element.focus();
      setRefocus(null);
    }
  }, [refocus, controls]);
  const living = (runner: Runner): string[] =>
    (projects.data ?? [])
      .filter((project) => project.runner === runner.name && project.archived === undefined)
      .map((project) => project.slug);
  const toggleForm = (runner: string, form: Form): void =>
    setOpened(opened?.runner === runner && opened.form === form ? null : { runner, form });

  return (
    <>
      <PaneHeader
        title="Runners"
        subtitle={[
          `${connected} connected`,
          ...(away === 0 ? [] : [`${away} away`]),
          ...(paused === 0 ? [] : [`${paused} paused`]),
          ...(limited === 0 ? [] : [`${limited} held by a limit`]),
          ...(waiting.length === 0 ? [] : [`${waiting.length} waiting for approval`]),
          ...(server === undefined ? [] : [`server v${server}`]),
          ...(off === 0 ? [] : [`${off} on another version`]),
          ...(unidentified === 0 ? [] : [`${unidentified} without a git identity`]),
        ].join(" · ")}
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {code !== undefined && enrollments.data !== undefined && followed === undefined ? (
          <output className="block px-2 pb-2 text-meta">
            No runner waits with the code {code}.
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
          ref={control("list")}
          tabIndex={-1}
          aria-label="Registered"
          className="focus-visible:outline-none grid grid-cols-[auto_auto_auto_auto_minmax(0,max-content)_minmax(2rem,1fr)_auto_auto] gap-x-3"
        >
          {registered.map((runner) => {
            const clis = runner.clis.length === 0 ? "no CLI" : runner.clis.join(", ");
            const places = living(runner);
            const lives = places.length === 0 ? "no projects" : places.join(", ");
            const gap = identityGap(runner);
            const state = runnerState(runner, now);
            const form = opened?.runner === runner.name ? opened.form : null;
            return (
              <li
                key={runner.name}
                className="col-span-full grid grid-cols-subgrid items-center rounded-lg px-2 py-1.5 text-sm"
              >
                <span className="flex items-center">
                  {runner.clis.map((cli) => {
                    const held = runner.pausedClis?.[cli] !== undefined;
                    const label = `${held ? "Resume" : "Pause"} ${cli} on ${runner.name}`;
                    return (
                      <button
                        key={cli}
                        type="button"
                        aria-label={label}
                        title={label}
                        aria-disabled={pause.isPending}
                        onClick={() => toggle({ runner: runner.name, paused: !held, cli })}
                        className={`rounded p-0.5 transition-opacity hover:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none ${held ? "opacity-30 hover:opacity-60" : ""}`}
                      >
                        <CliIcon cli={cli} size={13} />
                      </button>
                    );
                  })}
                  <span className="sr-only">{clis}</span>
                </span>
                {/* A gap in the account's git identity sits under the name, so it takes no column. */}
                <span>
                  <span className="block text-fg-primary">{runner.name}</span>
                  {gap === null ? null : (
                    <span className="block text-xs text-amber-300" title={gap.detail}>
                      {gap.label}
                    </span>
                  )}
                </span>
                <span className="text-fg-secondary">{runner.os}</span>
                {offVersion(runner, server) ? (
                  <span className="text-xs text-amber-300" title={`the server runs v${server}`}>
                    v{runner.version}
                    <span className="sr-only">, not the server's v{server}</span>
                  </span>
                ) : (
                  <span className="text-xs text-fg-muted">
                    {runner.version === undefined ? "" : `v${runner.version}`}
                  </span>
                )}
                <span
                  className="truncate text-xs text-fg-muted"
                  title={runner.capabilities.join(", ")}
                >
                  {runner.capabilities.join(", ")}
                </span>
                <span className="truncate text-xs text-fg-muted" title={lives}>
                  {lives}
                </span>
                {/* On one line, so the narrowest island cuts capabilities and projects before it. */}
                <span
                  className={`text-right text-xs whitespace-nowrap ${state.tone}`}
                  title={state.detail}
                >
                  {state.label}
                </span>
                {/* The runner's own controls share the last column, so rename and remove take no gap of their own. */}
                <span className="-mr-0.5 flex items-center">
                  <button
                    type="button"
                    aria-label={`${runner.paused === undefined ? "Pause" : "Resume"} ${runner.name}`}
                    title={`${runner.paused === undefined ? "Pause" : "Resume"} ${runner.name}`}
                    aria-disabled={pause.isPending}
                    onClick={() =>
                      toggle({ runner: runner.name, paused: runner.paused === undefined })
                    }
                    className="rounded px-0.5 py-1 text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
                  >
                    <PauseMark paused={runner.paused !== undefined} />
                  </button>
                  <button
                    type="button"
                    ref={control(`rename:${runner.name}`)}
                    aria-label={`Rename ${runner.name}…`}
                    title={`Rename ${runner.name}…`}
                    aria-expanded={form === "rename"}
                    onClick={() => toggleForm(runner.name, "rename")}
                    className="rounded px-0.5 py-1 text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
                  >
                    <RenameMark />
                  </button>
                  <button
                    type="button"
                    ref={control(`remove:${runner.name}`)}
                    aria-label={`Remove ${runner.name}…`}
                    title={`Remove ${runner.name}…`}
                    aria-expanded={form === "remove"}
                    onClick={() => toggleForm(runner.name, "remove")}
                    className="rounded px-0.5 py-1 text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
                  >
                    <RemoveMark />
                  </button>
                </span>
                {form === "rename" ? (
                  <RenameRunner
                    runner={runner.name}
                    onDone={(renamed) => {
                      setOpened(null);
                      setRefocus(`rename:${renamed ?? runner.name}`);
                    }}
                  />
                ) : form === "remove" ? (
                  <RemoveRunner
                    runner={runner.name}
                    pinned={(members.data ?? [])
                      .filter((member) => member.homeRunner === runner.name)
                      .map((member) => member.name)}
                    archived={(projects.data ?? [])
                      .filter(
                        (project) =>
                          project.runner === runner.name && project.archived !== undefined,
                      )
                      .map((project) => project.slug)}
                    onDone={(removed) => {
                      setOpened(null);
                      setRefocus(removed ? "list" : `remove:${runner.name}`);
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="px-2">
          <Failure error={pause.error} />
        </div>
        <PlanQuota runners={registered} now={now} />
      </div>
    </>
  );
}
