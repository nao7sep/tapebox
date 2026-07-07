/**
 * Pure, node-free error helpers shared by the main process and the sandboxed
 * renderer. Kept in @shared (not @main/io/spawn, which pulls in
 * node:child_process) precisely so the renderer — whose typecheck excludes
 * @types/node — can flatten errors with the same fidelity as main, instead of
 * degrading to String(err) and losing the stack and cause.
 *
 * describeError flattens any thrown value into a structured, log-ready object
 * with full fidelity — type, message, stack, and the wrapped `cause` chain — so a
 * log reader can reconstruct what failed. It is total: a circular cause chain is
 * capped with a marker rather than overflowing the stack (mirroring redact()).
 *
 * An error class surfaces extra structured fields by implementing LoggableError;
 * describeError merges them in. This is how subprocess errors expose their
 * command / exit code / stderr as discrete keys without this shared module
 * having to know about node:child_process.
 */

/** Marker substituted for a cause that points back into its own chain. */
export const CIRCULAR_CAUSE = '[circular]'

export interface LoggableError {
  /** Extra structured fields to include when this error is logged. */
  toLogFields(): Record<string, unknown>
}

function isLoggable(err: object): err is LoggableError {
  return typeof (err as { toLogFields?: unknown }).toLogFields === 'function'
}

export function describeError(err: unknown): Record<string, unknown> {
  // The top-level value is never a chain repeat (the seen set starts empty), so
  // flatten always yields an object here; the guard just keeps the type honest.
  const flat = flatten(err, new WeakSet())
  return typeof flat === 'object' ? flat : { message: String(err) }
}

function flatten(err: unknown, seen: WeakSet<object>): Record<string, unknown> | string {
  if (!(err instanceof Error)) return { message: String(err) }
  // A cause that re-enters the chain (e.cause = e, or a->b->a) collapses to the
  // marker instead of recursing forever — keeps describeError total so logging
  // never throws on a cyclic cause.
  if (seen.has(err)) return CIRCULAR_CAUSE
  seen.add(err)
  const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack }
  if (isLoggable(err)) {
    try {
      Object.assign(out, err.toLogFields())
    } catch {
      // A misbehaving toLogFields() must not break error logging.
    }
  }
  if (err.cause !== undefined) out.cause = flatten(err.cause, seen)
  return out
}

/** The human-readable message for an error, without a leading "ErrorName:" prefix. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
