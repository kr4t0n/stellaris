import { localTime, SOCIETY_SCOPE, type Member } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { CliIcon } from "../components/CliIcon.js";
import { Markdown } from "../components/Markdown.js";
import type { CronRecord } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  useCrons,
  useMembers,
  useNow,
  useProjects,
  useSession,
  useSociety,
  useThreads,
} from "../lib/session.js";
import { scopeName, wakeScopes } from "./citizen.js";
import { cronGroups, cronPlace, failingCron, schedulePreview } from "./crons.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { Failure, FIELD } from "./ThreadForms.js";

const SELECT = "rounded-md bg-surface-2/60 px-2 py-1 text-xs text-fg-primary outline-none";

/** A moment in the society's zone, as a clock there reads it. */
function clockIn(date: Date | string, zone: string): string {
  return localTime(typeof date === "string" ? new Date(date) : date, zone);
}

/** Where a cron fires, linked to that thread or channel; a home is named, since it has no view. */
function Place({ cron }: { cron: CronRecord }) {
  const threads = useThreads();
  const place = cronPlace(cron);
  if (place.kind === "thread") {
    const title = threads.data?.find((thread) => thread.id === place.id)?.title ?? place.id;
    return (
      <Link
        to="/thread/$threadId"
        params={{ threadId: place.id }}
        className="truncate hover:text-fg-primary"
      >
        thread “{title}”
      </Link>
    );
  }
  if (place.kind === "channel") {
    return (
      <Link to="/c/$" params={{ _splat: place.ref }} className="hover:text-fg-primary">
        #{place.ref}
      </Link>
    );
  }
  return <span>home at {scopeName(place.scope)}</span>;
}

