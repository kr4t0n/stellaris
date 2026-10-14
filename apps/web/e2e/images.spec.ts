import { expect, test } from "@playwright/test";
import { fakeBoard, MISSING_IMAGE, STAGE_TASK, TOKEN, UPLOADED_IMAGE } from "./board.js";

test("an image a citizen uploaded shows in its post, read with the board's token, and an unknown one reads as its description", async ({
  page,
}) => {
  const asked: Array<{ path: string; authorization: string | undefined }> = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/images/")) {
      asked.push({ path: pathname, authorization: request.headers()["authorization"] });
    }
  });
  await fakeBoard(page, { uploads: true });
  await page.goto(`/task/${STAGE_TASK}`);

  const thread = page.getByRole("region", { name: "Board content" }).getByRole("region", {
    name: "Thread",
  });
  const before = thread.getByRole("img", { name: "The survey page, before" });
  await expect(before).toBeVisible();
  await expect.poll(() => before.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(before).toHaveAttribute("src", /^data:image\/png;base64,/);

  // The board has no such image: the post keeps its words, with the board's reason on hover.
  const after = thread.getByText("The survey page, after", { exact: true });
  await expect(after).toBeVisible();
  await expect(after).toHaveAttribute("title", "image not found");
  await expect(thread.getByRole("img", { name: "The survey page, after" })).toHaveCount(0);
  await expect(thread).toContainText("The survey page before the change:");

  expect(asked).toContainEqual({
    path: `/api/images/${UPLOADED_IMAGE}`,
    authorization: `Bearer ${TOKEN}`,
  });
  // An unknown image is asked for once, not again and again.
  expect(asked.filter((each) => each.path === `/api/images/${MISSING_IMAGE}`)).toHaveLength(1);
});
