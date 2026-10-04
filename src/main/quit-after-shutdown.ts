/**
 * The `before-quit` handler. Every quit is held, including one that arrives while
 * shutdown runs, such as window-all-closed after the first quit closed the
 * windows: Electron ends the process on any quit that is not prevented. The first
 * quit starts shutdown, and only the exit after it settles ends the process.
 */
export function quitAfterShutdown(
  shutdown: () => Promise<void>,
  exit: () => void,
): (event: { preventDefault: () => void }) => void {
  let started = false
  return (event) => {
    event.preventDefault()
    if (started) return
    started = true
    // finally (not then) so a teardown error still exits — quit must never hang.
    void shutdown().finally(exit)
  }
}
