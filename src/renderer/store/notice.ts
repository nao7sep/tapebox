import { create } from 'zustand'

/**
 * Transient app notices (replaces native alert()). Producers call notify();
 * whatever surface is mounted (today the StatusBar) renders `notice`. Keeping
 * the message here — not in the StatusBar — means a StatusBar redesign (or a
 * move to toasts) won't touch the producers.
 *
 * One notice at a time: the latest wins and auto-clears after a TTL.
 */

export type NoticeKind = 'info' | 'error'
export type Notice = { text: string; kind: NoticeKind }

const DEFAULT_TTL_MS = 6000

type NoticeState = {
  notice: Notice | null
  notify: (text: string, kind?: NoticeKind, ttlMs?: number) => void
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useNoticeStore = create<NoticeState>((set) => ({
  notice: null,
  notify: (text, kind = 'info', ttlMs = DEFAULT_TTL_MS) => {
    if (timer) clearTimeout(timer)
    set({ notice: { text, kind } })
    timer = setTimeout(() => {
      timer = null
      set({ notice: null })
    }, ttlMs)
  },
  clear: () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    set({ notice: null })
  },
}))
