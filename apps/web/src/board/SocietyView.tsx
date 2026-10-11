import { SOCIETY_SCOPE, USER_ROLE, type Skill } from "@stellaris/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import {
  useChannels,
  useKnowledge,
  useMembers,
  useNow,
  useProjects,
  useRoles,
  useSession,
  useSkills,
  useSociety,
} from "../lib/session.js";
import { ChannelList, NewChannelForm } from "./ChannelForms.js";
import { CrewList, Section, TopicList } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { Failure, FIELD } from "./ThreadForms.js";

/**
 * The society at a glance: its citizens, its channels, the roles they fill, and what it knows and
 * can do; a channel of the society is opened here, and a skill it no longer needs removed.
 */
export function SocietyView() {
  const society = useSociety();
  const members = useMembers();
  const projects = useProjects();
  const roles = useRoles();
  const skills = useSkills();
  const knowledge = useKnowledge(SOCIETY_SCOPE);
  const channels = useChannels();
  const now = useNow(30_000);
  const [opening, setOpening] = useState(false);

  if (society.data === undefined || members.data === undefined) {
    return <PaneNote>Reading the society…</PaneNote>;
  }
  const citizens = members.data.filter((member) => member.cli !== null);
  const active = citizens.filter((member) => member.status === "active");
  const retired = citizens.filter((member) => member.status === "retired");
  const charters = (roles.data ?? []).filter((role) => role.name !== USER_ROLE);

  return (
    <>
      <PaneHeader
        title={society.data.name}
        subtitle={`${active.length} citizens · ${projects.data?.length ?? 0} projects · ${charters.length} roles`}
      />
      {opening ? <NewChannelForm project={null} onDone={() => setOpening(false)} /> : null}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="Citizens">
          <CrewList members={active} scope={SOCIETY_SCOPE} />
          {retired.length === 0 ? null : (
            <p className="mt-2 text-meta">
              Retired: {retired.map((member) => member.name).join(", ")}
            </p>
          )}
        </Section>
        <Section
          title="Channels"
          aside={opening ? null : <Button onClick={() => setOpening(true)}>New channel…</Button>}
        >
          <ChannelList
            channels={(channels.data ?? []).filter((channel) => channel.project === null)}
            now={now}
          />
        </Section>
        <Section title="Roles">
          <ul className="space-y-2.5">
            {charters.map((role) => {
              const holders = active.filter((member) => member.role === role.name).length;
              return (
                <li key={role.name}>
                  <p className="flex items-baseline gap-2 text-sm">
                    <span className="text-fg-primary">{role.name}</span>
                    <span className="text-meta">
                      {holders === 1 ? "1 member" : `${holders} members`}
                      {role.resident ? " · warm session" : ""}
                      {role.societyScope ? " · society role" : ""}
                    </span>
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-fg-secondary">
                    {role.purpose}
                  </p>
                </li>
              );
            })}
          </ul>
        </Section>
        <Section title="Knowledge">
          <TopicList scope={SOCIETY_SCOPE} topics={knowledge.data} now={now} />
        </Section>
        <Section title="Skills">
          {skills.data === undefined ? (
            <p className="text-meta">Reading…</p>
          ) : skills.data.length === 0 ? (
            <p className="text-meta">None yet. A citizen's skill joins the society by proposal.</p>
          ) : (
            <SkillList skills={skills.data} />
          )}
        </Section>
      </div>
    </>
  );
}

/** The society's skills, each removable with a reason. */
function SkillList({ skills }: { skills: readonly Skill[] }) {
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <ul className="space-y-1.5">
      {skills.map((skill) => (
        <li key={skill.name}>
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 text-sm">
              <span className="text-fg-primary">{skill.name}</span>
              {skill.summary === "" ? null : (
                <span className="text-fg-secondary"> · {skill.summary}</span>
              )}
            </p>
            {removing === skill.name ? null : (
              <Button aria-label={`Remove ${skill.name}…`} onClick={() => setRemoving(skill.name)}>
                Remove…
              </Button>
            )}
          </div>
          {removing === skill.name ? (
            <RemoveSkillForm name={skill.name} onDone={() => setRemoving(null)} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Removes a society skill with the reason, which the board's notice in general quotes. */
function RemoveSkillForm({ name, onDone }: { name: string; onDone: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const reasonField = useRef<HTMLInputElement>(null);
  useEffect(() => reasonField.current?.focus(), []);
  const remove = useMutation({
    mutationFn: () => api.removeSkill({ name, reason: reason.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["skills"] });
      onDone();
    },
  });
  return (
    <form
      aria-label={`Remove ${name}`}
      className="mt-2 space-y-2 rounded-lg bg-surface-2/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        remove.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={reasonField}
          value={reason}
          aria-label="Reason"
          placeholder="Why it is wrong, superseded, or unused"
          onChange={(event) => setReason(event.target.value)}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={remove.isPending || reason.trim() === ""}>
          {remove.isPending ? "Removing…" : "Remove skill"}
        </Button>
      </div>
      <p className="text-meta">
        No citizen's skills index lists {name} from its next turn, and a notice in #general says so
        with your reason, waking nobody. Its proposer keeps its own copy, and the server keeps the
        text aside.
      </p>
      <Failure error={remove.error} />
    </form>
  );
}
