# plaud

> **Alpha** — Early test version. Building in public, testing on my own recordings.

Unofficial TypeScript toolkit for the [Plaud](https://www.plaud.ai/) API — core library, CLI, and MCP server.

## Why

[Plaud](https://www.plaud.ai/) makes AI-powered wearable recorders (Plaud Note, Plaud NotePin) that capture meetings, conversations, and voice notes, then transcribe and summarize them in the cloud. Great hardware, but all your data lives behind their app with no official API or export tools.

This toolkit gives you programmatic access to your own recordings. Download audio files, pull transcripts, sync everything to local folders — your data, your workflow. Built as a monorepo with three packages:

- **`@plaud/core`** — Shared library: authentication, API client, config management. Tokens last ~300 days; when a token expires you re-run `plaud login` (the password is never written to disk).
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

Enter your email, region (us/eu), and password (input is masked). On success, your email, region, and the access token (JWT) are written to `~/.plaud/config.json` (mode 0600). **Your password is never persisted** — it lives in memory only for the duration of the login call.

> **Note:** If you use Google Sign-In on Plaud, first set a password via "Forgot Password" on [web.plaud.ai](https://web.plaud.ai).

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

## Token Management

Tokens last ~300 days. Because the password is never persisted, there is no silent auto-refresh — when your token enters its last 30 days, any CLI command will exit with `Error: Token has expired or is expiring soon. Run \`plaud login\` to refresh.` Run `plaud login` again to mint a fresh token. (This is a deliberate trade-off vs. the upstream behavior, which kept the password on disk to enable silent refresh.)

## API

The API was reverse-engineered from the Plaud web app. This is an unofficial project — not affiliated with or endorsed by Plaud.

## License

MIT
