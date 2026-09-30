import type { Proposal } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { useMembers, useSession } from "../lib/session.js";
import { Failure, FIELD } from "./ThreadForms.js";

type Choice = "approve" | "reject";

/**
 * Approve or reject, through the same verbs the steward uses. The first click opens the reason
 * and says what deciding does; only the second decides. A rejection needs a reason, as the verb does.
 */
export function DecisionBar({
  proposal,
  consequence,
}: {
  proposal: Proposal;
  consequence: string;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const members = useMembers();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reason, setReason] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (choice !== null) field.current?.focus();
  }, [choice]);

  const decide = useMutation({
    mutationFn: () => {
      const why = reason.trim();
      return choice === "reject"
        ? api.reject({ proposal_id: proposal.id, reason: why })
        : api.approve({ proposal_id: proposal.id, ...(why === "" ? {} : { reason: why }) });
    },
    onSuccess: () => {
      // Approval can create a citizen, a channel, a role, or a skill; the events refresh those too.
      const touched = [
        ["proposals"],
        ["proposal", proposal.id],
        ["threads"],
        ["thread", proposal.id],
      ];
      for (const queryKey of touched) {
        void client.invalidateQueries({ queryKey });
      }
      setChoice(null);
      setReason("");
    },
  });

  // The decision is the proposal thread's last post; it wakes the proposer and no front desk.
  const proposer = (members.data ?? []).find(
    (member) =>
      member.name === proposal.proposedBy && member.status === "active" && member.cli !== null,
  );
  const posted =
    proposer === undefined
      ? "Your decision is posted in the proposal's thread, which closes."
      : `Your decision is posted in the proposal's thread, which closes, and wakes ${proposer.name}, who proposed it.`;

  if (choice === null) {
    return (
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <p className="min-w-0 flex-1 truncate text-meta">This proposal waits on you.</p>
        <Button onClick={() => setChoice("reject")}>Reject</Button>
        <Button variant="primary" onClick={() => setChoice("approve")}>
          Approve
        </Button>
      </div>
    );
  }
  const approving = choice === "approve";
  return (
    <form
      aria-label={approving ? "Approve the proposal" : "Reject the proposal"}
      className="space-y-2 border-t border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        decide.mutate();
      }}
    >
      <textarea
        ref={field}
        value={reason}
        rows={2}
        placeholder={
          approving ? "Why approve? Optional." : "Why not? It is posted with the decision."
        }
        aria-label={approving ? "Reason for approving" : "Reason for rejecting"}
        onChange={(event) => setReason(event.target.value)}
        className={`${FIELD} resize-none`}
      />
      <p className="text-[11px] leading-relaxed text-fg-muted">
        {approving ? consequence : "Nothing is created, and the proposal's thread closes."} {posted}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={() => {
            setChoice(null);
            decide.reset();
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={decide.isPending || (!approving && reason.trim() === "")}
        >
          {decide.isPending ? "Deciding…" : approving ? "Confirm approval" : "Confirm rejection"}
        </Button>
      </div>
      <Failure error={decide.error} />
    </form>
  );
}
