import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import type { ChannelSummary } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { useSession } from "../lib/session.js";
import { Failure, FIELD } from "./ThreadForms.js";

/**
 * Opens a channel in a project, or in the society, for a workstream such as a release, and goes
 * to it. The board announces it in the place's general, where members choose to follow it.
 */
export function NewChannelForm({
  project,
  onDone,
}: {
  project: string | null;
  onDone: () => void;
}) {
  const { api } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.focus(), []);
  const create = useMutation({
    mutationFn: () => api.createChannel({ project, name: name.trim(), purpose: purpose.trim() }),
    onSuccess: async (ref) => {
      await client.invalidateQueries({ queryKey: ["channels"] });
      onDone();
      await navigate({ to: "/c/$", params: { _splat: ref } });
    },
  });
  return (
    <form
      aria-label="New channel"
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        {/* The field is as wide as its box, so the box sets the width. */}
        <div className="w-40 shrink-0">
          <input
            ref={nameField}
            value={name}
            maxLength={64}
            spellCheck={false}
            aria-label="Channel name"
            placeholder="release-0-4"
            onChange={(event) => setName(event.target.value)}
            className={`${FIELD} font-mono`}
          />
        </div>
        <input
          value={purpose}
          aria-label="Purpose"
          placeholder="What the channel is for"
          onChange={(event) => setPurpose(event.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={create.isPending || name.trim() === "" || purpose.trim() === ""}
        >
          {create.isPending ? "Opening…" : "Open"}
        </Button>
      </div>
      <p className="text-meta">
        {project === null
          ? "Announced in the society's general, and followed by whoever subscribes to it; you read every channel without following one."
          : `Announced in ${project}'s general, where its members choose to follow it; you read every channel without following one. Tasks filed in it hang their threads here, and it is archived once its tasks are done.`}
      </p>
      <Failure error={create.error} />
    </form>
  );
}

/** Archives a channel with the reason, once nothing filed in it is in play. */
export function ArchiveChannelForm({ channel, onDone }: { channel: string; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const archive = useMutation({
    mutationFn: () => api.archiveChannel({ channel, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["channels"] });
      onDone();
    },
  });
  return (
    <form
      aria-label="Archive the channel"
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        archive.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={reason}
          aria-label="Reason"
          placeholder="Why its work is done"
          onChange={(event) => setReason(event.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          type="submit"
          disabled={archive.isPending || reason.trim() === ""}
        >
          {archive.isPending ? "Archiving…" : "Archive channel"}
        </Button>
      </div>
      <p className="text-meta">
        Its open threads close, nobody follows it, and nothing more is posted or filed here; its
        posts, threads, and tasks stay readable. The board refuses while a task filed here is in
        play.
      </p>
      <Failure error={archive.error} />
    </form>
  );
}

/** A place's channels, the archived ones after the open ones and marked so. */
export function ChannelList({
  channels,
  now,
}: {
  channels: readonly ChannelSummary[];
  now: number;
}) {
  if (channels.length === 0) {
    return <p className="text-meta">No channels.</p>;
  }
  return (
    <ul className="space-y-1">
      {channels.map((channel) => (
        <li key={channel.ref}>
          <Link
            to="/c/$"
            params={{ _splat: channel.ref }}
            className={`text-sm hover:text-fg-primary ${
              channel.archived === undefined ? "text-fg-secondary" : "text-fg-tertiary"
            }`}
          >
            # {channel.name}
          </Link>
          <span className="text-meta">
            {" "}
            · {channel.messages} messages
            {channel.archived === undefined ? "" : ` · archived ${ago(channel.archived.at, now)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
