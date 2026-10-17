import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BackLink } from "../components/BackLink.js";
import { Button } from "../components/Button.js";
import { Markdown } from "../components/Markdown.js";
import { useSession, useSkillFiles, useSkills } from "../lib/session.js";
import { skillText } from "./governance.js";
import { Section } from "./Overview.js";
import { PaneHeader, PaneNote } from "./Pane.js";
import { SkillFileList } from "./SkillFileList.js";
import { Failure, FIELD } from "./ThreadForms.js";

const BACK =
  "grid size-7 shrink-0 place-items-center rounded-lg text-fg-tertiary hover:bg-surface-2/70 hover:text-fg-primary";

/**
 * One skill of the society, as it is published: its SKILL.md, then every file beside it, each
 * opening to its text. Removing it asks for a reason and returns to the society.
 */
export function SkillView() {
  const { name } = useParams({ from: "/skills/$name" });
  const skills = useSkills();
  const files = useSkillFiles(name);
  const [removing, setRemoving] = useState(false);
  const skill = skills.data?.find((candidate) => candidate.name === name);

  if (skill === undefined) {
    return (
      <PaneNote>
        {skills.data === undefined ? "Reading…" : `The society has no skill ${name}.`}
      </PaneNote>
    );
  }
  const manual = files.data?.find((file) => file.path === "SKILL.md");
  const others = files.data?.filter((file) => file.path !== "SKILL.md") ?? [];
  return (
    <>
      <PaneHeader
        leading={
          <BackLink
            fallback={
              <Link to="/society" aria-label="Back to the society" className={BACK}>
                ←
              </Link>
            }
          />
        }
        title={skill.name}
        subtitle={
          skill.summary === "" ? undefined : <span title={skill.summary}>{skill.summary}</span>
        }
        trailing={removing ? null : <Button onClick={() => setRemoving(true)}>Remove…</Button>}
      />
      {removing ? <RemoveSkillForm name={skill.name} onCancel={() => setRemoving(false)} /> : null}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {files.data === undefined ? (
          <p className="text-meta">{files.isError ? "Could not read its files." : "Reading…"}</p>
        ) : (
          <>
            {manual === undefined || manual.text === null ? null : (
              <Markdown text={skillText(manual.text)} />
            )}
            {others.length === 0 ? null : (
              <Section title="Files">
                <SkillFileList files={others} />
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Removes a society skill with the reason, which the board's notice in general quotes. */
function RemoveSkillForm({ name, onCancel }: { name: string; onCancel: () => void }) {
  const { api } = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const reasonField = useRef<HTMLInputElement>(null);
  useEffect(() => reasonField.current?.focus(), []);
  const remove = useMutation({
    mutationFn: () => api.removeSkill({ name, reason: reason.trim() }),
    onSuccess: async () => {
      // Leave first, so the skill's files, gone with it, are not asked for again.
      await navigate({ to: "/society" });
      await client.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  return (
    <form
      aria-label={`Remove ${name}`}
      className="space-y-2 border-b border-line bg-surface-2/20 p-3"
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
        <Button onClick={onCancel}>Cancel</Button>
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
