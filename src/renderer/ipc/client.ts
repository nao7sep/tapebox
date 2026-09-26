import type { IpcCalls, IpcEvents } from '@shared/ipc-contract'
import type { TapeBoxApi } from '@shared/bridge'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

/**
 * Typed wrappers around the contextBridge surface (@shared/bridge).
 * Channels with `req: undefined` are called with no second argument;
 * channels with a payload type require it. Enforced by the conditional below.
 *
 * Main settles every call with an IpcReply; ipcInvoke returns its value or throws
 * its IpcCallError, whose `userMessage` is the only failure text a surface may show
 * (see lib/presentFailure).
 */

const bridge = (window as unknown as { tapebox: TapeBoxApi }).tapebox

type InvokeArgs<K extends keyof IpcCalls> =
  IpcCalls[K]['req'] extends undefined ? [] : [req: IpcCalls[K]['req']]

export async function ipcInvoke<K extends keyof IpcCalls>(
  channel: K,
  ...args: InvokeArgs<K>
): Promise<IpcCalls[K]['res']> {
  const reply = (await bridge.invoke(channel, args[0])) as IpcReply<IpcCalls[K]['res']>
  return unwrapIpcReply(channel, reply)
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
