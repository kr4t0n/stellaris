import {
  runnerSyncing,
  type CliKind,
  type PendingEnrollment,
  type Runner,
} from "@stellaris/shared";
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
  syncLine,
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
 * How long a removal's button waits before it takes a press, so a double click on the bin removes
 * nothing, a slow one too: the systems' own double-click times are about 500 ms.
 */
const REMOVE_ARMS_MS = 500;

/**
 * A runner's removal, in place of its row's controls: one red button, its title and description
 * naming what it changes (the citizens pinned there, who are pinned again on their next turn, the
 * archived projects that lived there, and its token, which stops working). It takes no press for
 * its first moments, and Escape or the focus leaving it puts the controls back, or, when the focus
 * leaves while the board answers, the answer does. The board refuses while a project lives there,
 * anything runs there, or it is connected and not paused, saying what on a line under the row.
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
  /**
   * Called with how it ended: removed, put back with Escape, or left, with the board's refusal when
   * the focus left before it came, and after a removal whether the list takes the focus: unless it
   * left for a control the user moved to meanwhile.
   */
  onDone: (
    how: "removed" | "escaped" | "left",
    after?: { refused?: Error; focusList?: boolean },
  ) => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  // Whether a press is waiting for the board's answer, set as it goes, since `isPending` reaches a
  // render only after a key or click that follows at once; and whether the focus left meanwhile,
  // so the answer closes the button.
  const answering = useRef(false);
  const left = useRef(false);
  // Escape while the board answers waits for the answer, which then gives the bin the focus.
  const escaped = useRef(false);
  useEffect(() => {
    button.current?.focus();
    const timer = setTimeout(() => setArmed(true), REMOVE_ARMS_MS);
    return () => clearTimeout(timer);
  }, []);
  const remove = useMutation({
    mutationFn: () => api.removeRunner(runner),
    onSuccess: async () => {
      await Promise.all(
        ["runners", "projects", "members", "models"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
      onDone("removed", {
        focusList: !left.current || escaped.current || document.activeElement === document.body,
      });
    },
    onError: (error) => {
      if (left.current) {
        onDone(escaped.current ? "escaped" : "left", { refused: error });
      }
    },
    onSettled: () => {
      answering.current = false;
    },
  });
  const changes = [
    ...(pinned.length === 0 ? [] : [`unpins ${pinned.join(", ")}`]),
    ...(archived.length === 0 ? [] : [`clears archived ${archived.join(", ")}`]),
    "its token stops working",
  ].join(" · ");
  const described = `${changes.charAt(0).toUpperCase()}${changes.slice(1)}`;
  const waiting = !armed || remove.isPending;
  return (
    <>
      <span className="-mr-0.5 flex items-center justify-end @max-[25rem]:col-start-7 @max-[25rem]:row-start-1">
        {/* Never `disabled`, which would drop the keyboard's focus to the page. */}
        <button
          ref={button}
          type="button"
          aria-label={`Remove ${runner}`}
          title={described}
          aria-disabled={waiting}
          onClick={() => {
            if (!waiting && !answering.current) {
              answering.current = true;
              left.current = false;
              escaped.current = false;
              remove.mutate();
            }
          }}
          onKeyDown={(event) => {
            // A key held down on the bin repeats here once the button takes presses.
            if (event.repeat && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              return;
            }
            if (event.key === "Escape") {
              // Never the board's Escape, which would close it with the answer on its way.
              event.stopPropagation();
              if (answering.current) {
                left.current = true;
                escaped.current = true;
              } else {
                onDone("escaped");
              }
            }
          }}
          onBlur={() => {
            if (answering.current) {
              left.current = true;
              escaped.current = false;
            } else {
              onDone("left");
            }
          }}
          className="inline-flex h-5 shrink-0 items-center rounded-md bg-[#dc3f3f] px-1 text-xs leading-none text-white transition-colors hover:bg-[#c03434] focus-visible:ring-2 focus-visible:ring-red-400/40 focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        >
          {/* One label throughout, so the column never widens while the board answers. */}
          Remove
        </button>
      </span>
      {remove.error === null ? null : (
        <div className="col-span-full mt-1.5 mb-1">
          <Failure error={remove.error} />
        </div>
      )}
    </>
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
 * How far a runner's board sync has come, under its row: the count, a bar while the total is
 * known, and after a failed try, when the next is and why it failed.
 */
function SyncProgress({ runner, now }: { runner: Runner; now: number }) {
  const line = syncLine(runner, now);
  if (line === null) {
    return null;
  }
  return (
    <div className="col-[2/-1] mt-0.5 mb-1 min-w-0">
      <p className={`text-xs ${line.error === null ? "text-fg-secondary" : "text-amber-300"}`}>
        {line.label}
      </p>
      {line.fraction === null ? null : (
        <div aria-hidden="true" className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-fg-tertiary"
            style={{ width: `${(line.fraction * 100).toFixed(1)}%` }}
          />
        </div>
      )}
      {line.error === null ? null : (
        <p className="mt-0.5 truncate text-xs text-fg-muted" title={line.error}>
          {line.error}
        </p>
      )}
    </div>
  );
}

/**
 * The society's runners, one row each in columns as the citizens are: its CLIs, name, OS, version,
 * marked when it is not the server's, capabilities, the projects living on it, whether it is
 * connected, paused, or syncing, its pause, its rename, and its removal, and under a syncing one
 * how far its board copy has come; above them, those asking to join. A runner started without a
 * token asks the board to enroll it and prints a link here with its code; approving it under a name
 * registers it, and the runner picks up its token on its next poll, then syncs its board copy
 * before it takes a turn. Each CLI's mark pauses that CLI on the runner alone. Under them, each CLI
 * login's plan quota.
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
  // A removal's refusal that came once the focus had left it, under its row until the row's next form.
  const [refused, setRefused] = useState<{ runner: string; error: Error } | null>(null);
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
  const waiting = enrollments.data ?? [];
  const taken = (runners.data ?? []).map((runner) => runner.name);
  const registered = (runners.data ?? []).toSorted(byStatus);
  const syncing = registered.filter((runner) => runnerSyncing(runner) !== undefined).length;
  // A failed try's countdown to the next goes by the second.
  const now = useNow(syncing === 0 ? 30_000 : 1_000);
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
  const toggleForm = (runner: string, form: Form): void => {
    if (refused?.runner === runner) {
      setRefused(null);
    }
    setOpened(opened?.runner === runner && opened.form === form ? null : { runner, form });
  };

  return (
    <>
      <PaneHeader
        title="Runners"
        subtitle={[
          `${connected} connected`,
          ...(away === 0 ? [] : [`${away} away`]),
          ...(paused === 0 ? [] : [`${paused} paused`]),
          ...(limited === 0 ? [] : [`${limited} held by a limit`]),
          ...(syncing === 0 ? [] : [`${syncing} syncing`]),
          ...(waiting.length === 0 ? [] : [`${waiting.length} waiting for approval`]),
          ...(server === undefined ? [] : [`server v${server}`]),
          ...(off === 0 ? [] : [`${off} on another version`]),
          ...(unidentified === 0 ? [] : [`${unidentified} without a git identity`]),
        ].join(" · ")}
      />
      <div className="@container flex-1 overflow-y-auto px-2 py-2">
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
        {/* Rows are subgrids of one grid, so each column is as wide as its widest cell. Under 25
            root ems, which a 420 px island holds at a 16 px root font but not at a larger one, a
            row takes two lines: the marks, the name, the state, and the controls, and under the
            name the OS, the version, the capabilities, and the projects to the row's end. */}
        <ul
          ref={control("list")}
          tabIndex={-1}
          aria-label="Registered"
          className="focus-visible:outline-none grid grid-cols-[auto_auto_auto_auto_minmax(0,max-content)_minmax(2rem,1fr)_auto_auto] gap-x-3 @max-[25rem]:grid-cols-[auto_auto_auto_minmax(0,max-content)_minmax(0,1fr)_auto_auto]"
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
                <span className="@max-[25rem]:col-[2/6] @max-[25rem]:row-start-1">
                  <span className="block text-fg-primary">{runner.name}</span>
                  {gap === null ? null : (
                    <span className="block text-xs text-amber-300" title={gap.detail}>
                      {gap.label}
                    </span>
                  )}
                </span>
                <span className="text-fg-secondary @max-[25rem]:col-start-2 @max-[25rem]:row-start-2">
                  {runner.os}
                </span>
                {offVersion(runner, server) ? (
                  <span
                    className="text-xs text-amber-300 @max-[25rem]:col-start-3 @max-[25rem]:row-start-2"
                    title={`the server runs v${server}`}
                  >
                    v{runner.version}
                    <span className="sr-only">, not the server's v{server}</span>
                  </span>
                ) : (
                  <span className="text-xs text-fg-muted @max-[25rem]:col-start-3 @max-[25rem]:row-start-2">
                    {runner.version === undefined ? "" : `v${runner.version}`}
                  </span>
                )}
                <span
                  className="truncate text-xs text-fg-muted @max-[25rem]:col-start-4 @max-[25rem]:row-start-2"
                  title={runner.capabilities.join(", ")}
                >
                  {runner.capabilities.join(", ")}
                </span>
                <span
                  className="truncate text-xs text-fg-muted @max-[25rem]:col-[5/-1] @max-[25rem]:row-start-2"
                  title={lives}
                >
                  {lives}
                </span>
                {/* On one line, so the narrowest island cuts capabilities and projects before it. */}
                <span
                  className={`text-right text-xs whitespace-nowrap @max-[25rem]:col-start-6 @max-[25rem]:row-start-1 ${state.tone}`}
                  title={state.detail}
                >
                  {state.label}
                </span>
                {/* The runner's own controls share the last column, so rename and remove take no gap
                    of their own; a removal's button takes their place. */}
                {form === "remove" ? (
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
                    onDone={(how, after) => {
                      // An answer that comes after the focus left may find another form open.
                      setOpened((current) =>
                        current?.runner === runner.name && current.form === "remove"
                          ? null
                          : current,
                      );
                      if (after?.refused !== undefined) {
                        setRefused({ runner: runner.name, error: after.refused });
                      }
                      if (how === "escaped") {
                        setRefocus(`remove:${runner.name}`);
                      }
                      if (how === "removed" && after?.focusList === true) {
                        setRefocus("list");
                      }
                    }}
                  />
                ) : (
                  <span className="-mr-0.5 flex items-center @max-[25rem]:col-start-7 @max-[25rem]:row-start-1">
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
                      onClick={() => toggleForm(runner.name, "remove")}
                      className="rounded px-0.5 py-1 text-fg-tertiary transition-colors hover:bg-surface-2/70 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none"
                    >
                      <RemoveMark />
                    </button>
                  </span>
                )}
                {form !== "remove" && refused?.runner === runner.name ? (
                  <div className="col-span-full mt-1.5 mb-1">
                    <Failure error={refused.error} />
                  </div>
                ) : null}
                <SyncProgress runner={runner} now={now} />
                {form === "rename" ? (
                  <RenameRunner
                    runner={runner.name}
                    onDone={(renamed) => {
                      setOpened(null);
                      setRefocus(`rename:${renamed ?? runner.name}`);
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
