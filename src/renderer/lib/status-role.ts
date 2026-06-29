import type { Role } from '@shared/binary-status'

/**
 * Maps a managed-dependency status role to its theme classes, so call sites name
 * INTENT (a semantic role) rather than a colour — the same discipline the Button
 * variants follow. The whole status palette is re-skinnable by editing this map
 * without touching a single call site (managed-dependency-status-conventions:
 * "never through a hard-coded colour named at the call site").
 *
 *   informational — benign, no action (Unchecked, Unmanaged): the neutral text tone
 *   warning       — an action is available, nothing is wrong (Stale, Absent): amber
 *   error         — something is wrong (Faulted, Check-failed, a failed op): red
 *
 * 'none' is the quiet baseline (Provisioned + Current) — it carries no emphasis.
 */
export const ROLE_TEXT_CLASS: Record<Role, string> = {
  none: 'text-zinc-300',
  info: 'text-zinc-300',
  warning: 'text-amber-300',
  error: 'text-red-300',
}
