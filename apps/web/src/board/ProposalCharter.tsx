import {
  applyRoleChanges,
  ArchiveProposalSchema,
  ChannelProposalSchema,
  channelRef,
  MemberProposalSchema,
  ReallocationProposalSchema,
  RetirementProposalSchema,
  SkillProposalSchema,
  type Member,
  type Proposal,
  type ReallocationProposal,
  type RoleCharter,
} from "@stellaris/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CliIcon } from "../components/CliIcon.js";
import { Markdown } from "../components/Markdown.js";
import { useProjects, useProposalFiles, useTasks } from "../lib/session.js";
import { Citizen } from "./Avatar.js";
import { proposedRole, roleDiff, skillText } from "./governance.js";
import { SkillFileList } from "./SkillFileList.js";
import { inPlay } from "./tasks.js";

function Fields({ children }: { children: ReactNode }) {
  return <dl className="mt-2 space-y-1.5">{children}</dl>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 text-sm">
      <dt className="text-meta">{label}</dt>
      <dd className="min-w-0 break-words text-fg-secondary">{children}</dd>
    </div>
  );
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function Verb({ name, change }: { name: string; change?: "added" | "removed" }) {
  const tone =
    change === "added"
      ? "bg-emerald-500/15 text-emerald-300"
      : change === "removed"
        ? "bg-red-500/15 text-red-300 line-through"
        : "bg-surface-2/70 text-fg-tertiary";
  return (
    <span className={`inline-block rounded-md px-1.5 py-px font-mono text-[11px] ${tone}`}>
      {change === "added" ? "+ " : change === "removed" ? "− " : ""}
      {name}
    </span>
  );
}

function Block({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 rounded-xl bg-surface-2/30 px-3.5 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      {children}
    </div>
  );
}

/** A role proposal: what it changes in the charter the role has now, then the whole charter. */
function RoleCharterView({
  next,
  current,
  compare,
}: {
  next: RoleCharter;
  current: RoleCharter | undefined;
  compare: boolean;
}) {
  const diff = current === undefined ? null : roleDiff(current, next);
  const unchanged =
    diff !== null &&
    diff.verbsAdded.length === 0 &&
    diff.verbsRemoved.length === 0 &&
    diff.changes.length === 0 &&
    !diff.purposeChanged;
  return (
    <>
      {!compare ? null : diff === null ? (
        <p className="mt-2 text-meta">A new role: no charter by this name exists yet.</p>
      ) : unchanged ? (
        <p className="mt-2 text-meta">The same as the charter the role has now.</p>
      ) : (
        <Block>
          <p className="text-caps">Against the charter it has now</p>
          {diff.verbsAdded.length + diff.verbsRemoved.length === 0 ? null : (
            <p className="mt-2 flex flex-wrap gap-1">
              {diff.verbsAdded.map((verb) => (
                <Verb key={verb} name={verb} change="added" />
              ))}
              {diff.verbsRemoved.map((verb) => (
                <Verb key={verb} name={verb} change="removed" />
              ))}
            </p>
          )}
          {diff.changes.length === 0 ? null : (
            <Fields>
              {diff.changes.map((change) => (
                <Field key={change.field} label={change.field}>
                  {change.from} → <span className="text-fg-primary">{change.to}</span>
                </Field>
              ))}
            </Fields>
          )}
          {diff.purposeChanged ? (
            <p className="mt-2 text-xs text-fg-secondary">The purpose is rewritten.</p>
          ) : null}
        </Block>
      )}
      <Fields>
        <Field label="Role">{next.name}</Field>
        <Field label="Purpose">{next.purpose}</Field>
        <Field label="Verbs">
          <span className="flex flex-wrap gap-1">
            {next.verbs.map((verb) => (
              <Verb key={verb} name={verb} />
            ))}
          </span>
        </Field>
        <Field label="Wake triggers">{listed(next.wakeTriggers)}</Field>
        <Field label="Replicas per project">{next.maxReplicas}</Field>
        <Field label="Warm session">{next.resident ? "yes" : "no"}</Field>
        <Field label="Society role">{next.societyScope ? "yes, in no project" : "no"}</Field>
        <Field label="Reflects">{next.reflects ? "yes" : "no"}</Field>
      </Fields>
    </>
  );
}

