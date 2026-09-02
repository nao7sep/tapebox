export interface MainWindowContentTarget {
  loadURL(url: string): Promise<void>
  loadFile(filePath: string): Promise<void>
}

/** Keep Chromium's renderer load rejectable until the startup owner settles it. */
export function loadMainWindowContent(
  win: MainWindowContentTarget,
  rendererUrl: string | undefined,
  rendererFile: string,
): Promise<void> {
  return rendererUrl ? win.loadURL(rendererUrl) : win.loadFile(rendererFile)
}
