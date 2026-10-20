import { useRuntimeStore } from '@renderer/store/runtime'

/**
 * The running platform's command-modifier word, resolved at runtime: Cmd on
 * macOS, Ctrl elsewhere. Never the combined form or a glyph in live UI: the ⌘
 * glyph reads as noise to anyone not on a Mac.
 */
export function useModifierWord(): 'Cmd' | 'Ctrl' {
  const platform = useRuntimeStore((s) => s.info?.platform)
  return platform === 'darwin' ? 'Cmd' : 'Ctrl'
}
