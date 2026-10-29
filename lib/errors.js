/**
 * Typed, transport-agnostic failures.
 *
 * Every rejection carries a stable machine code so the HTTP layer, the agent tools and
 * the panel report the same reason instead of guessing from a message. `code` is part
 * of the public contract; `message` is for humans (Chinese, like every host-side string).
 *
 * @module dsh-mainline/errors
 */

/** Machine codes this plugin may return. Add a code here before throwing it. */
export const ERROR_CODES = Object.freeze([
  // the tree
  'invalid-op',
  'invalid-kind',
  'invalid-title',
  'invalid-content',
  'invalid-state',
  'invalid-move',
  'invalid-attrs',
  'not-found',
  // transport
  'invalid-request',
  'invalid-json',
  'payload-too-large',
  'forbidden',
  // storage
  'store-corrupt',
  'store-unwritable',
  'store-busy',
  // collaborators
  'git-unavailable',
  'git-failed',
  'shell-unavailable',
  'session-unavailable',
  'internal',
])

/** A failure that is safe to hand back to a caller. */
export class TreeError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_CODES}
   * @param {string} message - human-readable explanation
   * @param {Record<string, unknown>} [details] - extra structured context
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'TreeError'
    this.code = ERROR_CODES.includes(code) ? code : 'internal'
    if (details !== undefined) this.details = details
  }

  /** Wire shape shared by HTTP replies and tool results. */
  toJSON() {
    return {
      ok: false,
      reason: this.code,
      error: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * Normalize anything thrown into a TreeError, so no caller ever has to guess.
 *
 * @param {unknown} error
 * @returns {TreeError}
 */
export function asTreeError(error) {
  if (error instanceof TreeError) return error
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new TreeError('internal', message)
  if (error instanceof Error && typeof error.stack === 'string') wrapped.stack = error.stack
  return wrapped
}
