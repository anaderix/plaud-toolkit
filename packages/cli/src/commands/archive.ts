import { PlaudConfig, PlaudAuth, PlaudClient, tokenExpiryWarning } from '@plaud/core';
import { loadArchiveConfig } from '../archive/config.js';
import { runArchive, ArchiveOptions } from '../archive/pipeline.js';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return undefined;
}

/** Collect all values for a repeatable flag, also splitting comma-separated lists. */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('--')) {
      out.push(...args[i + 1].split(',').map(s => s.trim()).filter(Boolean));
    }
  }
  return out;
}

export async function archiveCommand(args: string[]): Promise<void> {
  const transcriberFlag = flagValue(args, '--transcriber');
  if (transcriberFlag && transcriberFlag !== 'elevenlabs' && transcriberFlag !== 'whisper') {
    throw new Error(`--transcriber must be 'elevenlabs' or 'whisper' (got '${transcriberFlag}')`);
  }
  const speakersRaw = flagValue(args, '--speakers');
  const minDurRaw = flagValue(args, '--min-duration');

  const config = loadArchiveConfig({
    vault: flagValue(args, '--vault'),
    audioDir: flagValue(args, '--audio-dir'),
    templates: flagValue(args, '--templates'),
    transcriber: transcriberFlag as 'elevenlabs' | 'whisper' | undefined,
    numSpeakers: speakersRaw ? parseInt(speakersRaw, 10) : undefined,
    minDurationSec: minDurRaw ? parseInt(minDurRaw, 10) : undefined,
  });

  const limitRaw = flagValue(args, '--limit');
  const opts: ArchiveOptions = {
    dryRun: args.includes('--dry-run'),
    limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    ids: flagValues(args, '--id'),
    force: args.includes('--force'),
    seedExisting: args.includes('--seed-existing'),
    verbose: args.includes('--verbose'),
  };

  const plaudConfig = new PlaudConfig();
  const token = plaudConfig.getToken();
  const warning = token && tokenExpiryWarning(token.expiresAt);
  if (warning) console.warn(warning);
  const creds = plaudConfig.getCredentials();
  const auth = new PlaudAuth(plaudConfig);
  const client = new PlaudClient(auth, creds?.apiBase ?? creds?.region ?? 'us');

  await runArchive(client, config, opts);
}
