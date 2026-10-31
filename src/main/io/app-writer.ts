import type { FileWriter } from './file-header'

/** TapeBox as the writer of the files it saves: its package name and release
 * (file-identity-conventions). The store worker threads get it from here. */
export const APP_WRITER: FileWriter = { name: 'tapebox', version: __APP_VERSION__ }
