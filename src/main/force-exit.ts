/** Node's cleanup can wait for a worker stuck in native I/O. A forced terminal
 * deadline uses the OS termination primitive instead of entering that cleanup. */
export function forceExitProcess(): void {
  process.kill(process.pid, 'SIGKILL')
}
