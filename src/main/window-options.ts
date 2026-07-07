import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/layout'

/**
 * The main window's BrowserWindow options, isolated in its own module so the
 * sizing can be asserted in a unit test without importing index.ts (which boots
 * Electron at module load). The default size is the designed launch size
 * (persistence is off — window-chrome-conventions); the minimums are DERIVED in
 * @shared/layout from the pane minimums plus fixed chrome, so the OS floor can
 * never let a pane be squeezed out and there is no hand-typed magic minimum to
 * drift. `preload` is injected because it depends on the caller's resolved
 * __dirname.
 */
export function windowOptions(preload: string): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: '#09090b',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Let the player's autoplay setting take effect without requiring a
      // per-load user gesture. Whether a tape actually autoplays is still
      // gated by the in-app setting (passed as <video autoPlay>).
      autoplayPolicy: 'no-user-gesture-required',
    },
  }
}
