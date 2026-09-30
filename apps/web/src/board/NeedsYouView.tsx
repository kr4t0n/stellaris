import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ago, firstParagraph } from "../lib/format.js";
import { useNow, useProjects } from "../lib/session.js";
import { displayName } from "./Avatar.js";
import { proposalTitle, type Attention } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { useNeedsYou } from "./useNeedsYou.js";

const SECTIONS: ReadonlyArray<{ readonly kind: Attention["kind"]; readonly label: string }> = [
  { kind: "proposal", label: "Proposals to decide" },
  { kind: "stage", label: "Stages that name you" },
  { kind: "request", label: "Asked of you" },
];

const ROW = "block rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2/50";

function Row({ title, meta }: { title: ReactNode; meta: ReactNode }) {
  return (
    <>
      <span className="text-title block truncate">{title}</span>
      <span className="mt-1 block truncate text-meta">{meta}</span>
    </>
  );
}

/** Everything that waits on the user, oldest first in each kind, each a link to where it is decided. */
export function NeedsYouView() {
  const items = useNeedsYou();
  const projects = useProjects();
  const now = useNow(30_000);
  const projectName = (slug: string): string =>
    projects.data?.find((project) => project.slug === slug)?.name ?? slug;

  return (
    <>
      <PaneHeader
        title="Needs you"
        subtitle={
          items.length === 0
            ? "Nothing waits on you"
            : `${items.length} waiting on you, oldest first`
        }
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {items.length === 0 ? (
          <PaneNote>
            Nothing waits on you. Proposals you may decide, stages that name you, and questions
            citizens ask you with @user appear here until you answer where they asked.
          </PaneNote>
        ) : (
          SECTIONS.map(({ kind, label }) => {
            const shown = items.filter((item) => item.kind === kind);
            if (shown.length === 0) {
              return null;
            }
            return (
              <section key={kind} className="mb-3">
                <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
                  {label} · {shown.length}
                </h3>
                <ul>
                  {shown.map((item) => {
                    if (item.kind === "proposal") {
                      return (
                        <li key={item.proposal.id}>
                          <Link
                            to="/proposal/$proposalId"
                            params={{ proposalId: item.proposal.id }}
                            className={ROW}
                          >
                            <Row
                              title={proposalTitle(item.proposal)}
                              meta={`proposed by ${displayName(item.proposal.proposedBy)} ${ago(item.since, now)}`}
                            />
                          </Link>
                        </li>
                      );
                    }
                    if (item.kind === "stage") {
                      return (
                        <li key={item.task.id}>
                          <Link
                            to="/task/$taskId"
                            params={{ taskId: item.task.id }}
                            className={ROW}
                          >
                            <Row
                              title={item.task.title}
                              meta={`${item.stage.name}${item.stage.gate ? " (gate)" : ""} in ${projectName(
                                item.task.project,
                              )} · waiting since ${ago(item.since, now)}`}
                            />
                          </Link>
                        </li>
                      );
                    }
                    const meta = `${displayName(item.message.author)} in ${
                      item.thread === null ? `#${item.message.channel}` : item.thread.title
                    } ${ago(item.since, now)}`;
                    const row = <Row title={firstParagraph(item.message.body, 160)} meta={meta} />;
                    const subject = item.thread?.subject;
                    // A question is answered where it was asked: the task's or the proposal's view,
                    // which shows its thread, a topic's thread, or the channel.
                    return (
                      <li key={item.message.id}>
                        {subject?.kind === "task" ? (
                          <Link to="/task/$taskId" params={{ taskId: subject.id }} className={ROW}>
                            {row}
                          </Link>
                        ) : subject?.kind === "proposal" ? (
                          <Link
                            to="/proposal/$proposalId"
                            params={{ proposalId: subject.id }}
                            className={ROW}
                          >
                            {row}
                          </Link>
                        ) : item.thread !== null ? (
                          <Link
                            to="/thread/$threadId"
                            params={{ threadId: item.thread.id }}
                            className={ROW}
                          >
                            {row}
                          </Link>
                        ) : (
                          <Link to="/c/$" params={{ _splat: item.message.channel }} className={ROW}>
                            {row}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
