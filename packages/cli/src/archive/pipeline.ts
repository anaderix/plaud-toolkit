import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { PlaudClient } from '@plaud/core';
import type { PlaudRecording } from '@plaud/core';
import type { ResolvedConfig } from './config.js';
import { StateStore } from './state.js';
import { archiveAudio } from './audio-archive.js';
import { audioSlug, topicSlug, isDescriptiveTitle, dateStamp } from './slug.js';
import { prepareAudio, planPreparation, AudioConfig } from './ffmpeg.js';
import { OpenAIEngine, Engine } from './openai.js';
import {
  Transcriber,
  TranscriptResult,
  makeTranscriber,
  renderTurns,
} from './transcriber.js';
import {
  loadTemplates,
  renderClassifierList,
  pickTemplate,
  renderPrompt,
  MeetingTemplate,
} from './templates.js';

export interface ArchiveOptions {
  dryRun?: boolean;
  limit?: number;
  ids?: string[];
  force?: boolean;
  /** Only move finished recordings' audio to audioArchiveDir; no Plaud/LLM calls. */
  archiveAudioOnly?: boolean;
  seedExisting?: boolean;
  verbose?: boolean;
}

export interface ArchiveResult {
  processed: number;
  skipped: number;
  failed: number;
  seeded: number;
  estimatedUsd: number;
}

interface Deps {
  client: PlaudClient;
  config: ResolvedConfig;
  state: StateStore;
  engine: Engine | null;
  transcriber: Transcriber;
  templates: MeetingTemplate[];
}

function log(msg: string): void {
  console.log(msg);
}

/** `<recordingId>_<date>_<audioSlug(filename||id)>` — id prefix makes the file↔recording mapping explicit. */
function audioBaseName(rec: PlaudRecording): string {
  return `${rec.id}_${dateStamp(rec.start_time)}_${audioSlug(rec.filename || rec.id)}`;
}

function existingAudio(dirs: (string | null)[], base: string): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of ['mp3', 'opus']) {
      const p = path.join(dir, `${base}.${ext}`);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    }
  }
  return null;
}

function workDirFor(config: ResolvedConfig, recId: string): string {
  // Kept with the audio files (and state), never in the Obsidian vault.
  return path.join(config.audioDir, '.work', recId);
}

function frontmatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([k, v]) =>
    typeof v === 'string' ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`,
  );
  return ['---', ...lines, '---', ''].join('\n');
}

// ---- stages -------------------------------------------------------------

async function ensureAudio(rec: PlaudRecording, deps: Deps): Promise<string> {
  const base = audioBaseName(rec);
  const existing = existingAudio([deps.config.audioDir, deps.config.audioArchiveDir], base);
  if (existing) return existing;

  fs.mkdirSync(deps.config.audioDir, { recursive: true });
  const mp3Url = await deps.client.getMp3Url(rec.id);
  let buf: Buffer;
  let ext: string;
  if (mp3Url) {
    const r = await fetch(mp3Url);
    buf = Buffer.from(await r.arrayBuffer());
    ext = 'mp3';
  } else {
    buf = Buffer.from(await deps.client.downloadAudio(rec.id));
    ext = 'opus';
  }
  const out = path.join(deps.config.audioDir, `${base}.${ext}`);
  fs.writeFileSync(out, buf);
  return out;
}

const ClassifyResult = z.object({
  template: z.string(),
  topicSlug: z.string().default(''),
  confidence: z.number().default(0),
});

async function classify(
  rec: PlaudRecording,
  transcript: string,
  deps: Deps,
): Promise<{ template: MeetingTemplate; topic: string }> {
  const titleDescriptive = isDescriptiveTitle(rec.filename);
  const excerpt =
    transcript.length > 5000
      ? `${transcript.slice(0, 4000)}\n...\n${transcript.slice(-1000)}`
      : transcript;

  const sys =
    'You classify a meeting transcript into exactly one template and propose a short topic slug. ' +
    'The transcript may mix Russian and English.';
  const user =
    `Templates:\n${renderClassifierList(deps.templates)}\n\n` +
    `Original recording title (may be a meaningless timestamp): ${rec.filename || '(none)'}\n\n` +
    `Return JSON: {"template": <one template name above>, ` +
    `"topicSlug": <2-5 word kebab-case slug in the transcript's dominant language>, ` +
    `"confidence": 0..1}. If unsure, use "generic".\n\n` +
    `Transcript excerpt:\n${excerpt}`;

  let chosenName = 'generic';
  let llmSlug = '';
  try {
    const res = await deps.engine!.chat(deps.config.models.classify, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { json: true });
    const parsed = ClassifyResult.parse(JSON.parse(res.content));
    chosenName = parsed.template;
    llmSlug = parsed.topicSlug;
  } catch {
    // fall back to generic + title/first-words slug
  }

  const template = pickTemplate(deps.templates, chosenName);
  const topic = titleDescriptive
    ? topicSlug(rec.filename)
    : topicSlug(llmSlug || transcript.split(/\s+/).slice(0, 6).join(' ') || rec.id);
  return { template, topic };
}

