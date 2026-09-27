import { useRuntimeStore } from '@renderer/store/runtime'

/**
 * The running platform's command-modifier word, resolved at runtime: Cmd on
 * macOS, Ctrl elsewhere. Never the combined form or a glyph in live UI
 * (keyboard-shortcut-conventions).
 */
export function useModifierWord(): 'Cmd' | 'Ctrl' {
  const platform = useRuntimeStore((s) => s.info?.platform)
  return platform === 'darwin' ? 'Cmd' : 'Ctrl'
}
