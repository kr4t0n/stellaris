import type { BranchFile, Project } from "@stellaris/shared";
import { useState } from "react";
import { FileLink } from "../components/BranchFile.js";
import { ApiError } from "../lib/api.js";
import { entriesInOrder, runnerOf, sizeLabel, type FileSource } from "../lib/files.js";
import { ago } from "../lib/format.js";
import { useBranchFile } from "../lib/session.js";
import { FileIndent, FolderRow, TREE_ROW, TreeLevel } from "./FileTree.js";
import { Section } from "./Overview.js";

/** Which folders of the tree are open, by path, and how to open or close one. */
interface Openings {
  readonly open: ReadonlySet<string>;
  readonly toggle: (path: string) => void;
}

/**
 * One folder's entries as a level of the tree: folders first, each opening in place, then files,
 * each opening in the files view, since a default branch has no change to show beside them.
 */
function Level({
  project,
  source,
  folder,
  nested,
  openings,
}: {
  project: Project;
  source: FileSource;
  folder: Extract<BranchFile, { kind: "dir" }>;
  nested: boolean;
  openings: Openings;
}) {
  return (
    <TreeLevel nested={nested}>
      {entriesInOrder(folder.entries).map((entry) => {
        const path = folder.path === "" ? entry.name : `${folder.path}/${entry.name}`;
        if (entry.kind === "dir") {
          const open = openings.open.has(path);
          return (
            <li key={`dir:${entry.name}`}>
              <FolderRow name={entry.name} open={open} onToggle={() => openings.toggle(path)} />
              {open ? (
                <Folder project={project} source={source} path={path} openings={openings} />
              ) : null}
            </li>
          );
        }
        return (
          <li key={entry.name}>
            <FileLink source={source} path={path} className={`group ${TREE_ROW}`}>
              <FileIndent />
              <span className="min-w-0 truncate text-fg-secondary group-hover:text-fg-primary">
                {entry.name}
              </span>
              {entry.size === null ? null : (
                <span className="shrink-0 text-meta whitespace-nowrap">
                  {sizeLabel(entry.size)}
                </span>
              )}
            </FileLink>
          </li>
        );
      })}
    </TreeLevel>
  );
}

/** A folder opened in place, read from the project's runner when it first opens. */
function Folder({
  project,
  source,
  path,
  openings,
}: {
  project: Project;
  source: FileSource;
  path: string;
  openings: Openings;
}) {
  const folder = useBranchFile(source, path);
  if (folder.data?.kind === "dir") {
    return (
      <Level project={project} source={source} folder={folder.data} nested openings={openings} />
    );
  }
  let state;
  if (
    folder.data?.kind === "file" ||
    (folder.error instanceof ApiError && folder.error.status === 404)
  ) {
    state = `Not on ${project.defaultBranch} now.`;
  } else if (folder.error instanceof ApiError && folder.error.status === 503) {
    state = `${runnerOf(project)}, is not connected.`;
  } else if (folder.error !== null) {
    state = folder.error.message;
  } else {
    state = "Reading…";
  }
  return (
    <TreeLevel nested>
      <li className="py-0.5 pl-[18px] text-meta">{state}</li>
    </TreeLevel>
  );
}

/**
 * A project's default branch, as the clone on the project's runner has it: the commit it shows,
 * and a tree of its folders, each opening in place, and its files, each opening in the files view.
 * What the user opens stays open while the view does, and reads the new branch when it changes.
 */
export function ProjectFiles({ project, now }: { project: Project; now: number }) {
  const source: FileSource = { kind: "project", slug: project.slug };
  const root = useBranchFile(source, "");
  const branch = project.defaultBranch;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string): void => {
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };

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
          <Level
            project={project}
            source={source}
            folder={root.data}
            nested={false}
            openings={{ open, toggle }}
          />
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
