import type { IpcCalls, IpcEvents } from '@shared/ipc-contract'

/**
 * Typed wrappers around the contextBridge surface.
 * Channels with `req: undefined` are called with no second argument;
 * channels with a payload type require it. Enforced by the conditional below.
 */

type Bridge = {
  invoke(channel: string, req: unknown): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
  pathForFile(file: File): string
}

const bridge = (window as unknown as { tapebox: Bridge }).tapebox

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
