# plaud

> **Alpha** — Early test version. Building in public, testing on my own recordings.

Unofficial TypeScript toolkit for the [Plaud](https://www.plaud.ai/) API — core library, CLI, and MCP server.

## Why

[Plaud](https://www.plaud.ai/) makes AI-powered wearable recorders (Plaud Note, Plaud NotePin) that capture meetings, conversations, and voice notes, then transcribe and summarize them in the cloud. Great hardware, but all your data lives behind their app with no official API or export tools.

This toolkit gives you programmatic access to your own recordings. Download audio files, pull transcripts, sync everything to local folders — your data, your workflow. Built as a monorepo with three packages:

- **`@plaud/core`** — Shared library: authentication (via email OTP), API client, config management. Tokens last ~30 days; when a token expires you re-run `plaud login`.
- **`@plaud/cli`** — Command-line tool to list, download, transcribe, and sync recordings.
- **`@plaud/mcp`** — [MCP server](https://modelcontextprotocol.io/) that exposes your Plaud recordings to AI assistants like Claude, making your voice notes searchable and accessible from any MCP-compatible tool.

## Setup

```bash
git clone https://github.com/sergivalverde/plaud.git
cd plaud && npm install
```

### 1. Login

```bash
npx tsx packages/cli/bin/plaud.ts login
```

Enter your email and region (us/eu). Plaud emails you a one-time code; type it at the prompt. On success, your email, region, and the access token (JWT) are written to `~/.plaud/config.json` (mode 0600). **Your password is never used or stored** — login is via email-OTP only, which works regardless of whether you signed up with email/password, Google, or Apple, and regardless of whether MFA is enabled on your account.

### 2. CLI Usage

```bash
# List recordings
npx tsx packages/cli/bin/plaud.ts list

# Get transcript
npx tsx packages/cli/bin/plaud.ts transcript <recording-id>

# Download audio
npx tsx packages/cli/bin/plaud.ts download <recording-id> ./audio/

# Sync all recordings to a folder
npx tsx packages/cli/bin/plaud.ts sync ./plaud-notes/
```

### 3. MCP Server

Add to your Claude config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "plaud": {
      "command": "npx",
      "args": ["tsx", "/path/to/plaud/packages/mcp/src/index.ts"]
    }
  }
}
```

Tools available:
- `plaud_list_recordings` — list all recordings
- `plaud_get_transcript` — get transcript by recording ID
- `plaud_get_recording_detail` — full recording metadata
- `plaud_user_info` — account info
- `plaud_get_mp3_url` — temporary MP3 download URL

## Meeting archive (`plaud archive`)

Turns **new** Plaud recordings into a vault of transcripts + summaries. Plaud is used only as the audio source — transcription (**with speaker diarization**) is done by **ElevenLabs Scribe**, and summaries by the **OpenAI API** using a locally-stored markdown template that is auto-selected from the inferred meeting type. Designed to be run daily from your own cron.

Per recording it writes `<root>/YYYY-MM-DD-topic/transcript.md` + `summary.md`; audio goes to a separate `audioDir`. State is tracked per recording id in `<audioDir>/.plaud-archive-state.json` (kept with the durable audio files, not in the vault), so re-runs only process new recordings and resume partial ones (a paid transcript is never re-fetched after a later failure).

### Transcription engine (speakers)
Two selectable transcribers (config `transcriber` or `--transcriber`):
- **`elevenlabs`** (default) — ElevenLabs Scribe with `diarize=true`. Transcripts are speaker-labeled (`**Speaker 1:** …`) and summaries can attribute who said what. Takes the whole file (no ffmpeg chunking) and uses the original audio for best diarization. Optional `--speakers N` / `numSpeakers` hints the speaker count. Needs `ELEVENLABS_API_KEY`.
- **`whisper`** — OpenAI Whisper, no speaker labels. Falls back to the ffmpeg compress/split path for its 25 MB limit.

Labels are anonymous (`Speaker 1/2/3`); the summarizer can still attribute turns.

### Prerequisites
- `OPENAI_API_KEY` (classify + summarize; `OPENAI_BASE_URL` optional).
- `ELEVENLABS_API_KEY` (default `elevenlabs` transcriber; not needed with `--transcriber whisper`).
- Keys can be exported or placed in `.env` — `plaud archive` auto-loads `.env` from the current directory and `~/.plaud/.env`. A real exported env var always wins over `.env`. (`.env` is gitignored.)
- `ffmpeg` + `ffprobe` on PATH — only used by the `whisper` transcriber (compress/split over 25 MB).

### Config — `~/.plaud/archive.json` (all optional)
```json
{
  "vaultRoot": "~/vault/2-Area/Meetings",
  "audioDir": "../audio",
  "templatesDir": null,
  "transcriber": "elevenlabs",
  "elevenLabsModel": "scribe_v2",
  "numSpeakers": null,
  "minDurationSec": 0,
  "models": { "transcribe": "whisper-1", "classify": "gpt-4o-mini", "summarize": "gpt-4o" },
  "audio": { "maxBytes": 24000000, "targetBitrateKbps": 32, "chunkSeconds": 1200 },
  "transcriptLanguage": null
}
```
`minDurationSec` skips recordings shorter than N seconds (0 = process all; e.g. `300` skips clips under 5 min). A named `--id` always overrides it, so you can still process a short one on demand (also `--min-duration <sec>`).
`audioArchiveDir` (or `--audio-archive-dir`) moves each recording's audio there once it is fully transcribed **and** summarized — e.g. `/mnt/gdrive/plaud-audio` on an rclone Google Drive mount — so the local disk only holds work in progress. `null` keeps audio in `audioDir`. The move is skipped unless the target holds a `.plaud-audio-archive` marker file (`make audio-archive-init`), which keeps a dropped mount from silently filling the local disk. Audio is looked up in both directories, so `--force` re-transcribes from the archived copy instead of re-downloading. With `--vfs-cache-mode full`, rclone reports the write as done and uploads in the background; the data is in rclone's on-disk cache until then. To move audio you already have, prefer `make audio-migrate` (`rclone move`, checksum-verified, bypasses the mount) — the next archive run reconciles the state without touching Drive.

`templatesDir: null` uses the packaged starters (`standup`, `lecture`, `meeting`, `one-on-one`, `negotiation`, `generic`). A template is a markdown file with YAML frontmatter (`name`, `when_to_use`) + a prompt body containing `{{transcript}}`; the classifier picks the best match by `when_to_use`. For cron, prefer **absolute** paths.

### Bootstrap (avoid a surprise bulk re-transcribe)
```bash
plaud archive --dry-run              # show what WOULD run + cost estimate; writes nothing
plaud archive --seed-existing        # register already-downloaded audio as "downloaded" (no API calls)
plaud archive --limit 1              # process one end-to-end; inspect output + cost
plaud archive                        # process all new recordings
```
Flags: `--dry-run --limit N --id <recId> --force --seed-existing --verbose --vault <dir> --audio-dir <dir> --templates <dir>`.

### Daily cron
```
0 7 * * * cd /path/to/plaud && OPENAI_API_KEY=sk-... npx tsx packages/cli/bin/plaud.ts archive >> ~/.plaud/archive.log 2>&1
```
If the Plaud token has expired the run exits nonzero with a `plaud login --token` hint in the log; re-auth and the next run resumes where it left off.

Audio of finished recordings is moved to `audioArchiveDir` at the end of every run; `plaud archive --archive-audio-only` does just that step (no Plaud or LLM calls, so it works with an expired token).

`make cron` prints ready-to-paste crontab lines: hourly `make archive`, plus a daily 09:00 `make token-check` that emails `EMAIL_TO` (via `mutt`) when the token has fewer than `WARN_DAYS` (default 3) days left, has expired, or is rejected by Plaud.

## Token Management

OTP logins (`plaud login`) mint a token that lasts ~30 days; `plaud login` prints the exact expiry, and `plaud archive` logs a warning once fewer than 3 days remain. `plaud token-status [--verify] [--warn-days N]` reports it on demand (exit code 0 ok, 1 expiring, 2 missing/expired/rejected). Accounts created via **Google/Apple sign-in** can't be reached by OTP — use `plaud login --token` and paste the bearer token from your `app.plaud.ai` browser session (the `pld_ut` cookie); those web tokens are short-lived (~24h). When a token expires, any command exits with `Error: Token has expired or is expiring soon.` — re-run the appropriate `plaud login` to refresh.

## API

The API was reverse-engineered from the Plaud web app. This is an unofficial project — not affiliated with or endorsed by Plaud.

## License

MIT
