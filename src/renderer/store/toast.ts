import { create } from 'zustand'
import { nanoid } from 'nanoid'

/**
 * App toasts (replaces native alert()). Producers call notify(); the surfaces
 * render from here. Two severities with different lifetimes:
 *   - 'info'  — a passing confirmation; auto-dismisses after a TTL. Shown in the
 *               status bar's center zone (ambient, non-blocking).
 *   - 'error' — stays until the user dismisses it. Shown as a floating card with
 *               a close button (see Toaster), so a failure can't scroll away
 *               before it's read.
 *
 * Keeping the message here — not in any one surface — means a producer never
 * needs to know where its toast is rendered.
 */

export type ToastKind = 'info' | 'error'
export type Toast = { id: string; text: string; kind: ToastKind }

const INFO_TTL_MS = 6000

type ToastState = {
  toasts: Toast[]
  notify: (text: string, kind?: ToastKind, ttlMs?: number) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  notify: (text, kind = 'info', ttlMs = INFO_TTL_MS) => {
    const id = nanoid(8)
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    if (kind === 'info') setTimeout(() => get().dismiss(id), ttlMs)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
