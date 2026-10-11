import type { Message, MessageNotice } from "@stellaris/shared";
import { describe, expect, it } from "vitest";
import { foldNotices, knowledgeDone, namesPhrase, noticeOf } from "./notices.js";

let next = 0;

function post(body: string, extra: Partial<Message> = {}): Message {
  next += 1;
  return {
    id: `01M3Q2KKKKKKKKKKKKKKKKKK${String(next).padStart(2, "0")}`,
    author: "ada",
    channel: "lab/general",
    ts: "2026-10-11T10:00:00.000Z",
    mentions: [],
    body,
    ...extra,
  };
}

function knowledge(
  action: "written" | "updated" | "removed",
  topic = "seeds",
  project: string | null = "lab",
): MessageNotice {
  return { kind: "knowledge", action, topic, project };
}

/** A post the board made for a knowledge verb, with its notice. */
function noted(notice: MessageNotice, author = "ada"): Message {
  return post("Knowledge noted.", { notice, author });
}

describe("noticeOf", () => {
  it("takes a post's own notice, and leaves talk alone", () => {
    expect(noticeOf(noted(knowledge("updated")))).toEqual(knowledge("updated"));
    expect(noticeOf(post("The seeds are fixed now."))).toBeNull();
  });

  it("reads a knowledge note from before notices from the board's own words", () => {
    expect(noticeOf(post("Knowledge updated: seeds. It is under knowledge/seeds.md."))).toEqual(
      knowledge("updated"),
    );
    expect(
      noticeOf(
        post("Knowledge written: norms. It is under knowledge/norms.md of the society.", {
          channel: "general",
        }),
      ),
    ).toEqual(knowledge("written", "norms", null));
    expect(
      noticeOf(post("Knowledge removed: seeds. It is no longer under knowledge/seeds.md.\n")),
    ).toEqual(knowledge("removed"));
  });

  it("reads no note that strays from the template or from where the board posts it", () => {
    // Quoted in a longer post, in a thread, in another channel, or naming another place.
    expect(
      noticeOf(post("Knowledge updated: seeds. It is under knowledge/seeds.md. Read it.")),
    ).toBeNull();
    expect(
      noticeOf(
        post("Knowledge updated: seeds. It is under knowledge/seeds.md.", {
          thread: "01M3Q2KKKKKKKKKKKKKKKKKKZZ",
        }),
      ),
    ).toBeNull();
    expect(
      noticeOf(
        post("Knowledge updated: seeds. It is under knowledge/seeds.md.", {
          channel: "lab/release-1",
        }),
      ),
    ).toBeNull();
    expect(
      noticeOf(post("Knowledge updated: seeds. It is under knowledge/seeds.md of the society.")),
    ).toBeNull();
    expect(noticeOf(post("Knowledge updated: seeds. It is under knowledge/other.md."))).toBeNull();
  });
});

/** A folded stream of posts: each talk by its body, each run by its length. */
function fold(messages: readonly Message[]): (string | number)[] {
  return foldNotices(messages, (message) => message).map((entry) =>
    entry.kind === "item" ? entry.item.body : entry.run.messages.length,
  );
}

describe("foldNotices", () => {
  it("folds a topic written again and again into one run, by anyone", () => {
    expect(
      fold([
        noted(knowledge("written")),
        noted(knowledge("updated"), "ref"),
        noted(knowledge("updated")),
        post("talk"),
      ]),
    ).toEqual([3, "talk"]);
  });

  it("ends a run at talk, another topic, another place, or a removal", () => {
    expect(
      fold([
        noted(knowledge("updated")),
        post("talk"),
        noted(knowledge("updated")),
        noted(knowledge("updated", "harness")),
        noted(knowledge("updated", "harness", null)),
        noted(knowledge("removed", "harness", null)),
        noted(knowledge("updated", "harness", null)),
      ]),
    ).toEqual([1, "talk", 1, 1, 1, 1, 1]);
  });

  it("ends a run at anything else in the stream, such as a thread", () => {
    const stream: { message?: Message; thread?: string }[] = [
      { message: noted(knowledge("updated")) },
      { thread: "opened" },
      { message: noted(knowledge("updated")) },
    ];
    expect(foldNotices(stream, (item) => item.message).map((entry) => entry.kind)).toEqual([
      "notices",
      "item",
      "notices",
    ]);
  });
});

describe("knowledgeDone", () => {
  it("says what a run did, and how often", () => {
    const written = knowledge("written");
    const updated = knowledge("updated");
    expect(knowledgeDone([written])).toEqual({ did: "wrote", times: null });
    expect(knowledgeDone([written, updated])).toEqual({
      did: "wrote",
      times: "then updated it once",
    });
    expect(knowledgeDone([written, updated, updated])).toEqual({
      did: "wrote",
      times: "then updated it 2 times",
    });
    expect(knowledgeDone([updated])).toEqual({ did: "updated", times: null });
    expect(knowledgeDone([updated, updated, updated])).toEqual({
      did: "updated",
      times: "3 times",
    });
    expect(knowledgeDone([knowledge("removed")])).toEqual({ did: "removed", times: null });
  });
});

describe("namesPhrase", () => {
  it("names each author once, in order", () => {
    expect(namesPhrase(["ada"])).toBe("ada");
    expect(namesPhrase(["ada", "ref", "ada"])).toBe("ada and ref");
    expect(namesPhrase(["ada", "ref", "vera"])).toBe("ada, ref, and vera");
  });
});
