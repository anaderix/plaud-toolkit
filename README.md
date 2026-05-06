# plaud

> **Alpha** — Early test version. Building in public, testing on my own recordings.

Unofficial TypeScript toolkit for the [Plaud](https://www.plaud.ai/) API — core library, CLI, and MCP server.

## Why

[Plaud](https://www.plaud.ai/) makes AI-powered wearable recorders (Plaud Note, Plaud NotePin) that capture meetings, conversations, and voice notes, then transcribe and summarize them in the cloud. Great hardware, but all your data lives behind their app with no official API or export tools.

This toolkit gives you programmatic access to your own recordings. Download audio files, pull transcripts, sync everything to local folders — your data, your workflow. Built as a monorepo with three packages:

- **`@plaud/core`** — Shared library: authentication (via email OTP), API client, config management. Tokens last ~300 days; when a token expires you re-run `plaud login`.
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

## Token Management

Tokens last ~300 days. There is no silent auto-refresh — when your token enters its last 30 days, any CLI command will exit with `Error: Token has expired or is expiring soon. Run \`plaud login\` to refresh.` Run `plaud login` again to mint a fresh token (Plaud emails a new OTP each time).

## API

The API was reverse-engineered from the Plaud web app. This is an unofficial project — not affiliated with or endorsed by Plaud.

## License

MIT
