import { useSelectionStore } from '@renderer/store/selection'

/**
 * Select a tape. Used wherever a tape row is clicked or arrowed to (inbox, archive
 * box, search results). Clicking a row also hands Up/Down to that list for free:
 * the row is a non-focusable option inside its focusable listbox container, so the
 * click focuses the container. A thin wrapper kept as the single named selection
 * entry point the row handlers share.
 */
export function selectTape(id: string): void {
  useSelectionStore.getState().select(id)
}
