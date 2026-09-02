import { describeError } from '@shared/error'

interface StartupFailureLogger {
  error(message: string, fields?: Record<string, unknown>): void
}

/** Terminal settlement shared by initial bootstrap and later window recreation. */
export async function settleTerminalStartupFailure(
  error: unknown,
  dependencies: {
    log: StartupFailureLogger
    notify: () => Promise<void>
    exit: (code: number) => void
  },
): Promise<void> {
  dependencies.log.error('startup failed', { error: describeError(error) })
  try {
    await dependencies.notify()
  } catch (dialogError) {
    dependencies.log.error('startup failure dialog failed', { error: describeError(dialogError) })
  } finally {
    dependencies.exit(1)
  }
}