/** Pick a non-colliding `<date>-<topic>` directory under vaultRoot. */
function resolveOutDir(config: ResolvedConfig, date: string, topic: string, recId: string): string {
  let candidate = path.join(config.vaultRoot, `${date}-${topic}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    // If this dir is already ours (contains our work marker), reuse it.
    const marker = path.join(candidate, '.plaud-id');
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === recId) return candidate;
    candidate = path.join(config.vaultRoot, `${date}-${topic}-${n++}`);
  }
  return candidate;
}

/**
 * Transcribe one recording's audio.
 * - Diarizing engines (needsSizeReduction=false, e.g. ElevenLabs) take the
 *   whole original file in one call → keeps speaker IDs consistent, no ffmpeg.
 * - Whisper (needsSizeReduction=true) needs the <25MB compress/segment path;
 *   segments are transcribed independently and concatenated (no speakers).
 */
async function runTranscription(
  audioFile: string,
  workDir: string,
  opts: { language?: string | null; numSpeakers?: number | null },
  deps: Deps,
): Promise<TranscriptResult> {
  if (!deps.transcriber.needsSizeReduction) {
    return deps.transcriber.transcribe(audioFile, opts);
  }

  const { segments } = prepareAudio(audioFile, workDir, deps.config.audio as AudioConfig);
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const cacheFile = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.txt`);
    if (fs.existsSync(cacheFile)) {
      parts.push(fs.readFileSync(cacheFile, 'utf-8'));
      continue;
    }
    const { text } = await deps.transcriber.transcribe(segments[i], opts);
    fs.writeFileSync(cacheFile, text);
    parts.push(text);
  }
  return { text: parts.join('\n\n').trim() };
}

// ---- per-recording orchestration ---------------------------------------

async function processRecording(rec: PlaudRecording, deps: Deps): Promise<void> {
  const id = rec.id;
  const date = dateStamp(rec.start_time);
  const workDir = workDirFor(deps.config, id);
  deps.state.ensure(id, {
    title: rec.filename || '',
    startTime: rec.start_time,
    durationMs: rec.duration,
  });

  // 1. download
  const audioFile = await ensureAudio(rec, deps);
  deps.state.update(id, { audioFile, stages: { ...deps.state.get(id)!.stages, downloaded: true } });

  // 2. prepare + 3. transcribe (cached in id-keyed workDir, topic-independent)
  let result: TranscriptResult;
  const jsonCache = path.join(workDir, 'transcript.json');
  if (deps.state.get(id)!.stages.transcribed && fs.existsSync(jsonCache)) {
    result = JSON.parse(fs.readFileSync(jsonCache, 'utf-8'));
  } else {
    fs.mkdirSync(workDir, { recursive: true });
    deps.state.setStage(id, 'prepared');
    result = await runTranscription(
      audioFile,
      workDir,
      { language: deps.config.transcriptLanguage, numSpeakers: deps.config.numSpeakers },
      deps,
    );
    if (!result.text) throw new Error('empty transcript');
    fs.writeFileSync(jsonCache, JSON.stringify(result));
    const usd = deps.transcriber.estimateUsd(rec.duration / 1000);
    deps.state.update(id, {
      stages: { ...deps.state.get(id)!.stages, transcribed: true },
      cost: { ...deps.state.get(id)!.cost, transcribeUsd: usd },
    });
  }
  // Speaker-labeled text (when diarized) feeds classify + summarize so the LLM
  // can attribute; plain text otherwise.
  const transcript = result.text;

  // 4. classify -> finalize outDir
  const rec0 = deps.state.get(id)!;
  let outDir = rec0.outDir;
  let template = rec0.templateUsed;
  if (!rec0.stages.classified || !outDir) {
    const c = await classify(rec, transcript, deps);
    outDir = resolveOutDir(deps.config, date, c.topic, id);
    template = c.template.name;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '.plaud-id'), id);
    deps.state.update(id, {
      outDir,
      templateUsed: template,
      topicSlug: c.topic,
      stages: { ...deps.state.get(id)!.stages, classified: true },
    });
  }

  // 5. write transcript.md (before summarize, so a summary failure never loses it)
  const body = result.turns?.length ? renderTurns(result.turns, true) : result.text;
  const fm: Record<string, string | number> = {
    plaud_id: id,
    date,
    duration_min: Math.round(rec.duration / 60000),
    source: 'plaud',
    transcriber: deps.transcriber.name,
  };
  if (result.speakerCount) fm.speakers = result.speakerCount;
  const transcriptMd = frontmatter(fm) + `\n# ${rec.filename || id}\n\n${body}\n`;
  fs.writeFileSync(path.join(outDir!, 'transcript.md'), transcriptMd);

  // 6. summarize
  const tmpl = pickTemplate(deps.templates, template || 'generic');
  const sumRes = await deps.engine!.chat(deps.config.models.summarize, [
    { role: 'system', content: 'Summarize only. Do not invent. Output valid Markdown. Preserve the source language(s).' },
    { role: 'user', content: renderPrompt(tmpl, transcript) },
  ], { temperature: 0.2 });
  const summaryMd =
    frontmatter({ plaud_id: id, date, template: tmpl.name, generated_at: new Date().toISOString() }) +
    `\n${sumRes.content.trim()}\n`;
  fs.writeFileSync(path.join(outDir!, 'summary.md'), summaryMd);
  deps.state.update(id, {
    stages: { ...deps.state.get(id)!.stages, summarized: true },
    cost: { ...deps.state.get(id)!.cost, summarizeUsd: sumRes.usd },
    lastError: null,
  });

  // 7. move the audio to long-term storage — last, so any earlier failure
  // leaves the mp3 local and the re-run neither re-downloads nor re-pays.
  archiveAudioFor(id, deps.state, deps.config.audioArchiveDir);

  log(`✓ ${date}  ${template}  ${path.basename(outDir!)}`);
}

