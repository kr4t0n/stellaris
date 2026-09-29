import { SOCIETY_SCOPE, type Member } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CliIcon } from "../components/CliIcon.js";
import type { Topic } from "../lib/api.js";
import { pairsOf } from "../lib/api.js";
import { ago, firstParagraph } from "../lib/format.js";
import { useScheduler } from "../lib/session.js";
import { scopeName } from "./citizen.js";

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex items-baseline justify-between gap-2">
        <span className="text-caps">{title}</span>
        {aside}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Citizens with where each is now, as seen from one scope: working here, elsewhere, or resting. */
export function CrewList({ members, scope }: { members: readonly Member[]; scope: string }) {
  const scheduler = useScheduler();
  const running = pairsOf(scheduler.data?.running ?? []);
  const pending = pairsOf(scheduler.data?.pending ?? []);
  if (members.length === 0) {
    return <p className="text-meta">Nobody yet.</p>;
  }
  return (
    <ul className="-mx-2">
      {members.map((member) => {
        const at = running.filter((pair) => pair.agent === member.name).map((pair) => pair.scope);
        const here = at.includes(scope);
        const queued = pending.some((pair) => pair.agent === member.name);
        const where = here
          ? "in a turn here"
          : at.length > 0
            ? `in a turn at ${at.map(scopeName).join(" and ")}`
            : queued
              ? "queued"
              : "resting";
        return (
          <li key={member.name}>
            <Link
              to="/citizen/$name"
              params={{ name: member.name }}
              search={here && scope !== SOCIETY_SCOPE ? { scope } : {}}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2/50"
            >
              <span className="grid size-4 shrink-0 place-items-center">
                {member.cli === null ? null : <CliIcon cli={member.cli} size={13} />}
              </span>
              <span className="text-fg-primary">{member.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{member.role}</span>
              <span
                className={`shrink-0 text-xs ${at.length > 0 ? "text-emerald-300" : queued ? "text-amber-300" : "text-fg-muted"}`}
              >
                {where}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Knowledge topics of a scope, newest first, each a link to its whole text. */
export function TopicList({
  scope,
  topics,
  now,
}: {
  scope: string;
  topics: readonly Topic[] | undefined;
  now: number;
}) {
  if (topics === undefined) {
    return <p className="text-meta">Reading…</p>;
  }
  if (topics.length === 0) {
    return (
      <p className="text-meta">
        No knowledge yet. {scope === SOCIETY_SCOPE ? "The steward and you" : "Members"} write it
        with write_knowledge.
      </p>
    );
  }
  return (
    <ul className="-mx-2">
      {topics
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((topic) => (
          <li key={topic.topic}>
            <Link
              to="/knowledge/$scope/$topic"
              params={{ scope, topic: topic.topic }}
              className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-sm text-fg-primary">{topic.topic}</span>
                <span className="text-meta">
                  by {topic.updatedBy} {ago(topic.updatedAt, now)}
                </span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-secondary">
                {firstParagraph(topic.body, 240)}
              </span>
            </Link>
          </li>
        ))}
    </ul>
  );
}
