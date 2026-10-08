import type { Proposal } from "@stellaris/shared";
import { Link, useParams } from "@tanstack/react-router";
import { z } from "zod";
import { BackLink } from "../components/BackLink.js";
import { Markdown } from "../components/Markdown.js";
import { ApiError } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  useMembers,
  useNow,
  useProposal,
  useRoles,
  useSkills,
  useThreads,
} from "../lib/session.js";
import { useDisplayName } from "./Avatar.js";
import { DecisionBar } from "./DecisionBar.js";
import { consequenceOf, decidersOf, proposalTitle, waitingOnYou } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { ProposalCharter } from "./ProposalCharter.js";
import { StatusChip } from "./ProposalsView.js";
import { Composer } from "./Composer.js";
import { SubjectThread } from "./SubjectThread.js";

const ProvisionSchema = z.object({
  agent: z.string().optional(),
  channel: z.string().optional(),
  role: z.string().optional(),
  skill: z.string().optional(),
  replaced: z.boolean().optional(),
  releasedTasks: z.array(z.string()).optional(),
  project: z.string().optional(),
});

/** What approval created, with a way to it where the board has a view of it. */
function Provisioned({ proposal }: { proposal: Proposal }) {
  const parsed = ProvisionSchema.safeParse(proposal.provision ?? {});
  if (proposal.provision === undefined || !parsed.success) {
    return null;
  }
  const made = parsed.data;
  const link = "text-fg-primary underline decoration-fg-muted underline-offset-2";
  if (proposal.kind === "member" && made.agent !== undefined) {
    return (
      <p className="mt-1">
        Created{" "}
        <Link to="/citizen/$name" params={{ name: made.agent }} className={link}>
          {made.agent}
        </Link>
        .
      </p>
    );
  }
  if (proposal.kind === "channel" && made.channel !== undefined) {
    return (
      <p className="mt-1">
        Created{" "}
        <Link to="/c/$" params={{ _splat: made.channel }} className={link}>
          #{made.channel}
        </Link>
        .
      </p>
    );
  }
  if (proposal.kind === "retirement" && made.agent !== undefined) {
    const released = made.releasedTasks?.length ?? 0;
    return (
      <p className="mt-1">
        Retired {made.agent}; {released === 1 ? "1 stage went" : `${released} stages went`} back to
        open.
      </p>
    );
  }
  if (proposal.kind === "archive" && made.project !== undefined) {
    return (
      <p className="mt-1">
        Archived{" "}
        <Link to="/p/$slug" params={{ slug: made.project }} className={link}>
          {made.project}
        </Link>
        ; its members left and its threads closed.
      </p>
    );
  }
  if (made.role !== undefined) {
    return (
      <p className="mt-1">
        {made.replaced === true ? "Rewrote" : "Added"} the role {made.role}.
      </p>
    );
  }
  if (made.skill !== undefined) {
    return (
      <p className="mt-1">
        {made.replaced === true ? "Replaced" : "Published"} the society's skill {made.skill}.
      </p>
    );
  }
  return null;
}

/**
 * One proposal: what approving it does, its charter drawn for its kind, and its thread, which opens
 * with the pitch and closes with the decision, with a composer while it waits.
 */
export function ProposalView() {
  const { proposalId } = useParams({ from: "/proposal/$proposalId" });
  const proposal = useProposal(proposalId);
  const members = useMembers();
  const roles = useRoles();
  const skills = useSkills();
  const threads = useThreads();
  const now = useNow(30_000);
  const displayName = useDisplayName();

  if (proposal.data === undefined) {
    return (
      <PaneNote>
        {proposal.error instanceof ApiError && proposal.error.status === 404
          ? `There is no proposal ${proposalId}.`
          : "Reading the proposal…"}
      </PaneNote>
    );
  }
  const current = proposal.data;
  const open = current.status === "proposed";
  const proposerRole = members.data?.find((member) => member.name === current.proposedBy)?.role;
  const thread = threads.data?.find((candidate) => candidate.id === current.id);
  const verdict = current.status === "rejected" ? "Rejected" : "Approved";
  const consequence = consequenceOf(current, {
    members: members.data ?? [],
    roles: roles.data ?? [],
    skills: skills.data ?? [],
  });

  return (
    <>
      <PaneHeader
        leading={
          <BackLink
            fallback={
              <Link
                to="/proposals"
                aria-label="Back to the proposals"
                className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary"
              >
                ←
              </Link>
            }
          />
        }
        title={proposalTitle(current)}
        subtitle={`${current.kind} proposal by ${displayName(current.proposedBy)} ${ago(
          current.createdAt,
          now,
        )}${open ? ` · for ${decidersOf(current, proposerRole)} to decide` : ""}`}
        trailing={<StatusChip status={current.status} />}
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {open ? (
          <p className="rounded-lg bg-sky-400/10 px-3 py-2 text-xs leading-relaxed text-sky-200">
            If approved: {consequence}
          </p>
        ) : (
          <div className="rounded-lg bg-surface-2/40 px-3 py-2 text-xs leading-relaxed text-fg-secondary">
            <p>
              {verdict} by {displayName(current.decidedBy ?? "someone")}
              {current.decidedAt === undefined ? "" : ` ${ago(current.decidedAt, now)}`}
              {current.reason === undefined ? "." : `: ${current.reason}`}
            </p>
            <Provisioned proposal={current} />
          </div>
        )}
        {/* The pitch opens the proposal's thread; a proposal older than that keeps its rationale here. */}
        {current.body.trim() === "" || thread !== undefined ? null : (
          <section className="mt-5">
            <h3 className="text-section">Why</h3>
            <div className="mt-2">
              <Markdown text={current.body} />
            </div>
          </section>
        )}
        <section className="mt-5 border-t border-line pt-4">
          <h3 className="text-section">
            {open
              ? "What it would make"
              : current.status === "provisioned"
                ? "What it made"
                : "What it proposed"}
          </h3>
          <ProposalCharter proposal={current} roles={roles.data} members={members.data} />
        </section>
        <section aria-label="Thread" className="mt-5 border-t border-line pt-4">
          <h3 className="text-section">Thread</h3>
          {thread === undefined ? (
            <p className="mt-2 text-meta">
              {threads.data === undefined
                ? "Reading the thread…"
                : "This proposal is older than proposal threads; its thread opens when it is decided."}
            </p>
          ) : (
            <SubjectThread
              thread={thread}
              now={now}
              empty="Nothing said yet. The pitch and the decision are posted here."
            />
          )}
        </section>
      </div>
      {thread?.state === "open" ? (
        <Composer target={{ threadId: current.id }} placeholder="Write in the proposal's thread" />
      ) : null}
      {waitingOnYou(current) ? <DecisionBar proposal={current} consequence={consequence} /> : null}
    </>
  );
}