/**
 * Move one recording's audio into config.audioArchiveDir and record it in the
 * state. Never throws: failing to archive must not fail a processed recording.
 */
function archiveAudioFor(id: string, state: StateStore, archiveDir: string | null): void {
  const rec = state.get(id);
  if (!archiveDir || !rec?.audioFile || rec.stages.archived) return;

  try {
    const res = archiveAudio(rec.audioFile, archiveDir);
    if (res.moved || res.reason === 'already in archive') {
      state.update(id, {
        audioFile: res.path,
        stages: { ...rec.stages, archived: true },
      });
    } else {
      log(`  audio not archived (${res.reason})`);
    }
  } catch (err: any) {
    log(`  audio not archived: ${err?.message ?? err}`);
    state.update(id, { lastError: `archive audio: ${err?.message ?? err}` });
  }
}

/**
 * Sweep already-finished recordings whose audio is still local (or was moved
 * out of band, e.g. by `rclone move`) and bring the state in line.
 */
function archiveFinishedAudio(state: StateStore, archiveDir: string | null): number {
  if (!archiveDir) return 0;
  let n = 0;
  for (const id of state.ids()) {
    const rec = state.get(id)!;
    if (!rec.stages.summarized || rec.stages.archived) continue;
    archiveAudioFor(id, state, archiveDir);
    if (state.get(id)!.stages.archived) n++;
  }
  return n;
}

// ---- entry point --------------------------------------------------------

