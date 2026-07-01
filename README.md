# TapeBox

TapeBox is a local media library: download videos with `yt-dlp`, keep them as **tapes**, and watch, rename, and organize them offline. It's a thin wrapper around `yt-dlp` — it does nothing yt-dlp can't, it just keeps each video, its poster, and its metadata together and easy to browse, all under `~/.tapebox` with no account and no cloud. It's deliberately a calm *collection* rather than a feed: no autoplay-next, no repeat. A desktop app for macOS and Windows (also runnable from source on Linux), built on Electron; it downloads and manages `yt-dlp`, `ffmpeg`, and `deno` for you.

## Features

- **Download by URL** — paste a link to grab merged video+audio with a sidecar `info.json`; add many at once with configurable concurrency
- **Scan a page** — review the videos a page lists before pulling them in
- **Inbox & Archive** — new tapes land in the Inbox; archive keepers into named boxes, reorder by drag, and search the whole library
- **Built-in player** — seeking, chapter navigation, and a wake lock so the screen won't sleep mid-watch
- **Rename / refresh / export / re-import** — rename a tape and its files together, re-probe metadata with a before/after review, export the bundle to any folder, and bring it back later from its sidecar
- **Managed binaries** — `yt-dlp`, `ffmpeg`, and `deno` are downloaded and checksum-verified for you, kept in `~/.tapebox/bin` (`yt-dlp` and `deno` from their official GitHub releases; `ffmpeg` from the third-party native builds at martin-riedl.de on macOS arm64 and BtbN on Windows). Nothing is swapped silently: a missing tool opens the tools window on first run so you can install it, and you install or update from there — one toggle controls whether TapeBox checks for newer releases at launch (except `ffmpeg` on Linux, which you install yourself)
- **Custom `yt-dlp` args** — pass your own flags globally or per site profile

## Requirements

- Node.js and npm
- macOS or Windows (Linux runs from source)
- On Linux, install `ffmpeg` yourself at `~/.tapebox/bin/ffmpeg` (auto-install is macOS/Windows only)

## Download

Prebuilt installers and portable builds for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/tapebox/releases) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/TapeBox.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Getting started

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS/Linux, `scripts/run-dev.ps1` on Windows), or run from source:

```bash
npm install
npm run dev
```

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
