import type { IpcCalls, IpcEvents } from '@shared/ipc-contract'
import type { TapeBoxApi } from '@shared/bridge'

/**
 * Typed wrappers around the contextBridge surface (@shared/bridge).
 * Channels with `req: undefined` are called with no second argument;
 * channels with a payload type require it. Enforced by the conditional below.
 */

const bridge = (window as unknown as { tapebox: TapeBoxApi }).tapebox

type InvokeArgs<K extends keyof IpcCalls> =
  IpcCalls[K]['req'] extends undefined ? [] : [req: IpcCalls[K]['req']]

export function ipcInvoke<K extends keyof IpcCalls>(
  channel: K,
  ...args: InvokeArgs<K>
): Promise<IpcCalls[K]['res']> {
  return bridge.invoke(channel, args[0]) as Promise<IpcCalls[K]['res']>
}

export function ipcOn<K extends keyof IpcEvents>(
  channel: K,
  listener: (payload: IpcEvents[K]) => void,
): () => void {
  return bridge.on(channel, listener as (payload: unknown) => void)
}

export function pathForFile(file: File): string {
  return bridge.pathForFile(file)
}