/** One cron: whom it wakes and when, and, opened, its note, its next fires, and what can be done. */
function CronRow({
  cron,
  next,
  member,
  zone,
  now,
}: {
  cron: CronRecord;
  next: Date | null;
  member: Member | undefined;
  zone: string;
  now: number;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = (): void => void client.invalidateQueries({ queryKey: ["crons"] });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.pauseCron(cron.id, paused),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.removeCron(cron.id, reason.trim()),
    onSuccess: refresh,
  });
  const schedule =
    "at" in cron.schedule
      ? `once, ${clockIn(cron.schedule.at, zone)}`
      : `${cron.schedule.cron} · ${cron.schedule.timezone ?? zone}`;
  const state =
    cron.ended !== undefined
      ? `ended ${ago(cron.ended.at, now)}`
      : cron.paused !== undefined
        ? "paused"
        : next === null
          ? "no time to come"
          : next.getTime() <= now
            ? "due, waiting for its turn"
            : ago(next.toISOString(), now);
  const failing = failingCron(cron);

  return (
    <li className="rounded-lg">
      <details className="group">
        <summary className="cursor-pointer list-none rounded-lg px-2 py-2 hover:bg-surface-2/40 focus-visible:ring-2 focus-visible:ring-fg-primary/30 focus-visible:outline-none">
          <div className="flex items-baseline gap-2 text-sm">
            {member?.cli === undefined || member.cli === null ? null : (
              <CliIcon cli={member.cli} size={13} />
            )}
            <span className="shrink-0 text-fg-secondary">{cron.agent}</span>
            <span className="min-w-0 flex-1 truncate text-fg-primary">{cron.title}</span>
            <span
              className={`shrink-0 text-xs ${cron.paused !== undefined ? "text-amber-300" : "text-fg-muted"}`}
              title={next === null ? undefined : `${clockIn(next, zone)}, ${zone}`}
            >
              {state}
            </span>
          </div>
          <p className="mt-0.5 flex items-baseline gap-1.5 truncate text-meta">
            <code className="font-mono">{schedule}</code>
            <span aria-hidden="true">·</span>
            <Place cron={cron} />
            {cron.lastRun === undefined ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  last turn {cron.lastRun.outcome} {ago(cron.lastRun.at, now)}
                </span>
              </>
            )}
            {failing ? (
              <span className="text-amber-300">· {cron.failures} failed in a row</span>
            ) : null}
          </p>
        </summary>
        <div className="space-y-3 px-2 pt-1 pb-3">
          <div className="rounded-lg bg-surface-2/30 px-3 py-2">
            <Markdown text={cron.note} />
          </div>
          <p className="text-meta">
            Set by {cron.createdBy} {ago(cron.createdAt, now)}
            {cron.lastFiredAt === undefined
              ? ""
              : ` · fired last ${clockIn(cron.lastFiredAt, zone)}`}
            {cron.ended === undefined ? "" : ` · ended by ${cron.ended.by}: ${cron.ended.reason}`}
          </p>
          {next === null ? null : (
            <p className="text-meta">
              Next {clockIn(next, zone)} ({zone})
            </p>
          )}
          {cron.lastRun === undefined ? null : (
            <Link
              to="/citizen/$name"
              params={{ name: cron.agent }}
              search={{ tab: "turns", turn: cron.lastRun.turnId }}
              className="text-meta underline-offset-2 hover:text-fg-primary hover:underline"
            >
              Open its last turn
            </Link>
          )}
          {cron.ended !== undefined ? null : removing ? (
            <form
              aria-label={`Remove ${cron.title}`}
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                remove.mutate();
              }}
            >
              <input
                value={reason}
                aria-label="Why it ends"
                placeholder="Why it ends, which the cron keeps"
                onChange={(event) => setReason(event.target.value)}
                className={FIELD}
              />
              <div className="flex items-center justify-end gap-2">
                <Button onClick={() => setRemoving(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={remove.isPending || reason.trim() === ""}
                >
                  {remove.isPending ? "Removing…" : "Remove cron"}
                </Button>
              </div>
              <Failure error={remove.error} />
            </form>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button
                onClick={() => pause.mutate(cron.paused === undefined)}
                disabled={pause.isPending}
              >
                {cron.paused === undefined ? "Pause" : "Resume"}
              </Button>
              <Button onClick={() => setRemoving(true)}>Remove…</Button>
              <Failure error={pause.error} />
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

/** The society's time zone: crons that name none are read in it, and every prompt tells the time in it. */
function TimezoneForm({ zone, onDone }: { zone: string; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [value, setValue] = useState(zone);
  const browser = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const save = useMutation({
    mutationFn: () => api.setTimezone(value.trim()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["society"] });
      void client.invalidateQueries({ queryKey: ["crons"] });
      onDone();
    },
  });
  return (
    <form
      aria-label="Time zone"
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={value}
          list="time-zones"
          spellCheck={false}
          aria-label="Society time zone"
          onChange={(event) => setValue(event.target.value)}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <datalist id="time-zones">
          {["UTC", ...zones].map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </datalist>
        {browser === value ? null : (
          <Button onClick={() => setValue(browser)}>Use {browser}</Button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-fg-muted">
        Crons that name no zone are read in it, so their times move with it, and every turn's prompt
        tells the time in it.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={save.isPending || value.trim() === "" || value.trim() === zone}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Failure error={save.error} />
    </form>
  );
}

type Kind = "repeats" | "once";

/** Sets a cron for a citizen, showing the next fires it would have before anything is sent. */
function NewCronForm({
  members,
  preferred,
  zone,
  onDone,
}: {
  members: readonly Member[];
  preferred: string | undefined;
  zone: string;
  onDone: () => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const projects = useProjects();
  const society = useSociety();
  const [agent, setAgent] = useState(
    members.find((each) => each.name === preferred)?.name ?? members[0]?.name ?? "",
  );
  const member = members.find((each) => each.name === agent);
  const scopes = member === undefined ? [] : wakeScopes(member);
  const [scope, setScope] = useState(scopes[0] ?? SOCIETY_SCOPE);
  const [channel, setChannel] = useState("");
  const [kind, setKind] = useState<Kind>("repeats");
  const [expression, setExpression] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState("");
  const [at, setAt] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const now = useNow(30_000);

  // The place's channels a conversation of its own runs in: every one but general.
  const channels = (
    scope === SOCIETY_SCOPE
      ? (society.data?.channels ?? [])
      : (projects.data?.find((project) => project.slug === scope)?.channels ?? [])
  ).filter((name) => name !== "general");
  const schedule =
    kind === "repeats"
      ? {
          cron: expression,
          ...(timezone.trim() === "" ? {} : { timezone: timezone.trim() }),
        }
      : { at: at === "" ? "" : new Date(at).toISOString() };
  const preview = schedulePreview(
    kind === "once" && at === "" ? { at: "invalid" } : schedule,
    zone,
    new Date(now),
  );
  const readIn = kind === "repeats" ? (timezone.trim() === "" ? zone : timezone.trim()) : zone;

  const create = useMutation({
    mutationFn: () =>
      api.createCron({
        agent,
        title: title.trim(),
        note: note.trim(),
        project: scope,
        ...(channel === "" ? {} : { channel }),
        ...schedule,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["crons"] });
      onDone();
    },
  });

  return (
    <form
      aria-label="New cron"
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-tertiary">
        <label className="flex items-center gap-1.5">
          wakes
          <select
            value={agent}
            aria-label="Citizen"
            onChange={(event) => {
              const next = members.find((each) => each.name === event.target.value);
              setAgent(event.target.value);
              setScope(next === undefined ? SOCIETY_SCOPE : (wakeScopes(next)[0] ?? SOCIETY_SCOPE));
              setChannel("");
            }}
            className={SELECT}
          >
            {members.map((each) => (
              <option key={each.name} value={each.name}>
                {each.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          at
          <select
            value={scope}
            aria-label="Where"
            onChange={(event) => {
              setScope(event.target.value);
              setChannel("");
            }}
            className={SELECT}
          >
            {scopes.map((each) => (
              <option key={each} value={each}>
                {scopeName(each)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          in
          <select
            value={channel}
            aria-label="Conversation"
            onChange={(event) => setChannel(event.target.value)}
            className={SELECT}
          >
            <option value="">its home</option>
            {channels.map((each) => (
              <option key={each} value={each}>
                #{each}
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        ref={field}
        value={title}
        maxLength={120}
        aria-label="Title"
        placeholder="Title, such as Morning report"
        onChange={(event) => setTitle(event.target.value)}
        className={FIELD}
      />
      <textarea
        value={note}
        rows={3}
        aria-label="Note"
        placeholder="What to do when it fires; the citizen reads this in every turn it starts."
        onChange={(event) => setNote(event.target.value)}
        className={`${FIELD} resize-none`}
      />
      <fieldset className="flex gap-1">
        <legend className="sr-only">How often</legend>
        {(["repeats", "once"] as const).map((each) => (
          <label
            key={each}
            className={`cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors has-focus-visible:ring-2 has-focus-visible:ring-fg-primary/30 ${
              kind === each
                ? "bg-surface-2 text-fg-primary"
                : "text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary"
            }`}
          >
            <input
              type="radio"
              name="kind"
              value={each}
              checked={kind === each}
              onChange={() => setKind(each)}
              className="sr-only"
            />
            {each === "repeats" ? "Repeats" : "Once"}
          </label>
        ))}
      </fieldset>
      {kind === "repeats" ? (
        <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-2">
          <input
            value={expression}
            spellCheck={false}
            aria-label="Cron expression"
            placeholder="minute hour day month weekday"
            onChange={(event) => setExpression(event.target.value)}
            className={`${FIELD} font-mono`}
          />
          <input
            value={timezone}
            spellCheck={false}
            aria-label="Its time zone"
            placeholder={`${zone}, the society's`}
            onChange={(event) => setTimezone(event.target.value)}
            className={`${FIELD} font-mono`}
          />
        </div>
      ) : (
        <input
          type="datetime-local"
          value={at}
          aria-label="When, in this browser's time"
          onChange={(event) => setAt(event.target.value)}
          className={FIELD}
        />
      )}
      <p aria-live="polite" className="text-[11px] leading-relaxed text-fg-muted">
        {"error" in preview ? (
          <span className="text-amber-300">{preview.error}</span>
        ) : (
          <>
            {preview.times.length === 1 ? "Fires " : "Fires next "}
            {preview.times.map((time) => clockIn(time, readIn)).join(", ")} ({readIn}).
          </>
        )}{" "}
        Each fire is a turn for {agent === "" ? "the citizen" : agent}, which costs money.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={
            create.isPending ||
            agent === "" ||
            title.trim() === "" ||
            note.trim() === "" ||
            "error" in preview
          }
        >
          {create.isPending ? "Setting…" : "Set cron"}
        </Button>
      </div>
      <Failure error={create.error} />
    </form>
  );
}

/**
 * Every cron in the society: running ones by next fire, then paused, then ended. Each opens to its
 * note, its next fire, its last turn, and pause, resume, and remove; the user sets new ones for any
 * citizen, and the society's time zone, here. `agent` in the address shows one citizen's.
 */
export function CronsView() {
  const { agent } = useSearch({ from: "/crons" });
  const crons = useCrons();
  const members = useMembers();
  const society = useSociety();
  const now = useNow(30_000);
  const [open, setOpen] = useState<"new" | "zone" | null>(null);
  const zone = society.data?.timezone ?? "UTC";
  const mine = (crons.data ?? []).filter((cron) => agent === undefined || cron.agent === agent);
  const groups = cronGroups(mine, zone);
  const failing = mine.filter(failingCron).length;
  const wakeable = (members.data ?? []).filter(
    (member) => member.status === "active" && member.cli !== null,
  );
  const memberOf = (name: string) => members.data?.find((member) => member.name === name);

  return (
    <>
      <PaneHeader
        title={agent === undefined ? "Crons" : `Crons of ${agent}`}
        subtitle={[
          `${groups.active.length} running`,
          ...(groups.paused.length === 0 ? [] : [`${groups.paused.length} paused`]),
          ...(failing === 0 ? [] : [`${failing} failing`]),
          `times in ${zone}`,
        ].join(" · ")}
        trailing={
          open === null ? (
            <>
              <Button onClick={() => setOpen("zone")}>Time zone…</Button>
              <Button onClick={() => setOpen("new")} disabled={wakeable.length === 0}>
                New cron…
              </Button>
            </>
          ) : null
        }
      />
      {open === "new" ? (
        <NewCronForm
          members={wakeable}
          preferred={agent}
          zone={zone}
          onDone={() => setOpen(null)}
        />
      ) : open === "zone" ? (
        <TimezoneForm zone={zone} onDone={() => setOpen(null)} />
      ) : null}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {agent === undefined ? null : (
          <Link to="/crons" className="block px-2 pb-2 text-meta hover:text-fg-primary">
            Show every citizen's crons
          </Link>
        )}
        {crons.error !== null && crons.data === undefined ? (
          <PaneNote>
            The board server did not list its crons ({crons.error.message}); one older than this
            interface has none.
          </PaneNote>
        ) : crons.data === undefined ? (
          <PaneNote>Reading the crons…</PaneNote>
        ) : groups.active.length + groups.paused.length + groups.ended.length === 0 ? (
          <p className="px-2 py-2 text-meta">
            No crons yet. A citizen sets one with create_cron when it needs to come back to
            something later; you can set one for any citizen here.
          </p>
        ) : null}
        {groups.active.length === 0 ? null : (
          <ul aria-label="Running" className="space-y-0.5">
            {groups.active.map(({ cron, next }) => (
              <CronRow
                key={cron.id}
                cron={cron}
                next={next}
                member={memberOf(cron.agent)}
                zone={zone}
                now={now}
              />
            ))}
          </ul>
        )}
        {groups.paused.length === 0 ? null : (
          <section aria-label="Paused" className="mt-3">
            <h3 className="px-2 pb-1 text-section">Paused</h3>
            <ul className="space-y-0.5">
              {groups.paused.map((cron) => (
                <CronRow
                  key={cron.id}
                  cron={cron}
                  next={null}
                  member={memberOf(cron.agent)}
                  zone={zone}
                  now={now}
                />
              ))}
            </ul>
          </section>
        )}
        {groups.ended.length === 0 ? null : (
          <details className="mt-3">
            <summary className="cursor-pointer px-2 pb-1 text-section">
              Ended ({groups.ended.length})
            </summary>
            <ul aria-label="Ended" className="space-y-0.5">
              {groups.ended.map((cron) => (
                <CronRow
                  key={cron.id}
                  cron={cron}
                  next={null}
                  member={memberOf(cron.agent)}
                  zone={zone}
                  now={now}
                />
              ))}
            </ul>
          </details>
        )}
      </div>
    </>
  );
}
