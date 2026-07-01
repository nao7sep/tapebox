import type { Role } from '@shared/binary-status'

/**
 * Maps a managed-dependency status role to its theme classes, so call sites name
 * INTENT (a semantic role) rather than a colour — the same discipline the Button
 * variants follow. The whole status palette is re-skinnable by editing this map
 * without touching a single call site (managed-runtime-dependencies-conventions:
 * roles map to theme colour, never a colour named at the call site).
 *
 *   info    — benign, no action (Installed (not checked)): the neutral text tone
 *   warning — an action is available (Not installed, Update available): amber
 *   error   — a just-failed operation, shown transiently by the surface: red
 *
 * 'none' is the quiet baseline (Up to date) — it carries no emphasis.
 */
export const ROLE_TEXT_CLASS: Record<Role, string> = {
  none: 'text-zinc-300',
  info: 'text-zinc-300',
  warning: 'text-amber-300',
  error: 'text-red-300',
}
