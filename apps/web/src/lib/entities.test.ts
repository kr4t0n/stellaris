import type { Proposal } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import {
  entityHref,
  entityIndex,
  entityOfHref,
  remarkEntities,
  splitEntities,
  unknownIds,
  withTitles,
  type Entity,
} from "./entities.js";

const TASK = "01M3RC44KEZX7P9V3PY8YVH1SZ";
const PROPOSAL = "01M3PY56V68VFS0EG5ER4B9AMD";
const TOPIC = "01M3Q2AAAAAAAAAAAAAAAAAAA7";
const CRON = "01M4N2H53YHDVEZZH37KZNDDYG";
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
  [{ id: CRON, title: "Check the deploy" }],
);

const titles = (pieces: ReturnType<typeof splitEntities>) =>
  pieces.map((piece) => (typeof piece === "string" ? piece : `[${piece.kind}:${piece.title}]`));

describe("entities", () => {
  it("names tasks by their titles, proposals as the board describes them, and topics by their threads", () => {
    expect([...index.values()].map((entity: Entity) => [entity.kind, entity.title])).toEqual([
      ["task", "Build the sorting page"],
      ["proposal", "skill refereed-research: Plan a refereed study"],
      ["thread", "Which source wins?"],
      ["cron", "Check the deploy"],
    ]);
  });

  it("reads a cron's id as its title, linked to the crons view opened on it", () => {
    expect(titles(splitEntities(`Set cron ${CRON} "Check the deploy" for nine.`, index))).toEqual([
      "Set cron ",
      "[cron:Check the deploy]",
      " for nine.",
    ]);
    const cron = index.get(CRON);
    expect(cron === undefined ? null : entityHref(cron)).toBe(`/crons?cron=${CRON}`);
    expect(entityOfHref(`/crons?cron=${CRON}`)).toEqual({ kind: "cron", id: CRON });
    expect(entityOfHref(`/crons?agent=desk`)).toBeNull();
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

  it("reads a message's id as who posted it where, linked to its thread or channel", () => {
    const IN_THREAD = "01M4Q9HGDSESZHN48ZW7VSEE6E";
    const IN_CHANNEL = "01M4Q9J0ZPQZM11VPQ4ZFAPY12";
    const BY_USER = "01M4Q9KG75PX6G2GHBHSQMVMHV";
    const ELSEWHERE = "01M4Q9M3WEK0F0Z7J2MHB6VMW1";
    const withMessages = entityIndex([{ id: TOPIC, title: "Which source wins?" }], [], [], [], {
      messages: [
        {
          id: IN_THREAD,
          author: "stew",
          channel: "general",
          thread: TOPIC,
          ts: "2026-10-12T05:32:05.433Z",
        },
        { id: IN_CHANNEL, author: "desk", channel: "lab/general", ts: "2026-10-12T05:32:22.390Z" },
        { id: BY_USER, author: "user", channel: "asks", ts: "2026-10-12T05:33:10.757Z" },
        {
          id: ELSEWHERE,
          author: "sage",
          channel: "lab/general",
          thread: UNKNOWN,
          ts: "2026-10-12T05:33:30.894Z",
        },
      ],
      name: (author) => (author === "user" ? "you" : author),
    });
    // The word before the id is the title's to say.
    expect(
      titles(
        splitEntities(`See message ${IN_THREAD}, Post ${IN_CHANNEL} and ${BY_USER}.`, withMessages),
      ),
    ).toEqual([
      "See ",
      "[message:stew's post in Which source wins?]",
      ", ",
      "[message:desk's post in #lab/general]",
      " and ",
      "[message:your post in #asks]",
      ".",
    ]);
    expect(withMessages.get(ELSEWHERE)?.title).toBe("sage's post in a thread in #lab/general");
    // Whose it is goes too, since the title names who posted it.
    expect(
      withTitles(
        `the draft in desk's message ${IN_CHANNEL}, from my last message (message ${IN_THREAD})`,
        withMessages,
      ),
    ).toBe(
      "the draft in desk's post in #lab/general, from my last message (stew's post in Which source wins?)",
    );
    const href = (id: string) => {
      const entity = withMessages.get(id);
      return entity === undefined ? null : entityHref(entity);
    };
    expect(href(IN_THREAD)).toBe(`/thread/${TOPIC}?message=${IN_THREAD}`);
    expect(href(IN_CHANNEL)).toBe(`/c/lab/general?message=${IN_CHANNEL}`);
    expect(entityOfHref(`/thread/${TOPIC}?message=${IN_THREAD}`)).toEqual({
      kind: "message",
      id: IN_THREAD,
      place: { channel: "", thread: TOPIC },
    });
    expect(entityOfHref(`/c/lab/general?message=${IN_CHANNEL}`)).toEqual({
      kind: "message",
      id: IN_CHANNEL,
      place: { channel: "lab/general" },
    });

    // An id quoted as code drops the word before it too.
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Read message " },
            { type: "inlineCode", value: IN_THREAD },
          ],
        },
      ],
    };
    remarkEntities({ index: withMessages })(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "Read " },
      {
        type: "link",
        url: `/thread/${TOPIC}?message=${IN_THREAD}`,
        title: `message ${IN_THREAD}`,
        children: [{ type: "text", value: "stew's post in Which source wins?" }],
      },
    ]);
  });

  it("lists the ids a text names that nothing in the index names yet, once each", () => {
    expect(unknownIds(`${TASK} and ${UNKNOWN}, ${UNKNOWN}, task/${UNKNOWN}`, index)).toEqual([
      UNKNOWN,
    ]);
  });

  it("never asks about an uploaded image's id as a message's", () => {
    expect(unknownIds(`![the board](image:${UNKNOWN})`, index)).toEqual([]);
    expect(unknownIds(`![the board](image:${UNKNOWN}) is ${UNKNOWN}`, index)).toEqual([UNKNOWN]);
  });
});
