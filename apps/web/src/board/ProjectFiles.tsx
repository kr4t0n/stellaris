import type { Project } from "@stellaris/shared";
import { FileLink, FolderList } from "../components/BranchFile.js";
import { ApiError } from "../lib/api.js";
import { runnerOf, type FileSource } from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useBranchFile } from "../lib/session.js";
import { Section } from "./Overview.js";

/**
 * The top of a project's default branch, as the clone on the project's runner has it: the commit
 * it shows, and each folder and file, which opens in the files view.
 */
export function ProjectFiles({ project, now }: { project: Project; now: number }) {
  const source: FileSource = { kind: "project", slug: project.slug };
  const root = useBranchFile(source, "");
  const branch = project.defaultBranch;

  let body;
  if (root.data?.kind === "dir") {
    const { commit } = root.data;
    body = (
      <>
        <p className="text-meta">
          {branch} · committed by {commit.author} {ago(commit.at, now)} · {commit.id.slice(0, 7)}
        </p>
        {root.data.entries.length === 0 ? (
          <p className="mt-2 text-meta">Nothing on {branch} yet.</p>
        ) : (
          <FolderList source={source} file={root.data} className="mt-2 space-y-1" />
        )}
      </>
    );
  } else if (root.error instanceof ApiError && root.error.status === 404) {
    body = <p className="text-meta">Nothing on {branch} yet.</p>;
  } else if (root.error instanceof ApiError && root.error.status === 503) {
    body = (
      <p className="text-meta">
        {runnerOf(project)}, is not connected, so the project's files cannot be listed now.
      </p>
    );
  } else if (root.error !== null) {
    body = <p className="text-meta">{root.error.message}</p>;
  } else {
    body = <p className="text-meta">Reading {branch}…</p>;
  }

  return (
    <Section
      title="Files"
      aside={
        <FileLink
          source={source}
          path=""
          className="text-meta underline decoration-line underline-offset-2 hover:text-fg-primary"
        >
          Browse the branch
        </FileLink>
      }
    >
      {body}
    </Section>
  );
}
