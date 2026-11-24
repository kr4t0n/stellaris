import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { execa } from "execa";

/** `agy acp` as a process: newline-delimited JSON-RPC 2.0 on its stdin and stdout. */
export interface AcpProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type SpawnAgy = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => AcpProcess;

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function defaultSpawnAgy(agyPath: string): SpawnAgy {
  return (args, options) => {
    const child = execa(agyPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("agy acp did not expose stdio pipes");
    }
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.then(
        (result) => result.exitCode ?? null,
        () => null,
      ),
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  };
}

/** A JSON-RPC error the agent answered a request with, its code kept for the caller to read. */
export class AcpError extends Error {
  override readonly name = "AcpError";

  constructor(
    readonly code: number | undefined,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ClientHandlers {
  readonly notification: (method: string, params: unknown) => void;
  readonly stderr: (line: string) => void;
  /** Every line the agent wrote, before it is parsed. */
  readonly line: (line: string) => void;
  readonly exit: () => void;
}

/** How long a request other than a prompt may go unanswered. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The client side of ACP's JSON-RPC: requests with ids, notifications without, and the agent's own
 * requests. A permission request, which `--dangerously-skip-permissions` should leave unsent, is
 * allowed once and never always, since `allow_always` saves a rule into the account's settings;
 * every other request is refused, as the client offers no file system or terminal.
 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly process: AcpProcess,
    private readonly handlers: ClientHandlers,
  ) {
    const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      this.handlers.line(line);
      this.receive(line);
    });
    const errors = createInterface({ input: process.stderr, crlfDelay: Infinity });
    errors.on("line", (line) => this.handlers.stderr(line));
    void (async () => {
      await process.exited;
      this.closed = true;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("agy acp exited"));
        this.pending.delete(id);
      }
      this.handlers.exit();
    })();
  }

  /** Sends a request; `timeoutMs` null waits as long as the agent takes, as a prompt does. */
  request(
    method: string,
    params: unknown,
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("agy acp is closed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`agy acp did not answer ${method} within ${timeoutMs} ms`));
            }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.write({ jsonrpc: "2.0", method, params });
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.process.kill();
  }

  private write(message: Dict): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isDict(parsed)) {
      return;
    }
    const method = str(parsed["method"]);
    const id = parsed["id"];
    if (method !== undefined && (typeof id === "number" || typeof id === "string")) {
      this.answer(id, method, parsed["params"]);
      return;
    }
    if (method !== undefined) {
      this.handlers.notification(method, parsed["params"]);
      return;
    }
    if (typeof id !== "number") {
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const error = parsed["error"];
    if (isDict(error)) {
      const code = error["code"];
      entry.reject(
        new AcpError(
          typeof code === "number" ? code : undefined,
          str(error["message"]) ?? `agy acp refused ${entry.method}`,
          error["data"],
        ),
      );
      return;
    }
    entry.resolve(parsed["result"]);
  }

  private answer(id: number | string, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      const options = isDict(params) && Array.isArray(params["options"]) ? params["options"] : [];
      const once = options.find((option) => isDict(option) && option["kind"] === "allow_once");
      const optionId = isDict(once) ? str(once["optionId"]) : undefined;
      this.write({
        jsonrpc: "2.0",
        id,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported ${method}` } });
  }
}
