/**
 * A Worker could not take a message. `retryable` means nothing was delivered
 * and the same message can be sent again later: the prompt was busy, showed a
 * banner or leftover input, or had not come back yet. A non-retryable error
 * means delivery is stuck (the text is still in the input box) or the Worker
 * is gone, and a blind resend would duplicate or misdirect the message.
 */
export class WorkerInputError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkerInputError";
    this.retryable = options.retryable;
  }
}

export function isWorkerInputError(error: unknown): error is WorkerInputError {
  return error instanceof Error && error.name === "WorkerInputError" && typeof (error as { retryable?: unknown }).retryable === "boolean";
}
