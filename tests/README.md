# TapeBox's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite, minus `live/`: at a few seconds it is already a
fixed, balanced run, so nothing selects a subset of it. `npm run test:full` adds `live/`, which
downloads through the real `yt-dlp`, `ffmpeg` and `deno` and asks OpenAI for a file name.

This file is the balance judgement the `tests-folder-conventions` require — which areas TapeBox has,
and which tests stand for each — so a reader can tell what a green run covered, and an area with no
test standing for it is visible rather than merely absent. `tests/area-map.test.ts` holds every path
below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| Downloading | Building the `yt-dlp` invocation, scheduling the job, and what a failed download leaves behind | `main/services/ytdlp-args.test.ts`, `main/queue/job.test.ts`, `main/queue/schedule.test.ts`, `renderer/lib/downloadFailure.test.ts` |
| Managed binaries | Acquiring `yt-dlp`, `ffmpeg` and `deno`, and proving what was acquired | `main/binaries/manager.test.ts`, `main/binaries/registry.test.ts`, `main/binaries/registry-integrity.test.ts`, `main/binaries/integrity.test.ts`, `main/binaries/archive.test.ts`, `main/binaries/http.test.ts`, `main/binaries/arch.test.ts`, `main/binaries/installed-version.test.ts`, `shared/binary-status.test.ts`, `shared/dependencies.test.ts`, `main/store/dependencies.test.ts`, `renderer/store/binaries.test.ts`, `renderer/components/BinariesModal.test.ts` |
| The library store | Tapes, boxes, shelving, moving, and importing existing files | `main/store/session.test.ts`, `main/store/library-move.test.ts`, `main/ipc/library-import.test.ts`, `main/ipc/library-import-rollback.test.ts`, `main/ipc/library-shelving.test.ts`, `main/ipc/boxes.test.ts`, `main/ipc/box-membership.test.ts`, `main/core/import-classify.test.ts`, `main/core/import-selection.test.ts` |
| Naming, renaming, and export | The rename and export plans, case collisions, and rolling an export back | `main/core/rename-plan.test.ts`, `main/core/export-plan.test.ts`, `main/core/filename.test.ts`, `main/ipc/library-rename.test.ts`, `main/ipc/case-collision.test.ts`, `main/ipc/export-rollback.test.ts` |
| Metadata and AI file names | The sidecar metadata a tape carries, and the name the model suggests for it | `main/ipc/library-metadata.test.ts`, `main/services/ai-client.test.ts`, `main/services/api-keys.test.ts` |
| Playback and the viewer | Serving media to the window, chapters, and opening a tape outside the app | `main/media-server.test.ts`, `renderer/lib/currentChapter.test.ts`, `main/ipc/library-open-externally.test.ts`, `renderer/lib/tapeSourceActions.test.ts`, `renderer/lib/useCopyTapeSourceUrl.test.ts` |
| The IPC boundary | The calls the renderer makes, their schemas, and how a failure comes back | `main/ipc/handle.test.ts`, `main/ipc/schemas.test.ts`, `renderer/ipc/sync.test.ts`, `shared/error.test.ts`, `renderer/RendererErrorBoundary.test.tsx`, `renderer/lib/tapeActionsFailures.test.ts`, `renderer/store/tapeActionResults.test.ts` |
| Settings and persisted state | Saved settings, their backups, and recovery from a corrupt file | `main/ipc/settings.test.ts`, `shared/settings.test.ts`, `main/store/config.test.ts`, `main/store/config-corrupt-e2e.test.ts`, `main/store/config-quarantine.test.ts`, `main/store/backupStore.test.ts`, `renderer/store/persistenceFailures.test.ts` |
| Files on disk | Atomic writes, storage paths, and the temporary area | `main/io/atomic-file.test.ts`, `main/io/atomic-json.test.ts`, `main/paths.test.ts`, `main/reset-temp-dir.test.ts` |
| Logging and redaction | The session log, its format, and the secrets kept out of it | `main/io/logger.test.ts`, `main/io/log-format.test.ts`, `main/io/redact.test.ts`, `shared/log.test.ts`, `main/store/session-terminal.test.ts` |
| Subprocesses | Starting and ending the processes the app owns | `main/io/spawn.test.ts`, `main/io/fetch-json.test.ts`, `main/terminal-startup-failure.test.ts` |
| Startup and dialogs | Opening the app, and the dialogs that block it | `main/startup-dialog.test.ts`, `main/plain-message-dialog.test.ts`, `main/plain-message-dialog-settlement.test.ts`, `renderer/index.test.ts` |
| Window, theme, and styling | Window bounds and minimums, activity, light and dark, and the stylesheet | `main/window-options.test.ts`, `main/window-minimum.test.ts`, `main/window-state-recovery.test.ts`, `main/window-activity.test.ts`, `renderer/lib/windowActivity.test.ts`, `main/theme.test.ts`, `renderer/theme-contrast.test.ts`, `renderer/styles.test.ts`, `shared/layout.test.ts`, `renderer/lib/useUiFont.test.ts`, `renderer/lib/usePaneSize.test.ts` |
| Renderer interaction | Ordering, dragging, keyboard navigation, scrolling, and the modals | `renderer/lib/tapeOrder.test.ts`, `renderer/lib/optimisticOrder.test.ts`, `renderer/store/orderFailures.test.ts`, `shared/order.test.ts`, `renderer/lib/dnd.test.ts`, `renderer/lib/externalDrop.test.ts`, `renderer/components/TapeImportReceiver.test.tsx`, `renderer/lib/useImportMedia.test.tsx`, `renderer/lib/useListboxKeyboard.test.ts`, `renderer/lib/nextIndex.test.ts`, `renderer/lib/focusTrap.test.ts`, `renderer/lib/scrollLock.test.ts`, `renderer/lib/passiveScroll.test.ts`, `renderer/lib/useComposing.test.ts`, `renderer/components/Modal.test.ts`, `renderer/components/Menu.test.ts`, `renderer/components/TopBar.test.tsx`, `renderer/components/Toaster.test.tsx`, `renderer/components/AboutModal.test.tsx`, `renderer/components/ScanPageModal.test.ts`, `renderer/components/ResizeHandle.test.ts` |
| The domain model | What a tape is, and the URLs the app will accept | `shared/domain.test.ts`, `shared/url.test.ts` |
| Packaging and launchers | What ships, how it is built, the launchers, and the release tag | `config/electron-vite.test.ts`, `config/launcher-runtime.test.ts`, `main/installer-config.test.ts`, `release-tag.test.ts` |
