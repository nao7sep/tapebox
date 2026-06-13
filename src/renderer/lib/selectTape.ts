import { useSelectionStore } from '@renderer/store/selection'
import { useNavStore } from '@renderer/store/nav'

/**
 * Select a tape and make the video list the active keyboard panel in one step.
 * Used wherever a tape row is clicked (inbox, archive box, search results) so that
 * clicking a video always routes Up/Down back to the video list — including a
 * re-click of the already-selected tape, which a "selection changed" effect alone
 * would miss.
 */
export function selectTape(id: string): void {
  useSelectionStore.getState().select(id)
  useNavStore.getState().setActivePanel('tapes')
}
