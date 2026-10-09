import { channelRef, SOCIETY_SCOPE, type RunningTurn } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { useSession } from "../lib/session.js";
import { Composer, type Target } from "./Composer.js";
import { Failure } from "./ThreadForms.js";

/**
 * Where a post reaches a turn: its thread, its channel for a channel's conversation, or for a home
 * turn the channel it was asked from, else its scope's general channel, where a mention wakes that
 * same home conversation.
 */
export function turnTarget(turn: RunningTurn): Target {
  if (turn.thread !== undefined) {
    return { threadId: turn.thread };
  }
  const place = turn.scope === SOCIETY_SCOPE ? null : turn.scope;
  if (turn.channel !== undefined) {
    return { channel: channelRef(place, turn.channel) };
  }
  return { channel: turn.askedIn ?? channelRef(place, "general") };
}

/**
 * Under a running turn: a composer that posts into its conversation with the citizen mentioned,
 * which the turn takes while it works when its runner can deliver it, and Stop, which ends the turn
 * on a second click. A post is on the board like any other; a stop counts as the user's decision.
 */
export function TurnControls({ name, turn }: { name: string; turn: RunningTurn }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation({
    mutationFn: () => api.stopTurn(turn.turnId),
    onSuccess: () => {
      setConfirming(false);
      void client.invalidateQueries({ queryKey: ["scheduler"] });
    },
  });

  return (
    <div className="border-t border-line">
      <Composer
        key={turn.turnId}
        target={turnTarget(turn)}
        initialText={`@${name} `}
        placeholder={
          turn.steerable ? `Message ${name} while it works` : `Message ${name} for its next turn`
        }
        className="px-3 pt-3 pb-2"
      />
      {turn.stoppable ? (
        <div className="flex items-center gap-2 px-3 pb-3">
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-fg-muted">
            {confirming
              ? "Ends the turn now. What it was shown counts as read; its stages stay held."
              : turn.steerable
                ? "Posts reach the turn at its next step."
                : "This runner delivers posts after the turn ends."}
          </p>
          {confirming ? (
            <>
              <Button
                onClick={() => {
                  setConfirming(false);
                  stop.reset();
                }}
              >
                Keep it running
              </Button>
              <Button
                variant="primary"
                disabled={stop.isPending}
                onClick={() => {
                  stop.mutate();
                }}
              >
                {stop.isPending ? "Stopping…" : "Stop the turn"}
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)}>Stop…</Button>
          )}
        </div>
      ) : null}
      {stop.error === null ? null : (
        <div className="px-3 pb-3">
          <Failure error={stop.error} />
        </div>
      )}
    </div>
  );
}
