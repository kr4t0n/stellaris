import type { Member, RoleCharter } from "@stellaris/shared";
import type { ReactNode } from "react";
import { Markdown } from "../components/Markdown.js";
import { useAgentSkills, useMemoryCore } from "../lib/session.js";
import { withoutTitle } from "./citizen.js";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-section">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * What a citizen carries from turn to turn: the profile it keeps for others, the core memory every
 * turn loads, its own skills, and the charter of its role.
 */
export function CitizenMemory({
  member,
  charter,
}: {
  member: Member;
  charter: RoleCharter | undefined;
}) {
  const memory = useMemoryCore(member.name);
  const skills = useAgentSkills(member.name);
  return (
    <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <Section title="Profile">
        {member.profile.trim() === "" ? (
          <p className="text-meta">No profile yet. The citizen writes its own profile.md.</p>
        ) : (
          <Markdown text={withoutTitle(member.profile, "Profile")} />
        )}
      </Section>
      <Section title="Core memory">
        {memory.data === undefined ? (
          <p className="text-meta">Reading…</p>
        ) : memory.data.body.trim() === "" ? (
          <p className="text-meta">Empty. Every turn loads this file in full.</p>
        ) : (
          <Markdown text={withoutTitle(memory.data.body, "Core memory")} />
        )}
      </Section>
      <Section title="Own skills">
        {skills.data === undefined ? (
          <p className="text-meta">Reading…</p>
        ) : skills.data.length === 0 ? (
          <p className="text-meta">None yet.</p>
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
      {charter === undefined ? null : (
        <Section title={`Charter of ${charter.name}`}>
          <p className="text-sm text-fg-secondary">{charter.purpose}</p>
          <p className="mt-2 text-meta">
            Wakes on mentions, stages, and {charter.wakeTriggers.join(", ") || "nothing else"}
            {charter.resident ? " · keeps a warm session" : ""}
            {charter.reflects ? " · reflects" : ""}
          </p>
          <p className="mt-2 flex flex-wrap gap-1">
            {charter.verbs.map((verb) => (
              <span
                key={verb}
                className="rounded-md bg-surface-2/70 px-1.5 py-px font-mono text-[11px] text-fg-tertiary"
              >
                {verb}
              </span>
            ))}
          </p>
        </Section>
      )}
    </div>
  );
}
