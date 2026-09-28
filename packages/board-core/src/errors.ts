export type BoardErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "FORBIDDEN"
  | "INVALID_TRANSITION"
  | "CLAIM_CONFLICT"
  | "INVALID_STATE"
  | "VALIDATION";

export class BoardError extends Error {
  override readonly name = "BoardError";

  constructor(
    readonly code: BoardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isBoardError(error: unknown, code?: BoardErrorCode): error is BoardError {
  return error instanceof BoardError && (code === undefined || error.code === code);
}