/**
 * A reallocation: while it waits, the role as approval would leave it against the charter it has
 * now; once decided, what approval changed, or what was asked for a rejected one.
 */
function ReallocationView({
  proposal,
  reallocation,
  current,
  compare,
}: {
  proposal: Proposal;
  reallocation: ReallocationProposal;
  /** The role as it is now; null when no role has that name, undefined while roles load. */
  current: RoleCharter | null | undefined;
  compare: boolean;
}) {
  const { role, changes, description } = reallocation;
  const changed = proposal.provision?.["changed"];
  const applied = Array.isArray(changed)
    ? changed.filter((line): line is string => typeof line === "string")
    : null;
  if (compare && current !== undefined && current !== null) {
    return (
      <>
        <RoleCharterView next={applyRoleChanges(current, changes)} current={current} compare />
        <Fields>
          <Field label="Why">{description}</Field>
        </Fields>
      </>
    );
  }
  return (
    <Fields>
      <Field label="Role">{role}</Field>
      {compare && current === null ? (
        <Field label="Role now">none by this name; approving it will fail</Field>
      ) : null}
      {applied === null ? (
        <>
          {changes.maxReplicas === undefined ? null : (
            <Field label="Replicas per project">{changes.maxReplicas}</Field>
          )}
          {changes.backlogThreshold === undefined ? null : (
            <Field label="Backlog per member">{changes.backlogThreshold}</Field>
          )}
          {changes.wakeTriggers === undefined ? null : (
            <Field label="Wake triggers">{listed(changes.wakeTriggers)}</Field>
          )}
          {changes.verbs === undefined ? null : (
            <Field label="Verbs">
              <span className="flex flex-wrap gap-1">
                {changes.verbs.map((verb) => (
                  <Verb key={verb} name={verb} />
                ))}
              </span>
            </Field>
          )}
        </>
      ) : (
        <Field label="Changed">
          {applied.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </Field>
      )}
      <Field label="Why">{description}</Field>
    </Fields>
  );
}

/**
 * A project's archive: who would leave it and whether any task still holds it open, or, once
 * decided, who left.
 */
function ArchiveCharterView({
  proposal,
  slug,
  reason,
  members,
}: {
  proposal: Proposal;
  slug: string;
  reason: string;
  members: readonly Member[] | undefined;
}) {
  const projects = useProjects();
  const tasks = useTasks(slug);
  const project = projects.data?.find((candidate) => candidate.slug === slug);
  const pending = proposal.status === "proposed";
  const leaving = pending
    ? (members ?? [])
        .filter((member) => member.status === "active" && member.memberships.includes(slug))
        .map((member) => member.name)
    : (proposal.provision?.["members"] ?? []);
  const open = (tasks.data ?? []).filter(inPlay).length;
  return (
    <Fields>
      <Field label="Project">
        <Link to="/p/$slug" params={{ slug }} className="hover:text-fg-primary">
          {project?.name ?? slug}
        </Link>
        {project?.name === undefined || project.name === slug ? null : ` · ${slug}`}
      </Field>
      <Field label={pending ? "Members who leave" : "Members who left"}>
        {Array.isArray(leaving)
          ? listed(leaving.filter((name): name is string => typeof name === "string"))
          : "none"}
      </Field>
      {pending ? (
        <Field label="Tasks in play">
          {tasks.data === undefined
            ? "reading…"
            : open === 0
              ? "none"
              : `${open}: approval is refused`}
        </Field>
      ) : null}
      <Field label="Reason">{reason}</Field>
    </Fields>
  );
}

/**
 * A skill proposed as a folder of its proposer's home: its SKILL.md, then every file beside it,
 * each opening to its text. Until the proposer's turn ends, the board has not taken it yet.
 */
function SkillFolder({ proposal }: { proposal: Proposal }) {
  const taken = proposal.skillFiles;
  const files = useProposalFiles(proposal.id, taken !== undefined);
  if (taken === undefined) {
    return (
      <p className="mt-2 text-sm text-fg-secondary">
        {proposal.status === "proposed"
          ? "Files not taken yet."
          : "The board took no files for it."}
      </p>
    );
  }
  if (files.data === undefined) {
    return (
      <p className="mt-2 text-meta">{files.isError ? "Could not read its files." : "Loading…"}</p>
    );
  }
  const manual = files.data.find((file) => file.path === "SKILL.md");
  const others = files.data.filter((file) => file.path !== "SKILL.md");
  return (
    <>
      <Fields>
        <Field label="Taken from">
          {proposal.proposedBy}'s home at{" "}
          <span className="font-mono">{taken.commit.slice(0, 7)}</span>
        </Field>
      </Fields>
      {manual === undefined || manual.text === null ? null : (
        <Block>
          <Markdown text={skillText(manual.text)} />
        </Block>
      )}
      {others.length === 0 ? null : (
        <div className="mt-2">
          <SkillFileList files={others} />
        </div>
      )}
    </>
  );
}

/** What approval would create or change, drawn for the proposal's kind. */
export function ProposalCharter({
  proposal,
  roles,
  members,
}: {
  proposal: Proposal;
  roles: readonly RoleCharter[] | undefined;
  members: readonly Member[] | undefined;
}) {
  // Once decided, the role's charter is what the proposal made or what came after it.
  const compare = proposal.status === "proposed";
  const { charter } = proposal;
  switch (proposal.kind) {
    case "member": {
      const parsed = MemberProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      const hire = parsed.data;
      return (
        <>
          <Fields>
            <Field label="Citizen">
              <span className="inline-flex items-center gap-1.5">
                <CliIcon cli={hire.cli} size={13} />
                {hire.name}
              </span>
            </Field>
            <Field label="Role">{hire.role}</Field>
            <Field label="CLI and model">
              {hire.cli} · {hire.model ?? "cli default"}
            </Field>
            <Field label="Projects">{listed(hire.memberships)}</Field>
            <Field label="Also follows">{listed(hire.subscriptions)}</Field>
            {hire.homeRunner === undefined ? null : (
              <Field label="Runs on">{hire.homeRunner}</Field>
            )}
          </Fields>
          {hire.seedInstructions === undefined ? null : (
            <Block>
              <p className="text-caps">Seed instructions</p>
              <div className="mt-1.5">
                <Markdown text={hire.seedInstructions} />
              </div>
            </Block>
          )}
        </>
      );
    }
    case "role": {
      const next = proposedRole(proposal);
      if (next === null) break;
      return (
        <RoleCharterView
          next={next}
          current={roles?.find((role) => role.name === next.name)}
          compare={compare}
        />
      );
    }
    case "skill": {
      const parsed = SkillProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return (
        <>
          <Fields>
            <Field label="Skill">{parsed.data.name}</Field>
            <Field label="Summary">{parsed.data.summary}</Field>
          </Fields>
          <SkillFolder proposal={proposal} />
        </>
      );
    }
    case "channel": {
      const parsed = ChannelProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return (
        <Fields>
          <Field label="Channel">#{channelRef(parsed.data.project, parsed.data.name)}</Field>
          <Field label="Purpose">{parsed.data.purpose}</Field>
        </Fields>
      );
    }
    case "retirement": {
      const parsed = RetirementProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      const member = members?.find((candidate) => candidate.name === parsed.data.agent);
      return (
        <Fields>
          <Field label="Citizen">
            <Citizen name={parsed.data.agent} members={members} />
            {member === undefined ? null : ` · ${member.role}`}
          </Field>
          <Field label="Holds now">
            {member === undefined
              ? "unknown"
              : member.claimsHeld === 1
                ? "1 stage"
                : `${member.claimsHeld} stages`}
          </Field>
          <Field label="Reason">{parsed.data.reason}</Field>
        </Fields>
      );
    }
    case "archive": {
      const parsed = ArchiveProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return (
        <ArchiveCharterView
          proposal={proposal}
          slug={parsed.data.project}
          reason={parsed.data.reason}
          members={members}
        />
      );
    }
    case "reallocation": {
      const parsed = ReallocationProposalSchema.safeParse(charter);
      if (!parsed.success) break;
      return (
        <ReallocationView
          proposal={proposal}
          reallocation={parsed.data}
          current={
            roles === undefined
              ? undefined
              : (roles.find((role) => role.name === parsed.data.role) ?? null)
          }
          compare={compare}
        />
      );
    }
    default:
      break;
  }
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2/40 p-3 font-mono text-[11px] text-fg-tertiary">
      {JSON.stringify(charter, null, 2)}
    </pre>
  );
}
