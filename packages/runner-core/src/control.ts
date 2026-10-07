import type { TurnSteer } from "@stellaris/shared";

/** What an adapter does with a steer or a stop while its CLI can act on them. */
export interface TurnHandlers {
  /** Pushes the text into the running turn; false when the CLI cannot take it now. */
  readonly steer?: ((steer: TurnSteer) => Promise<boolean>) | undefined;
  readonly stop?: (() => void) | undefined;
}

/**
 * The runner's handle on one turn while it runs. The server's steers and stops arrive here from
 * the moment the job does; an adapter attaches handlers while its CLI can act on them and detaches
 * as the turn ends, so a steer outside that window is refused and waits for the next turn. A stop
 * that arrives before the adapter attached is handed over when it does.
 */
export class TurnControl {
  private handlers: TurnHandlers | null = null;
  private stopRequested = false;

  get stopped(): boolean {
    return this.stopRequested;
  }

  /** Takes over the turn's steers and stops; returns the call that lets them go. */
  attach(handlers: TurnHandlers): () => void {
    this.handlers = handlers;
    if (this.stopRequested) {
      handlers.stop?.();
    }
    return () => {
      if (this.handlers === handlers) {
        this.handlers = null;
      }
    };
  }

  async steer(steer: TurnSteer): Promise<boolean> {
    const handler = this.handlers?.steer;
    if (this.stopRequested || handler === undefined) {
      return false;
    }
    return handler(steer);
  }

  /** Asks the turn to stop; the adapter interrupts its CLI, now or once it attaches. */
  stop(): void {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.handlers?.stop?.();
  }
}
