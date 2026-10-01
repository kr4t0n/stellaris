import { SOCIETY_SCOPE, USER_ROLE } from "@stellaris/shared";
import {
  useKnowledge,
  useMembers,
  useNow,
  useProjects,
  useRoles,
  useSkills,
  useSociety,
} from "../lib/session.js";
import { CrewList, Section, TopicList } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";

/** The society at a glance: its citizens, the roles they fill, and what it knows and can do. */
export function SocietyView() {
  const society = useSociety();
  const members = useMembers();
  const projects = useProjects();
  const roles = useRoles();
  const skills = useSkills();
  const knowledge = useKnowledge(SOCIETY_SCOPE);
  const now = useNow(30_000);

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
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="Citizens">
          <CrewList members={active} scope={SOCIETY_SCOPE} />
          {retired.length === 0 ? null : (
            <p className="mt-2 text-meta">
              Retired: {retired.map((member) => member.name).join(", ")}
            </p>
          )}
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
                      {role.societyScope ? " · watches the society" : ""}
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
            <ul className="space-y-1.5">
              {skills.data.map((skill) => (
                <li key={skill.name} className="text-sm">
                  <span className="text-fg-primary">{skill.name}</span>
                  {skill.summary === "" ? null : (
                    <span className="text-fg-secondary"> · {skill.summary}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
