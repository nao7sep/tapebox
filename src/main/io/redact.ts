/**
 * Non-destructive, name-based log redaction.
 *
 * A deliberately narrow backstop for the day a whole object that happens to carry
 * a secret is logged — NOT a content scrubber (the primary defense is still
 * "summarize, don't dump"). Per the logging conventions the contract is strict so
 * it can never corrupt a log line:
 *
 *   - Matches field NAMES only, exact and case-insensitive — never a substring,
 *     so `token` never matches `tokenCount` or `broken`.
 *   - Replaces only a matched field's VALUE with REDACTED; every other field
 *     stays byte-identical.
 *   - Recurses through plain objects and arrays; everything else (strings,
 *     numbers, Date, Error, …) passes through untouched, so it never scans string
 *     contents and never edits the `message`.
 *   - Pure, total, type-preserving: it cannot throw and cannot drop fields. A
 *     circular reference is broken with a CIRCULAR marker rather than blowing the
 *     stack, which also leaves the result acyclic so it can always serialize.
 *
 * `deniedKeys` must contain already-lowercased names.
 */
export const REDACTED = '[redacted]'
export const CIRCULAR = '[circular]'

export function redact<T>(value: T, deniedKeys: ReadonlySet<string>): T {
  return redactValue(value, deniedKeys, new WeakSet()) as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function redactValue(value: unknown, deniedKeys: ReadonlySet<string>, ancestors: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR
    ancestors.add(value)
    const out = value.map((item) => redactValue(item, deniedKeys, ancestors))
    ancestors.delete(value)
    return out
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) return CIRCULAR
    ancestors.add(value)
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = deniedKeys.has(key.toLowerCase()) ? REDACTED : redactValue(val, deniedKeys, ancestors)
    }
    ancestors.delete(value)
    return out
  }
  return value
}
