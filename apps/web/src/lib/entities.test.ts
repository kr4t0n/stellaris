import type { Proposal } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  entityIndex,
  entityOfHref,
  remarkEntities,
  splitEntities,
  withTitles,
  type Entity,
} from "./entities.js";

const TASK = "01M3RC44KEZX7P9V3PY8YVH1SZ";
const PROPOSAL = "01M3PY56V68VFS0EG5ER4B9AMD";
const TOPIC = "01M3Q2AAAAAAAAAAAAAAAAAAA7";
const UNKNOWN = "01M3ZZZZZZZZZZZZZZZZZZZZZZ";

const proposal: Proposal = {
  id: PROPOSAL,
  kind: "skill",
  proposedBy: "stew",
  status: "proposed",
  createdAt: "2026-09-30T06:00:00.000Z",
  charter: { name: "refereed-research", summary: "Plan a refereed study.", body: "x" },
  body: "",
};

const index = entityIndex(
  [
    { id: TASK, title: "old thread title", subject: { kind: "task" } },
    { id: PROPOSAL, title: "skill proposal: refereed-research", subject: { kind: "proposal" } },
    { id: TOPIC, title: "Which source wins?" },
  ],
  [{ id: TASK, title: "Build the sorting page" }],
  [proposal],
);

const titles = (pieces: ReturnType<typeof splitEntities>) =>
  pieces.map((piece) => (typeof piece === "string" ? piece : `[${piece.kind}:${piece.title}]`));

describe("entities", () => {
  it("names tasks by their titles, proposals as the board describes them, and topics by their threads", () => {
    expect([...index.values()].map((entity: Entity) => [entity.kind, entity.title])).toEqual([
      ["task", "Build the sorting page"],
      ["proposal", "skill refereed-research: Plan a refereed study"],
      ["thread", "Which source wins?"],
    ]);
  });

  it("reads known ids as what they name and leaves unknown ids, branches, and paths as written", () => {
    expect(
      titles(
        splitEntities(
          `Task ${TASK} is done: task/${TASK} merged. See ${TOPIC}, ${UNKNOWN}, ${TASK}.md; x${TASK}y.`,
          index,
        ),
      ),
    ).toEqual([
      "Task ",
      "[task:Build the sorting page]",
      ` is done: task/${TASK} merged. See `,
      "[thread:Which source wins?]",
      `, ${UNKNOWN}, ${TASK}.md; x${TASK}y.`,
    ]);
  });

  it("drops a title written again right after its id, quoted or after a colon", () => {
    expect(
      withTitles(`stage "review" of task ${TASK} "Build the sorting page" in python-study`, index),
    ).toBe('stage "review" of task Build the sorting page in python-study');
    expect(
      withTitles(
        `Proposal ${PROPOSAL}: skill refereed-research: Plan a refereed study.\n\nWhy.`,
        index,
      ),
    ).toBe("Proposal skill refereed-research: Plan a refereed study.\n\nWhy.");
    // A different title after the id is the writer's own words and stays.
    expect(withTitles(`task ${TASK} "the page"`, index)).toBe(
      'task Build the sorting page "the page"',
    );
  });

  it("turns ids into links in markdown text and in code spans of an id alone, never inside a link", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: `Picked up ${TASK}.` },
            { type: "inlineCode", value: PROPOSAL },
            { type: "inlineCode", value: `task/${TASK}` },
            { type: "inlineCode", value: UNKNOWN },
            { type: "link", url: "https://x", children: [{ type: "text", value: TASK }] },
          ],
        },
      ],
    };
    remarkEntities({ index })(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "Picked up " },
      {
        type: "link",
        url: `/task/${TASK}`,
        title: `task ${TASK}`,
        children: [{ type: "text", value: "Build the sorting page" }],
      },
      { type: "text", value: "." },
      {
        type: "link",
        url: `/proposal/${PROPOSAL}`,
        title: `proposal ${PROPOSAL}`,
        children: [{ type: "text", value: "skill refereed-research: Plan a refereed study" }],
      },
      { type: "inlineCode", value: `task/${TASK}` },
      { type: "inlineCode", value: UNKNOWN },
      { type: "link", url: "https://x", children: [{ type: "text", value: TASK }] },
    ]);
    expect(entityOfHref(`/task/${TASK}`)).toEqual({ kind: "task", id: TASK });
    expect(entityOfHref(`/proposal/${PROPOSAL}`)).toEqual({ kind: "proposal", id: PROPOSAL });
    expect(entityOfHref("https://example.com/task/x")).toBeNull();
  });
});
