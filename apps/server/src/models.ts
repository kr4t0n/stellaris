import type { AgentBackend } from "@stellaris/runner-core";
import type { CliKind, ModelOption } from "@stellaris/shared";

/** Where the interface's model choices come from; the server backs it with the runner's backends. */
export interface ModelSource {
  list(cli: CliKind): Promise<ModelOption[]>;
}

const HOUR = 60 * 60_000;

/**
 * Each CLI's own model list, asked once and kept for an hour, since asking starts a CLI process.
 * Callers that ask at once share one request, and a failed listing is dropped so the next ask retries.
 */
export class ModelCatalog implements ModelSource {
  private readonly kept = new Map<CliKind, { at: number; models: Promise<ModelOption[]> }>();

  constructor(
    private readonly backends: Partial<Record<CliKind, AgentBackend>>,
    private readonly ttlMs = HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  list(cli: CliKind): Promise<ModelOption[]> {
    const backend = this.backends[cli];
    if (backend?.listModels === undefined) {
      return Promise.resolve([]);
    }
    const kept = this.kept.get(cli);
    if (kept !== undefined && this.now() - kept.at < this.ttlMs) {
      return kept.models;
    }
    const models = backend.listModels();
    this.kept.set(cli, { at: this.now(), models });
    models.catch(() => {
      this.kept.delete(cli);
    });
    return models;
  }
}