export async function runArchive(
  client: PlaudClient,
  config: ResolvedConfig,
  opts: ArchiveOptions,
  injectedEngine?: Engine,
  injectedTranscriber?: Transcriber,
): Promise<ArchiveResult> {
  // State lives with the audio files (durable inputs), not in the Obsidian vault.
  const state = new StateStore(config.audioDir);
  const result: ArchiveResult = { processed: 0, skipped: 0, failed: 0, seeded: 0, estimatedUsd: 0 };

  // Constructing a transcriber makes no API call, so it's safe even for --dry-run.
  const transcriber = injectedTranscriber ?? makeTranscriber({
    transcriber: config.transcriber,
    elevenLabsApiKey: config.elevenLabsApiKey,
    elevenLabsModel: config.elevenLabsModel,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    whisperModel: config.models.transcribe,
  });

  // --archive-audio-only: reconcile/move audio for finished recordings and stop.
  // Deliberately before any API call, so it works with an expired token.
  if (opts.archiveAudioOnly) {
    if (!config.audioArchiveDir) throw new Error('--archive-audio-only needs audioArchiveDir (or --audio-archive-dir).');
    const n = archiveFinishedAudio(state, config.audioArchiveDir);
    log(`Archived audio for ${n} recording(s) to ${config.audioArchiveDir}.`);
    return result;
  }

  let recordings = (await client.listRecordings()).filter(r => !r.is_trash);
  const explicitIds = !!(opts.ids && opts.ids.length);
  if (explicitIds) {
    const wanted = new Set(opts.ids);
    recordings = recordings.filter(r => wanted.has(r.id));
  } else if (config.minDurationSec > 0) {
    // Skip short (often accidental) recordings — but never when an id was named.
    const before = recordings.length;
    recordings = recordings.filter(r => r.duration / 1000 >= config.minDurationSec);
    const tooShort = before - recordings.length;
    if (tooShort > 0) {
      log(`Skipping ${tooShort} recording(s) shorter than ${config.minDurationSec}s (use --id to force one).`);
    }
  }
  recordings.sort((a, b) => a.start_time - b.start_time);

  // --seed-existing: register already-downloaded audio as downloaded, no API calls.
  if (opts.seedExisting) {
    for (const rec of recordings) {
      const found = existingAudio([config.audioDir, config.audioArchiveDir], audioBaseName(rec));
      if (!found) continue;
      state.ensure(rec.id, { title: rec.filename || '', startTime: rec.start_time, durationMs: rec.duration });
      state.update(rec.id, {
        audioFile: found,
        seeded: true,
        stages: { ...state.get(rec.id)!.stages, downloaded: true },
      });
      result.seeded++;
    }
    log(`Seeded ${result.seeded} existing audio file(s) as downloaded (no transcription).`);
    return result;
  }

  // Determine work list.
  const todo = recordings.filter(r => opts.force || !state.isDone(r.id));
  const sliced = opts.limit ? todo.slice(0, opts.limit) : todo;
  result.skipped = recordings.length - todo.length;

  if (opts.dryRun) {
    log(`DRY RUN — ${sliced.length} recording(s) would be processed with '${transcriber.name}' (${result.skipped} already done):\n`);
    for (const rec of sliced) {
      const date = dateStamp(rec.start_time);
      const descriptive = isDescriptiveTitle(rec.filename);
      const topic = descriptive ? topicSlug(rec.filename) : '<llm-derived>';
      const prep = transcriber.needsSizeReduction
        ? (() => {
            const p = planPreparation(rec.filesize || 0, rec.duration / 1000, config.audio as AudioConfig);
            return `prep=${p.strategy}${p.strategy === 'segment' ? `(${p.estChunks})` : ''}`;
          })()
        : 'prep=whole-file';
      const usd = transcriber.estimateUsd(rec.duration / 1000);
      result.estimatedUsd += usd;
      log(
        `  ${rec.id}  ${date}-${topic}  ${Math.round(rec.duration / 60000)}m  ${prep}  ~$${usd.toFixed(3)}`,
      );
    }
    if (config.audioArchiveDir) {
      const pending = state.ids().filter(id => {
        const r = state.get(id)!;
        return r.stages.summarized && !r.stages.archived && !!r.audioFile && fs.existsSync(r.audioFile);
      }).length;
      log(`\n${pending} finished recording(s) still have local audio to move to ${config.audioArchiveDir}.`);
    }
    log(`\nEstimated transcription cost: ~$${result.estimatedUsd.toFixed(2)} (summary LLM cost not estimated). Nothing was written.`);
    return result;
  }

  // Real run always needs OpenAI (classify + summarize), plus the transcriber's key.
  if (!injectedEngine && !config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not set. Export it before running `plaud archive` (or use --dry-run).');
  }
  if (!injectedTranscriber && config.transcriber === 'elevenlabs' && !config.elevenLabsApiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set (needed for speaker diarization). Set it, use --transcriber whisper, or --dry-run.');
  }
  // ffmpeg is only needed when the transcriber requires size reduction (Whisper).
  if (transcriber.needsSizeReduction) {
    const { checkFfmpeg } = await import('./ffmpeg.js');
    checkFfmpeg();
  }

  const deps: Deps = {
    client,
    config,
    state,
    engine: injectedEngine ?? new OpenAIEngine(config.openaiApiKey, config.openaiBaseUrl),
    transcriber,
    templates: loadTemplates(config.templatesDir),
  };

  if (opts.force) {
    for (const rec of sliced) {
      state.update(rec.id, {
        stages: { downloaded: false, prepared: false, transcribed: false, classified: false, summarized: false, archived: false },
      });
      fs.rmSync(workDirFor(config, rec.id), { recursive: true, force: true });
    }
  }

  for (const rec of sliced) {
    try {
      await processRecording(rec, deps);
      result.processed++;
    } catch (err: any) {
      result.failed++;
      state.ensure(rec.id, {});
      state.update(rec.id, { lastError: String(err?.message ?? err) });
      log(`✗ ${rec.id} (${rec.filename}): ${err?.message ?? err}`);
    }
    // Clean the work cache only once the recording is fully done — keep it on
    // failure so a re-run resumes without re-paying for transcription.
    if (!opts.verbose && state.isDone(rec.id)) {
      fs.rmSync(workDirFor(config, rec.id), { recursive: true, force: true });
    }
  }

  const archived = archiveFinishedAudio(state, config.audioArchiveDir);
  if (archived > 0) log(`Archived audio for ${archived} recording(s) to ${config.audioArchiveDir}.`);

  log(`\nDone: ${result.processed} processed, ${result.skipped} already done, ${result.failed} failed.`);
  return result;
}
