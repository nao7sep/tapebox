# TapeBox

A local video library — download videos with `yt-dlp`, keep them as tapes, and watch, rename, and organize them offline.

TapeBox is a cross-platform desktop app (macOS, Windows, Linux) that downloads videos from the web and gives them a tidy home on your own machine. It's a thin wrapper around [`yt-dlp`](https://github.com/yt-dlp/yt-dlp): it does nothing `yt-dlp` doesn't already do — it just keeps the files, their posters, and their metadata together and easy to browse. No account, no cloud; everything stays under `~/.tapebox`.

It is deliberately a *collection*, not a media player on steroids: there's no repeat or auto-play-next, because the goal is a calm shelf of tapes rather than an endless feed.

## Features

- **Download by URL** — paste a link to download video+audio (merged) via `yt-dlp`, with a sidecar `info.json` saved beside each file. Add many URLs at once, with configurable concurrency.
- **Scan a page** — paste a page that lists videos (a creator, a search, a category) and review the entries before choosing which to pull in.
- **Inbox & Archive** — newly added tapes land at the top of the Inbox; archive the ones you want to keep into named **boxes** (or leave them **Unboxed**). Drag any tape to reorder it, and search across the whole archive.
- **Built-in player** — watch tapes with seeking and chapter navigation; while a tape plays, TapeBox can hold a system wake lock so the screen won't dim and the machine won't sleep mid-watch.
- **Rename** — give a tape any filesystem-safe name (Unicode-friendly), optionally suggested by an AI model from its title/uploader/description. The video, poster, and sidecar are renamed together — and the file rename happens without interrupting playback.
- **Refresh metadata** — re-probe a tape's source and review current-vs-new side by side before applying, so a re-probe can never silently overwrite good data with worse.
- **Export** — copy a tape's files (video, poster, sidecar) to a folder of your choice, optionally renamed, and optionally removing it from the library at the same time. No transcoding — the files leave exactly as they came in.
- **Re-import** — drop a previously exported `.json` sidecar back onto the window; TapeBox reads the video and poster names from it and brings the whole bundle back in.
- **Managed binaries** — `yt-dlp`, `ffmpeg`, and `deno` are downloaded and updated by the app into `~/.tapebox/bin`; nothing to install by hand.
- **Custom `yt-dlp` args** — pass your own flags globally or per matching site profile (e.g. an `Accept-Language` header for titles in another language); the app's own flags always win on conflict.
- **Keyboard-driven** — navigate, archive, rename, export, and remove without leaving the keys (see [Keyboard shortcuts](#keyboard-shortcuts)).

## Requirements

- Node.js and npm
- macOS, Windows, or Linux

`yt-dlp`, `ffmpeg`, and `deno` are **not** prerequisites — TapeBox downloads and manages them itself on first run.

## Getting started

```bash
npm install
npm run dev
```

Or use the convenience launchers, which install dependencies and start the app:

- macOS / Linux: `scripts/run.command`
- Windows: `scripts/run.ps1`

## Usage

1. **Add a tape.** Paste a video URL into the input and press Enter. It appears at the top of the Inbox and starts downloading (auto-start is on by default). For a page that lists many videos, use **Scan page** and pick the ones you want.
2. **Watch it.** Select a downloaded tape to play it in the right pane; chapters (if any) appear alongside.
3. **Tidy it.** Rename it to something memorable, refresh its metadata if the source has changed, then **Archive** it into a box once you're done with it.
4. **Get it out.** **Export** copies the video, poster, and sidecar to any folder — re-importable later by dropping the sidecar back in.

## Keyboard shortcuts

Press <kbd>?</kbd> in the app for the full list. The main ones:

| Keys | Action |
| --- | --- |
| Up / Down | Move selection in the active list — videos, chapters, or boxes |
| Left / Right | Seek the player back / forward |
| Cmd/Ctrl + 1 / 2 | Inbox / Archived |
| Slash | Search the archive |
| Enter | Selected tape's main action (play/pause, scan, retry, resume) |
| M | Refresh metadata |
| R | Rename |
| E | Export |
| A | Archive / unarchive |
| Backspace / Delete | Move to Trash |
| ? | Show the shortcuts list |
| Esc | Close a dialog |

Each list — the videos, the chapters, the boxes — is a single tab stop you enter with <kbd>Tab</kbd> and leave with <kbd>Tab</kbd>; the arrow keys move within it. Arrow keys act on whichever list you last entered, by clicking it *or* by tabbing into it (the chapters' Up/Down jumps the player between them). The Inbox/Archived filter and the Settings sections are likewise arrow-navigable groups, and menus open from their button, navigate with Up/Down, and close on <kbd>Esc</kbd> back to that button. Left/Right seek the open player from anywhere. When the video element itself is focused, <kbd>Space</kbd> toggles play/pause.

## Configuration

Settings (in-app) cover download concurrency and auto-start, playback (autoplay, sound, keep-awake), removal behavior (move to Trash vs. delete, confirm-before-remove), automatic binary update checks, a default export folder, custom `yt-dlp` arguments and per-site profiles, and an external player for "Open in player".

AI rename suggestions target a single OpenAI-compatible endpoint (base URL + model) you configure in Settings. The request is kept intentionally minimal so it works across providers; all guidance lives in an editable prompt. The API key is stored locally and only sent to your configured endpoint when you ask for a suggestion.

## Where your data lives

Everything TapeBox creates lives under `~/.tapebox`:

```
~/.tapebox/
  bin/            managed yt-dlp / ffmpeg / deno executables
  library/        downloaded media + sidecar JSON + poster thumbnails (.jpg)
  logs/           per-launch JSON-Lines logs (kept indefinitely, never pruned)
  work/           scratch space for in-progress downloads
  config.json     settings (self-heals to defaults if missing or invalid)
  session.json    library + boxes (load fails loud — never silently reset)
  layout.json     window/pane sizes (disposable; self-heals)
  api-keys.json   AI API key, lightly obfuscated (see Privacy)
```

Only TapeBox's own state lives here. Electron/Chromium internals (cache, cookies) stay in the OS-default location and never mix in.

## Privacy & network

TapeBox is local-first and has no analytics or telemetry. It reaches the internet only when:

- you download or scan (via `yt-dlp`), or refresh a tape's metadata;
- it checks GitHub for newer `yt-dlp`/`ffmpeg`/`deno` versions (once per launch, throttled — toggleable in Settings);
- you request an AI rename suggestion (to your configured endpoint).

Just watching or organizing never touches the network.

⚠️ The AI key in `api-keys.json` is **lightly obfuscated, not encrypted** (`obf:` + base64 of the reversed key) — enough to keep it out of plain sight during casual file browsing, but trivially reversible. If you back up or share `~/.tapebox`, treat that file (and any tokens you put in custom `yt-dlp` args) as sensitive.

## Building & packaging

```bash
npm run pack:mac     # unpacked macOS app
npm run pack:win     # unpacked Windows app
npm run pack:linux   # unpacked Linux app
```

Each runs `electron-vite build` then `electron-builder --dir`.

## Development

| Command | Description |
| --- | --- |
| `npm run dev` | Start in development mode (electron-vite) |
| `npm run build` | Build main, preload, and renderer bundles |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Type-check all environments (node + web + tests) |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

**Architecture.** TapeBox is split across the three Electron contexts, each built separately by electron-vite:

- **Main** (`src/main`, ESM) — all I/O: the download queue, `yt-dlp`/`ffmpeg` subprocesses, binary management, atomic JSON persistence, logging, API-key storage, and a loopback HTTP server that streams library files to the player.
- **Preload** (`src/preload`, CommonJS) — exposes a typed IPC client to the renderer over the context bridge.
- **Renderer** (`src/renderer`, React 19 + Tailwind v4 + Zustand) — the UI.

Shared code in `src/shared` keeps the contexts honest: `ipc-contract.ts` is the single source of truth for every IPC channel and event (main and renderer both derive their types from it), and Zod schemas (`domain.ts`, `settings.ts`, `layout.ts`) validate everything read from or written to disk. Path aliases `@main/*`, `@renderer/*`, and `@shared/*` map to the matching `src` directories.

`npm run typecheck` is split per environment so cross-context mistakes fail statically: a main-process file reaching for a browser global, or a renderer file reaching for a Node global, won't pass. Tests live in a `tests/` tree mirroring `src/`, kept out of the shipped build but type-checked by their own config.

## License

MIT © Yoshinao Inoguchi — see [LICENSE](LICENSE).
