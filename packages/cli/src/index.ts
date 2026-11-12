import { loginCommand } from './commands/login.js';
import { listCommand } from './commands/list.js';
import { downloadCommand } from './commands/download.js';
import { transcriptCommand } from './commands/transcript.js';
import { syncCommand } from './commands/sync.js';
import { archiveCommand } from './commands/archive.js';
import { tokenStatusCommand } from './commands/token-status.js';

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: loginCommand,
  list: listCommand,
  download: downloadCommand,
  transcript: transcriptCommand,
  sync: syncCommand,
  archive: archiveCommand,
  'token-status': tokenStatusCommand,
};

export async function run(args: string[]): Promise<void> {
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args.slice(1));
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: plaud <command> [options]

Commands:
  login [--email E] [--region us|eu]
                        Log in via email verification code. Prompts for
                          email/region when not given as flags.
  login --token [TOKEN] Log in with a token from app.plaud.ai (for
                          Google/Apple sign-in accounts). Token may be passed
                          as an arg, via PLAUD_TOKEN, or piped on stdin.
  list                  List recordings
  download <id> [dir]   Download audio file
  transcript <id>       Print transcript
  sync <folder>         Download all new recordings to folder
  archive [options]     Transcribe (with speakers) + summarize new recordings.
                          Diarizes via ElevenLabs (default) and summarizes with an
                          auto-selected local template. Needs OPENAI_API_KEY plus
                          ELEVENLABS_API_KEY (or --transcriber whisper).
                          Options: --dry-run --limit N --id <id[,id2]> --force
                                   --seed-existing --verbose --speakers N --archive-audio-only
                                   --min-duration <sec> --transcriber elevenlabs|whisper
                                   --vault <dir> --audio-dir <dir> --templates <dir>
                                   --audio-archive-dir <dir>
  token-status [options] Show when the token expires. Exit code: 0 ok,
                          1 expires within --warn-days (default 3), 2 missing,
                          expired or (with --verify) rejected by Plaud.
                          Options: --warn-days N --verify`);
}
