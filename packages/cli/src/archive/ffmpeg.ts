import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface AudioConfig {
  maxBytes: number;
  targetBitrateKbps: number;
  chunkSeconds: number;
}

export interface ProbeResult {
  sizeBytes: number;
  durationSec: number;
}

export type PrepStrategy = 'asis' | 'transcode' | 'segment';

export interface PreparationPlan {
  strategy: PrepStrategy;
  /** Effective per-chunk length when strategy === 'segment'. */
  chunkSeconds: number;
  /** Number of segments produced (1 for asis/transcode). */
  estChunks: number;
}

/** Verify ffmpeg + ffprobe are callable; throw a helpful error otherwise. */
export function checkFfmpeg(): void {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf-8' });
    if (r.status !== 0) {
      throw new Error(
        `${bin} not found. Install ffmpeg (e.g. "apt install ffmpeg" or "brew install ffmpeg").`,
      );
    }
  }
}

export function ffprobeFile(file: string): ProbeResult {
  const sizeBytes = fs.statSync(file).size;
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed for ${file}: ${r.stderr}`);
  const durationSec = parseFloat((r.stdout || '0').trim()) || 0;
  return { sizeBytes, durationSec };
}

/** Approximate size of a mono MP3 of the given duration at the given bitrate. */
export function estimateMp3Bytes(durationSec: number, bitrateKbps: number): number {
  return Math.ceil((bitrateKbps * 1000 * durationSec) / 8);
}

/**
 * Pure decision: given the source size/duration and the audio config, decide
 * whether to use the file as-is, transcode it, or transcode-and-segment it,
 * and how long each segment should be so it stays under maxBytes.
 */
export function planPreparation(
  sizeBytes: number,
  durationSec: number,
  audio: AudioConfig,
): PreparationPlan {
  if (sizeBytes <= audio.maxBytes) {
    return { strategy: 'asis', chunkSeconds: audio.chunkSeconds, estChunks: 1 };
  }

  const transcodedBytes = estimateMp3Bytes(durationSec, audio.targetBitrateKbps);
  if (transcodedBytes <= audio.maxBytes) {
    return { strategy: 'transcode', chunkSeconds: audio.chunkSeconds, estChunks: 1 };
  }

  // Need to segment the (compressed) audio. Pick a chunk length whose estimated
  // bytes stay safely (90%) under maxBytes, capped by the configured chunkSeconds.
  const bytesPerSec = (audio.targetBitrateKbps * 1000) / 8;
  const maxSecondsPerChunk = Math.floor((audio.maxBytes * 0.9) / bytesPerSec);
  const chunkSeconds = Math.max(1, Math.min(audio.chunkSeconds, maxSecondsPerChunk));
  const estChunks = Math.max(1, Math.ceil(durationSec / chunkSeconds));
  return { strategy: 'segment', chunkSeconds, estChunks };
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr?.slice(-500) || 'unknown error'}`);
}

/** Transcode to mono MP3 at the given bitrate. */
export function transcodeMono(input: string, output: string, bitrateKbps: number): void {
  run('ffmpeg', [
    '-y', '-i', input,
    '-vn', '-ac', '1', '-b:a', `${bitrateKbps}k`,
    output,
  ]);
}

/** Split into time-based MP3 segments; returns ordered segment paths. */
export function segmentFile(input: string, outDir: string, chunkSeconds: number): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'chunk-%03d.mp3');
  run('ffmpeg', [
    '-y', '-i', input,
    '-f', 'segment', '-segment_time', String(chunkSeconds),
    '-c:a', 'libmp3lame', '-ac', '1',
    pattern,
  ]);
  return fs
    .readdirSync(outDir)
    .filter(f => /^chunk-\d+\.mp3$/.test(f))
    .sort()
    .map(f => path.join(outDir, f));
}

/**
 * Produce an ordered list of audio files ready for the Whisper API (each under
 * maxBytes). Work artifacts go in workDir. Idempotent: if work outputs already
 * exist they are reused.
 */
export function prepareAudio(
  input: string,
  workDir: string,
  audio: AudioConfig,
): { segments: string[]; plan: PreparationPlan } {
  const { sizeBytes, durationSec } = ffprobeFile(input);
  const plan = planPreparation(sizeBytes, durationSec, audio);

  if (plan.strategy === 'asis') {
    return { segments: [input], plan };
  }

  fs.mkdirSync(workDir, { recursive: true });
  const compressed = path.join(workDir, 'compressed.mp3');
  if (!fs.existsSync(compressed) || fs.statSync(compressed).size === 0) {
    transcodeMono(input, compressed, audio.targetBitrateKbps);
  }

  if (plan.strategy === 'transcode') {
    return { segments: [compressed], plan };
  }

  const segDir = path.join(workDir, 'segments');
  let segments = fs.existsSync(segDir)
    ? fs.readdirSync(segDir).filter(f => /^chunk-\d+\.mp3$/.test(f)).sort().map(f => path.join(segDir, f))
    : [];
  if (segments.length === 0) {
    segments = segmentFile(compressed, segDir, plan.chunkSeconds);
  }
  return { segments, plan };
}
