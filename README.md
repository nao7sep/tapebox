# TapeBox

TapeBox is a local media library: download videos with `yt-dlp`, keep them as **tapes**, and watch, rename, and organize them offline. It's a thin wrapper around `yt-dlp` — it does nothing yt-dlp can't, it just keeps each video, its poster, and its metadata together and easy to browse, all under `~/.tapebox` with no account and no cloud. It's deliberately a calm *collection* rather than a feed: no autoplay-next, no repeat. A desktop app for macOS and Windows (also runnable from source on Linux), built on Electron; it downloads and manages `yt-dlp`, `ffmpeg`, and `deno` for you.

## Features

- **Download by URL** — paste a link to grab merged video+audio with a sidecar `info.json`; add many at once with configurable concurrency
- **Scan a page** — review the videos a page lists before pulling them in
- **Inbox & Archive** — new tapes land in the Inbox; archive keepers into named boxes, reorder by drag, and search the whole library
- **Built-in player** — seeking, chapter navigation, and a wake lock so the screen won't sleep mid-watch
- **Rename / refresh / export / re-import** — rename a tape and its files together, re-probe metadata with a before/after review, export the bundle to any folder, and bring it back later from its sidecar
- **Managed tools** — `yt-dlp` and `ffmpeg` are required; Deno is optional and helps yt-dlp with sites that need a JavaScript runtime. Installation and updates are explicit and checksum-verified. Expect a few hundred MB of downloads in total and allow about 1 GB of free space during installation. `yt-dlp` and Deno come from their official releases; `ffmpeg` comes from the accepted third-party builders martin-riedl.de on macOS arm64 and BtbN on Windows
- **Custom `yt-dlp` args** — pass your own flags globally or per site profile

## Requirements

- macOS or Windows (Linux runs from source)
- On Linux, install `ffmpeg` yourself at `~/.tapebox/bin/ffmpeg` (auto-install is macOS/Windows only)
- Node.js and npm — only to build or run from source

## Download

Prebuilt installers and portable builds for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/tapebox/releases/latest) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/TapeBox.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Run from source

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS/Linux, `scripts/run-dev.ps1` on Windows), or run it by hand:

```bash
npm install
npm run dev
```

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
