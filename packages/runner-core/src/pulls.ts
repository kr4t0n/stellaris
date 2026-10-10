import { execa } from "execa";
import { z } from "zod";

/** A pull request as GitHub has it now. */
export interface PullRequestState {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly title: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  /** Opened from a fork, whose branch the runner may not delete. */
  readonly isCrossRepository: boolean;
  readonly mergeCommit: string | null;
}

/** What landing a pull request needs of GitHub. */
export interface PullRequestOps {
  view(url: string): Promise<PullRequestState>;
  /** Merges with a merge commit, and only while the pull request's head is still `head`. */
  merge(url: string, head: string, message: { subject: string; body: string }): Promise<void>;
  /** Deletes a branch of the pull request's repository on GitHub. */
  deleteBranch(url: string, branch: string): Promise<void>;
}

const ViewSchema = z.object({
  number: z.number().int(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  title: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});

const REPOSITORY = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/;

/**
 * GitHub through the `gh` CLI, with whatever login the runner's machine gives it: the board never
 * holds a GitHub credential.
 */
export class GhPullRequests implements PullRequestOps {
  async view(url: string): Promise<PullRequestState> {
    const out = await this.gh([
      "pr",
      "view",
      url,
      "--json",
      "number,state,title,baseRefName,headRefName,headRefOid,isCrossRepository,mergeCommit",
    ]);
    const view = ViewSchema.parse(JSON.parse(out));
    return { ...view, mergeCommit: view.mergeCommit?.oid ?? null };
  }

  async merge(
    url: string,
    head: string,
    message: { subject: string; body: string },
  ): Promise<void> {
    await this.gh([
      "pr",
      "merge",
      url,
      "--merge",
      "--match-head-commit",
      head,
      "--subject",
      message.subject,
      "--body",
      message.body,
    ]);
  }

  async deleteBranch(url: string, branch: string): Promise<void> {
    const match = REPOSITORY.exec(url);
    if (match === null) {
      throw new Error(`${url} is not a pull request's address`);
    }
    await this.gh([
      "api",
      "-X",
      "DELETE",
      `repos/${match[1]}/${match[2]}/git/refs/heads/${branch}`,
    ]);
  }

  private async gh(args: readonly string[]): Promise<string> {
    const result = await execa("gh", args, {
      reject: false,
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `gh ${args.slice(0, 2).join(" ")} failed`,
      );
    }
    return result.stdout;
  }
}
