import { useQuery } from "@tanstack/react-query";
import type { Member } from "@stellaris/shared";
import { api } from "../api/client.js";
import { timeAgo } from "../lib/format.js";
import { Markdown } from "./Markdown.js";
import { Empty } from "./ui.js";

/** The society's shared memory: promoted skills, and the knowledge topics every citizen reads. */
export function SharedMemory({ members }: { members: readonly Member[] }) {
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const knowledge = useQuery({
    queryKey: ["knowledge", "society"],
    queryFn: () => api.knowledge(null),
  });
  const withSkills = members.filter((member) => member.skills.length > 0);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-board-muted">Society skills</h3>
        {(skills.data ?? []).length === 0 ? (
          <Empty>
            No skills promoted yet. A citizen proposes one; the steward or the owner approves it.
          </Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {(skills.data ?? []).map((skill) => (
              <li
                key={skill.name}
                className="rounded border border-board-border bg-board-bg/60 px-2 py-1"
              >
                <span className="font-semibold">{skill.name}</span>
                <span className="ml-2 text-board-muted">{skill.summary || "no summary"}</span>
              </li>
            ))}
          </ul>
        )}
        {withSkills.length === 0 ? null : (
          <ul className="mt-2 space-y-1 text-xs text-board-muted">
            {withSkills.map((member) => (
              <li key={member.name}>
                {member.name} keeps: {member.skills.join(", ")}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-board-muted">Society knowledge</h3>
        {(knowledge.data ?? []).length === 0 ? (
          <Empty>
            No topics yet. The steward writes norms and other society-wide knowledge here.
          </Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {(knowledge.data ?? []).map((topic) => (
              <li
                key={topic.topic}
                className="rounded border border-board-border bg-board-bg/60 px-2 py-1"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{topic.topic}</span>
                  <span className="text-xs text-board-muted">
                    by {topic.updatedBy} · {timeAgo(topic.updatedAt)}
                  </span>
                </div>
                <Markdown>{topic.body}</Markdown>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
