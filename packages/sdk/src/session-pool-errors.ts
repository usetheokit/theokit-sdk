/**
 * Errors raised by the session pool (`src/session-pool.ts`). Re-exported from `errors.ts`.
 * No internal-visibility tag in this header (see `task-errors.ts` for why).
 */

import { TheokitAgentError } from "./errors-base.js";

/**
 * `SessionPool.lease` was called after `disposeAll` started. The pool takes no new lease once it
 * is closed; `key` names the session that was refused. Not retryable on the same pool.
 *
 * @public
 */
export class SessionPoolClosedError extends TheokitAgentError {
  override readonly name: string = "SessionPoolClosedError";
  readonly key: string;

  constructor(key: string, options: { cause?: unknown } = {}) {
    super(`session pool is closed: no new lease for ${key}`, {
      ...options,
      isRetryable: false,
      code: "session_pool_closed",
    });
    this.key = key;
  }
}

/**
 * `jsonGenerations` was pointed at a file that is not `{ version: 1, generations }`. The file is
 * left as it was; `file` names it so the caller can move it or choose another path.
 *
 * @public
 */
export class GenerationFileError extends TheokitAgentError {
  override readonly name: string = "GenerationFileError";
  readonly file: string;

  constructor(file: string, reason: string, options: { cause?: unknown } = {}) {
    super(`generation file ${file} is not a session-pool generation file: ${reason}`, {
      ...options,
      isRetryable: false,
      code: "generation_file_invalid",
    });
    this.file = file;
  }
}
