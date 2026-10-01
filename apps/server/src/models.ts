import type { CliKind, ModelOption } from "@stellaris/shared";

/** Where the interface's model choices come from; the server asks a connected runner. */
export interface ModelSource {
  list(cli: CliKind): Promise<ModelOption[]>;
}

/** Asks a CLI's own model list, wherever that CLI is installed. */
export type ModelLister = (cli: CliKind) => Promise<ModelOption[]>;

const HOUR = 60 * 60_000;

/**
 * Each CLI's own model list, asked once and kept for an hour, since asking starts a CLI process on
 * a runner. Callers that ask at once share one request, and a failed listing is dropped so the
 * next ask retries.
 */
export class ModelCatalog implements ModelSource {
  private readonly kept = new Map<CliKind, { at: number; models: Promise<ModelOption[]> }>();

  constructor(
    private readonly lister: ModelLister,
    private readonly ttlMs = HOUR,
    private readonly now: () => number = Date.now,
  ) {}

  list(cli: CliKind): Promise<ModelOption[]> {
    const kept = this.kept.get(cli);
    if (kept !== undefined && this.now() - kept.at < this.ttlMs) {
      return kept.models;
    }
    const models = this.lister(cli);
    this.kept.set(cli, { at: this.now(), models });
    models.catch(() => {
      this.kept.delete(cli);
    });
    return models;
  }
}
