import type { Proposal } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { BackLink } from "../components/BackLink.js";
import { Markdown } from "../components/Markdown.js";
import { ApiError, namesNothing } from "../lib/api.js";
import { ago } from "../lib/format.js";
import {
  useMembers,
  useNow,
  useProposal,
  useRoles,
  useSession,
  useSkills,
  useThread,
} from "../lib/session.js";
import { useDisplayName } from "./Avatar.js";
import { consequenceOf, decidersOf, proposalTitle, waitingOnYou } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { ProposalCharter } from "./ProposalCharter.js";
import { StatusChip } from "./ProposalsView.js";
import { ActionButton, blockedWith, Composer, type ComposerAction } from "./Composer.js";
import { StickyList } from "./StickyList.js";
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
 * Deciding a proposal that waits on the user from its box, the box's text as the reason, through
 * the verbs the steward uses: Approve, a check, then Reject, a cross, which waits while the box is
 * empty, since a rejection needs a reason. A press decides.
 */
function useDecisions(proposal: Proposal | undefined): readonly ComposerAction[] | undefined {
  const { api } = useSession();
  const client = useQueryClient();
  if (proposal === undefined || !waitingOnYou(proposal)) {
    return undefined;
  }
  // Approval can create a citizen, a channel, a role, or a skill; the events refresh those too.
  const settle = () =>
    Promise.all(
      [["proposals"], ["proposal", proposal.id], ["threads"], ["thread", proposal.id]].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
  return [
    {
      label: "Approve",
      title: "Approve the proposal, with what the box holds as the reason",
      blocked: null,
      failure: "The proposal was not decided.",
      run: async (text) => {
        await api.approve({ proposal_id: proposal.id, ...(text === "" ? {} : { reason: text }) });
        await settle();
      },
    },
    {
      label: "Reject",
      title: "Reject the proposal, with what the box holds as the reason",
      blocked: null,
      needsText: "Write why in the box to reject",
      mark: "cross",
      failure: "The proposal was not decided.",
      run: async (text) => {
        await api.reject({ proposal_id: proposal.id, reason: text });
        await settle();
      },
    },
  ];
}

/**
 * Deciding a proposal with no open thread to write in, as one from before proposals had threads: a
 * box for the reason alone, then the buttons, as in the thread's box.
 */
function DecideAlone({ actions }: { actions: readonly ComposerAction[] }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  // After every render the box fits its text, as the thread's box does, up to its maximum height.
  useLayoutEffect(() => {
    const element = box.current;
    if (element !== null) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  });
  const run = useMutation({
    mutationFn: (index: number) => actions[index]?.run(text.trim()) ?? Promise.resolve(),
  });
  return (
    <div className="border-t border-line p-3">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 rounded-[20px] bg-surface-2/50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] focus-within:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">
          <textarea
            ref={box}
            rows={1}
            value={text}
            placeholder="Reason"
            aria-label="Reason"
            onChange={(event) => setText(event.target.value)}
            className="block max-h-48 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
          />
        </div>
        {actions.map((action, index) => {
          const pending = run.isPending && run.variables === index;
          const blocked = blockedWith(action, text);
          return (
            <ActionButton
              key={action.label}
              action={{ ...action, blocked }}
              pending={pending}
              disabled={(blocked !== null || run.isPending) && !pending}
              onClick={() => {
                // As in the thread's box: the keyboard goes back to the box, never to the board's keys.
                box.current?.focus();
                run.mutate(index);
              }}
            />
          );
        })}
      </div>
      {run.error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {run.error instanceof ApiError ? run.error.message : actions[run.variables ?? 0]?.failure}
        </p>
      )}
    </div>
  );
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
  const now = useNow(30_000);
  const displayName = useDisplayName();
  // A proposal's thread takes the proposal's id, so it is read at once; "not found" means it has none.
  const messages = useThread(proposalId);
  const threadless = namesNothing(messages.error);
  const decisions = useDecisions(proposal.data);

  if (proposal.data === undefined) {
    return (
      <PaneNote>
        {namesNothing(proposal.error)
          ? `There is no proposal ${proposalId}.`
          : "Reading the proposal…"}
      </PaneNote>
    );
  }
  const current = proposal.data;
  const open = current.status === "proposed";
  const proposerRole = members.data?.find((member) => member.name === current.proposedBy)?.role;
  const thread = messages.data?.thread;
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
      {/* Keyed by its subject: the route keeps the view mounted from one proposal to the next. */}
      <StickyList
        key={current.id}
        stick={false}
        follow={false}
        ids={messages.data?.messages.map((message) => message.id)}
        className="px-4 py-4"
      >
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
        {current.body.trim() === "" || !threadless ? null : (
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
          {threadless ? (
            <p className="mt-2 text-meta">No thread on this proposal.</p>
          ) : (
            <SubjectThread id={current.id} now={now} empty="Nothing said yet." />
          )}
        </section>
      </StickyList>
      {/* Keyed by its proposal, so a reason typed for one never decides the next one a link opens
          in this view, and by `box:<id>`, never the id alone, which the message list beside it
          takes: with one key on both, React kept the old list beside the new one. A proposal's
          thread closes with its decision, so one waiting has an open thread or none. Until the
          read answers, the foot waits; once it fails, as with a 404 for a proposal from before
          threads or a server's error, the reason box stands alone, so the proposal can still be
          decided. */}
      {thread?.state === "open" ? (
        <Composer
          key={`box:${current.id}`}
          target={{ threadId: current.id }}
          placeholder="Write in the thread"
          actions={decisions}
        />
      ) : messages.error !== null && decisions !== undefined ? (
        <DecideAlone key={`box:${current.id}`} actions={decisions} />
      ) : null}
    </>
  );
}
