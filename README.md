# TapeBox

TapeBox is a local media library: download videos with `yt-dlp`, keep them as **tapes**, and watch, rename, and organize them offline. It's a thin wrapper around `yt-dlp` — it does nothing yt-dlp can't, it just keeps each video, its poster, and its metadata together and easy to browse, all under `~/.tapebox` with no account and no cloud. It's deliberately a calm *collection* rather than a feed: no autoplay-next, no repeat. Cross-platform desktop app (macOS, Windows, Linux) built on Electron; it downloads and manages `yt-dlp`, `ffmpeg`, and `deno` for you.

## Features

- **Download by URL** — paste a link to grab merged video+audio with a sidecar `info.json`; add many at once with configurable concurrency
- **Scan a page** — review the videos a page lists before pulling them in
- **Inbox & Archive** — new tapes land in the Inbox; archive keepers into named boxes, reorder by drag, and search the whole library
- **Built-in player** — seeking, chapter navigation, and a wake lock so the screen won't sleep mid-watch
- **Rename / refresh / export / re-import** — rename a tape and its files together, re-probe metadata with a before/after review, export the bundle to any folder, and bring it back later from its sidecar
- **Managed binaries** — `yt-dlp`, `ffmpeg`, and `deno` are downloaded and updated automatically (except `ffmpeg` on Linux, which you install yourself)
- **Custom `yt-dlp` args** — pass your own flags globally or per site profile

## Requirements

- Node.js and npm
- macOS, Windows, or Linux
- On Linux, install `ffmpeg` yourself at `~/.tapebox/bin/ffmpeg` (auto-install is macOS/Windows only)

## Getting started

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS/Linux, `scripts/run-dev.ps1` on Windows), or run from source:

```bash
npm install
npm run dev
```

## Privacy

TapeBox is local-first with no analytics or telemetry; it reaches the network only to download/scan, to check for binary updates, or for an AI rename suggestion. The AI key in `~/.tapebox/api-keys.json` is lightly obfuscated, **not encrypted** — treat it as sensitive if you share `~/.tapebox`.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
