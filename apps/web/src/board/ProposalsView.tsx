import type { Proposal, ProposalStatus } from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ago } from "../lib/format.js";
import { useNow, useProposals } from "../lib/session.js";
import { displayName } from "./Avatar.js";
import { groupProposals, PROPOSAL_GROUPS, proposalTitle } from "./governance.js";
import { PaneHeader, PaneNote } from "./Pane.js";

/** Decided proposals keep only their newest few until asked for the rest. */
const FOLDED = 8;

const STATUS_STYLE: Record<ProposalStatus, string> = {
  proposed: "bg-amber-500/15 text-amber-300",
  approved: "bg-emerald-500/15 text-emerald-300",
  provisioned: "bg-emerald-500/15 text-emerald-300",
  rejected: "bg-red-500/15 text-red-300",
  retired: "bg-surface-2 text-fg-muted",
};

/** Provisioned is approved and carried out; the proposal says what it created. */
export function StatusChip({ status }: { status: ProposalStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
    >
      {status === "provisioned" ? "approved" : status}
    </span>
  );
}

function ProposalRow({ proposal, now }: { proposal: Proposal; now: number }) {
  const decided =
    proposal.decidedBy === undefined || proposal.decidedAt === undefined
      ? ""
      : ` · ${proposal.status === "rejected" ? "rejected" : "approved"} by ${displayName(
          proposal.decidedBy,
        )} ${ago(proposal.decidedAt, now)}`;
  return (
    <li>
      <Link
        to="/proposal/$proposalId"
        params={{ proposalId: proposal.id }}
        className="block rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-2/50"
      >
        <div className="flex items-center gap-2">
          <span className="text-title min-w-0 flex-1 truncate">{proposalTitle(proposal)}</span>
          <StatusChip status={proposal.status} />
        </div>
        <p className="mt-1 truncate text-meta">
          proposed by {displayName(proposal.proposedBy)} {ago(proposal.createdAt, now)}
          {decided}
        </p>
      </Link>
    </li>
  );
}

/** Every proposal: what waits on the user first, then what waits on others, then the decided. */
export function ProposalsView() {
  const proposals = useProposals();
  const now = useNow(30_000);
  const [unfolded, setUnfolded] = useState(false);
  const groups = groupProposals(proposals.data ?? []);
  const yours = groups.find((group) => group.group === "yours")?.proposals.length ?? 0;

  return (
    <>
      <PaneHeader
        title="Proposals"
        subtitle={`${yours === 0 ? "nothing" : yours} waiting on you · ${proposals.data?.length ?? 0} in all`}
      />
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {proposals.data === undefined ? (
          <PaneNote>Reading the proposals…</PaneNote>
        ) : groups.length === 0 ? (
          <PaneNote>
            No proposals yet. Citizens propose roles, members, channels, and skills.
          </PaneNote>
        ) : (
          groups.map((group) => {
            const folded = group.group === "decided" && !unfolded;
            const shown = folded ? group.proposals.slice(0, FOLDED) : group.proposals;
            return (
              <section key={group.group} className="mb-3">
                <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
                  {PROPOSAL_GROUPS.find((each) => each.group === group.group)?.label} ·{" "}
                  {group.proposals.length}
                </h3>
                <ul>
                  {shown.map((proposal) => (
                    <ProposalRow key={proposal.id} proposal={proposal} now={now} />
                  ))}
                </ul>
                {shown.length < group.proposals.length ? (
                  <button
                    type="button"
                    onClick={() => setUnfolded(true)}
                    className="px-3 pt-1 text-xs text-fg-tertiary hover:text-fg-primary"
                  >
                    Show all {group.proposals.length}
                  </button>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
