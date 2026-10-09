import type { CliKind, ModelOption, Name, RunnerModels } from "@stellaris/shared";
import { RunnerAwayError } from "@stellaris/turn-host";

/** Where the interface's model choices come from; the server asks a connected runner. */
export interface ModelSource {
  /** `cli`'s models from the first runner of `prefer` that has it, else from any that does. */
  list(cli: CliKind, prefer?: readonly Name[]): Promise<RunnerModels>;
}

/** The runners a model list can come from, as the runner hub offers them. */
export interface ModelRunners {
  modelRunner(cli: CliKind, prefer?: readonly Name[]): Name | null;
  models(cli: CliKind, runner: Name): Promise<ModelOption[]>;
  onRunnerChange(listener: (runner: Name) => void): void;
}

const HOUR = 60 * 60_000;

/**
 * Each runner's list of each CLI's models, asked once and kept for an hour, since asking starts a
 * CLI process on the runner. A runner's lists are forgotten whenever it registers, connects, or
 * goes away, since an upgrade reconnects it and may change what its CLIs list. Callers that ask at
 * once share one request, and a failed listing is dropped so the next ask retries.
 */
export class ModelCatalog implements ModelSource {
  private readonly kept = new Map<string, { at: number; models: Promise<ModelOption[]> }>();

  constructor(
    private readonly runners: ModelRunners,
    private readonly ttlMs = HOUR,
    private readonly now: () => number = Date.now,
  ) {
    runners.onRunnerChange((runner) => this.forget(runner));
  }

  async list(cli: CliKind, prefer: readonly Name[] = []): Promise<RunnerModels> {
    const runner = this.runners.modelRunner(cli, prefer);
    if (runner === null) {
      throw new RunnerAwayError(`no connected runner has ${cli}`);
    }
    const key = `${runner}/${cli}`;
    const kept = this.kept.get(key);
    if (kept !== undefined && this.now() - kept.at < this.ttlMs) {
      return { runner, cli, models: await kept.models };
    }
    const models = this.runners.models(cli, runner);
    this.kept.set(key, { at: this.now(), models });
    models.catch(() => {
      if (this.kept.get(key)?.models === models) {
        this.kept.delete(key);
      }
    });
    return { runner, cli, models: await models };
  }

  /** Drops every list a runner gave. */
  forget(runner: Name): void {
    for (const key of this.kept.keys()) {
      if (key.startsWith(`${runner}/`)) {
        this.kept.delete(key);
      }
    }
  }
}
