import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const CONFIG_PATH = path.join(os.homedir(), '.plaud', 'archive.json');

/** Packaged starter templates live at packages/cli/templates/. */
const PACKAGED_TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
);

const ArchiveConfigSchema = z.object({
  vaultRoot: z.string().default('~/vault/2-Area/Meetings'),
  audioDir: z.string().default('../audio'),
  templatesDir: z.string().nullable().default(null),
  models: z
    .object({
      transcribe: z.string().default('whisper-1'),
      classify: z.string().default('gpt-4o-mini'),
      summarize: z.string().default('gpt-4o'),
    })
    .default({ transcribe: 'whisper-1', classify: 'gpt-4o-mini', summarize: 'gpt-4o' }),
  audio: z
    .object({
      maxBytes: z.number().int().positive().default(24_000_000),
      targetBitrateKbps: z.number().int().positive().default(32),
      chunkSeconds: z.number().int().positive().default(1200),
    })
    .default({ maxBytes: 24_000_000, targetBitrateKbps: 32, chunkSeconds: 1200 }),
  transcriptLanguage: z.string().nullable().default(null),
  // Transcription engine: 'elevenlabs' (diarizing, default) or 'whisper' (no speakers).
  transcriber: z.enum(['elevenlabs', 'whisper']).default('elevenlabs'),
  elevenLabsModel: z.string().default('scribe_v2'),
  numSpeakers: z.number().int().positive().nullable().default(null),
  // Skip recordings shorter than this many seconds (0 = process all).
  // An explicit --id overrides this so you can still process a short one.
  minDurationSec: z.number().int().nonnegative().default(0),
});

export type ArchiveFileConfig = z.infer<typeof ArchiveConfigSchema>;

export interface ArchiveFlags {
  vault?: string;
  audioDir?: string;
  templates?: string;
  transcriber?: 'elevenlabs' | 'whisper';
  numSpeakers?: number;
  minDurationSec?: number;
}

export interface ResolvedConfig {
  vaultRoot: string;
  audioDir: string;
  templatesDir: string;
  models: ArchiveFileConfig['models'];
  audio: ArchiveFileConfig['audio'];
  transcriptLanguage: string | null;
  transcriber: 'elevenlabs' | 'whisper';
  elevenLabsModel: string;
  numSpeakers: number | null;
  minDurationSec: number;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  elevenLabsApiKey: string;
}

/** Expand a leading `~` and resolve to an absolute path (relative paths against cwd). */
export function expandPath(p: string): string {
  let out = p;
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  return path.resolve(out);
}

/**
 * Minimal .env loader (no dependency). Reads KEY=VALUE lines from the given
 * file and sets them in process.env ONLY if not already set, so a real
 * exported env var always wins. Supports `export ` prefix, # comments, and
 * single/double quotes.
 */
function loadEnvFile(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim(); // strip trailing inline comment for unquoted values
    }
    process.env[key] = val;
  }
}

/** Load .env from cwd and ~/.plaud/.env (cwd takes precedence; neither overrides real env). */
function loadDotEnv(): void {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  loadEnvFile(path.join(os.homedir(), '.plaud', '.env'));
}

function readConfigFile(): unknown {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Merge: schema defaults <- ~/.plaud/archive.json <- CLI flags. Secrets come
 * from the environment only (never the config file).
 */
export function loadArchiveConfig(flags: ArchiveFlags = {}): ResolvedConfig {
  loadDotEnv();
  const parsed = ArchiveConfigSchema.parse(readConfigFile());

  // Secrets not validated here so --dry-run works without keys; the command
  // enforces the ones it needs before any real API call.
  const openaiApiKey = process.env.OPENAI_API_KEY ?? '';
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY ?? '';

  const templatesRaw = flags.templates ?? parsed.templatesDir;

  return {
    vaultRoot: expandPath(flags.vault ?? parsed.vaultRoot),
    audioDir: expandPath(flags.audioDir ?? parsed.audioDir),
    templatesDir: templatesRaw ? expandPath(templatesRaw) : PACKAGED_TEMPLATES_DIR,
    models: parsed.models,
    audio: parsed.audio,
    transcriptLanguage: parsed.transcriptLanguage,
    transcriber: flags.transcriber ?? parsed.transcriber,
    elevenLabsModel: parsed.elevenLabsModel,
    numSpeakers: flags.numSpeakers ?? parsed.numSpeakers,
    minDurationSec: flags.minDurationSec ?? parsed.minDurationSec,
    openaiApiKey,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    elevenLabsApiKey,
  };
}

export { CONFIG_PATH, PACKAGED_TEMPLATES_DIR };
