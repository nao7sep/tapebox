/** Keep renderer focus chrome in step with native app/window activation. */
export function installWindowActivityState(
  subscribe: (listener: (active: boolean) => void) => () => void,
  root: Pick<Element, 'toggleAttribute'>,
): () => void {
  return subscribe((active) => {
    root.toggleAttribute('data-window-inactive', !active)
  })
}
