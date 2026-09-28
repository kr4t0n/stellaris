import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Proposal } from "@stellaris/shared";
import { useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { Composer, MessageList } from "../components/Messages.js";
import {
  Button,
  CharterRows,
  Empty,
  ErrorNote,
  Field,
  inputClass,
  Panel,
  Pill,
} from "../components/ui.js";
import { shortId, timeAgo } from "../lib/format.js";

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (outcome: "approve" | "reject") =>
      outcome === "approve"
        ? api.verb("approve", { proposal_id: proposal.id })
        : api.verb("reject", { proposal_id: proposal.id, reason: reason.trim() }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  return (
    <li className="rounded border border-board-border bg-board-bg/60 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-board-muted">
        <Pill className="border-amber-800 text-amber-300">{proposal.kind}</Pill>
        <span>proposed by @{proposal.proposedBy}</span>
        <span>{shortId(proposal.id)}</span>
        <span className="ml-auto">{timeAgo(proposal.createdAt)}</span>
      </div>
      <CharterRows charter={proposal.charter} />
      {proposal.body.length > 0 ? <p className="text-sm">{proposal.body}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button tone="primary" onClick={() => decide.mutate("approve")} disabled={decide.isPending}>
          Approve and provision
        </Button>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason, if rejecting"
          className={`${inputClass} min-w-56`}
        />
        <Button
          tone="danger"
          onClick={() => decide.mutate("reject")}
          disabled={decide.isPending || reason.trim().length === 0}
        >
          Reject
        </Button>
      </div>
      <ErrorNote error={decide.error} />
    </li>
  );
}

function NewTask({ projects }: { projects: readonly string[] }) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState(projects[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => api.verb("create_task", { project, title, body }),
    onSuccess: () => {
      setTitle("");
      setBody("");
      void queryClient.invalidateQueries();
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (project.length > 0 && title.trim().length > 0) create.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Project">
          <select
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className={inputClass}
          >
            {projects.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="Title">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
      </div>
      <Field label="Body (markdown)">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className={`${inputClass} font-mono`}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          tone="primary"
          disabled={create.isPending || title.trim().length === 0}
        >
          Create task
        </Button>
        <ErrorNote error={create.error} />
      </div>
    </form>
  );
}

/** Inbox: what needs the owner, mentions across projects, and a place to speak. */
export function InboxPage() {
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api.inbox(false) });
  const proposals = useQuery({ queryKey: ["proposals"], queryFn: api.proposals });
  const decisions = useQuery({
    queryKey: ["channel", "decisions"],
    queryFn: () => api.channel("decisions"),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const society = useQuery({ queryKey: ["society"], queryFn: api.society });
  const markRead = useMutation({
    mutationFn: () => api.inbox(true),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const [channel, setChannel] = useState("general");

  const pending = (proposals.data ?? []).filter((proposal) => proposal.status === "proposed");
  const channels = [
    ...(society.data?.channels ?? []),
    ...(projects.data ?? []).flatMap((project) =>
      project.channels.map((name) => `${project.slug}/${name}`),
    ),
  ];
  const recentDecisions = (decisions.data ?? []).slice(-10).toReversed();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Inbox</h1>

      <Panel title={`Needs your decision (${pending.length})`}>
        {pending.length === 0 ? <Empty>Nothing waiting on you.</Empty> : null}
        <ul className="space-y-3">
          {pending.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </ul>
        {recentDecisions.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-board-muted">
              Decisions channel
            </h3>
            <MessageList messages={recentDecisions} />
          </div>
        ) : null}
      </Panel>

      <Panel
        title={`Unread (${inbox.data?.messages.length ?? 0})`}
        actions={
          <Button
            onClick={() => markRead.mutate()}
            disabled={markRead.isPending || (inbox.data?.messages.length ?? 0) === 0}
          >
            Mark all read
          </Button>
        }
      >
        <ErrorNote error={inbox.error} />
        <MessageList
          messages={(inbox.data?.messages ?? []).toReversed()}
          emptyText="You are caught up."
        />
      </Panel>

      <Panel title="Post">
        <Field label="Channel">
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className={inputClass}
          >
            {channels.map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </select>
        </Field>
        <Composer channel={channel} />
      </Panel>

      <Panel title="New task">
        {(projects.data ?? []).length === 0 ? (
          <Empty>Add a project with the admin CLI first.</Empty>
        ) : (
          <NewTask projects={(projects.data ?? []).map((project) => project.slug)} />
        )}
      </Panel>

      <p className="text-xs text-board-muted">
        Open a project from the left to read channels, tasks, and threads.{" "}
        {(projects.data ?? []).map((project) => (
          <Link
            key={project.slug}
            to="/projects/$slug"
            params={{ slug: project.slug }}
            className="text-board-accent underline"
          >
            {project.name}
          </Link>
        ))}
        {inbox.data?.cursor === null || inbox.data?.cursor === undefined
          ? null
          : ` Cursor ${shortId(inbox.data.cursor)}.`}
      </p>
    </div>
  );
}
