import * as fs from 'fs';
import * as path from 'path';
import { OpenAIEngine } from './openai.js';

export interface SpeakerTurn {
  speaker: string; // "Speaker 1", "Speaker 2", ...
  text: string;
  start?: number;
  end?: number;
}

export interface TranscriptResult {
  /** Plain (or speaker-labeled) full text. */
  text: string;
  /** Present when the engine diarized; consecutive same-speaker words grouped. */
  turns?: SpeakerTurn[];
  speakerCount?: number;
  language?: string;
}

export interface TranscribeOpts {
  language?: string | null;
  numSpeakers?: number | null;
}

export interface Transcriber {
  readonly name: string;
  /** Whether the caller must shrink/split audio (Whisper's 25 MB limit) before calling. */
  readonly needsSizeReduction: boolean;
  transcribe(filePath: string, opts?: TranscribeOpts): Promise<TranscriptResult>;
  estimateUsd(durationSec: number): number;
}

// ---- ElevenLabs word[] -> speaker turns (exported for unit tests) --------

interface ElevenWord {
  text?: string;
  type?: string; // 'word' | 'spacing' | 'audio_event'
  start?: number;
  end?: number;
  speaker_id?: string;
}

/** Group consecutive words by speaker_id into turns, labeling speakers 1..N in first-seen order. */
export function groupWordsIntoTurns(words: ElevenWord[]): SpeakerTurn[] {
  const labelBySpeaker = new Map<string, string>();
  const turns: SpeakerTurn[] = [];
  let cur: { id: string; parts: string[]; start?: number; end?: number } | null = null;

  const label = (id: string): string => {
    if (!labelBySpeaker.has(id)) labelBySpeaker.set(id, `Speaker ${labelBySpeaker.size + 1}`);
    return labelBySpeaker.get(id)!;
  };
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
    if (text) turns.push({ speaker: label(cur.id), text, start: cur.start, end: cur.end });
  };

  for (const w of words) {
    const id = w.speaker_id ?? 'speaker_0';
    if (!cur || cur.id !== id) {
      flush();
      cur = { id, parts: [w.text ?? ''], start: w.start, end: w.end };
    } else {
      cur.parts.push(w.text ?? '');
      if (typeof w.end === 'number') cur.end = w.end;
    }
  }
  flush();
  return turns;
}

/** Render turns as text; `bold` wraps the speaker label in ** for Markdown. */
export function renderTurns(turns: SpeakerTurn[], bold = false): string {
  return turns
    .map(t => (bold ? `**${t.speaker}:** ${t.text}` : `${t.speaker}: ${t.text}`))
    .join('\n\n');
}

export function parseElevenLabsResponse(json: any): TranscriptResult {
  const words: ElevenWord[] = Array.isArray(json?.words) ? json.words : [];
  const hasSpeakers = words.some(w => w.speaker_id);
  const language = typeof json?.language_code === 'string' ? json.language_code : undefined;

  if (!words.length || !hasSpeakers) {
    return { text: (json?.text ?? '').trim(), language };
  }
  const turns = groupWordsIntoTurns(words);
  const speakerCount = new Set(turns.map(t => t.speaker)).size;
  const text = renderTurns(turns);
  return { text, turns, speakerCount, language };
}

// ---- implementations -----------------------------------------------------

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_USD_PER_MIN = 0.0067; // ~ $0.40/hr; estimate only

export class ElevenLabsTranscriber implements Transcriber {
  readonly name = 'elevenlabs';
  readonly needsSizeReduction = false; // handles up to ~10h; send the whole file

  constructor(private apiKey: string, private model = 'scribe_v2') {}

  async transcribe(filePath: string, opts: TranscribeOpts = {}): Promise<TranscriptResult> {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.set('model_id', this.model);
    form.set('file', new Blob([buf]), path.basename(filePath));
    form.set('diarize', 'true');
    form.set('timestamps_granularity', 'word');
    if (opts.numSpeakers) form.set('num_speakers', String(opts.numSpeakers));
    if (opts.language) form.set('language_code', opts.language);

    const res = await fetch(ELEVENLABS_STT_URL, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs STT failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    return parseElevenLabsResponse(await res.json());
  }

  estimateUsd(durationSec: number): number {
    return (durationSec / 60) * ELEVENLABS_USD_PER_MIN;
  }
}

export class WhisperTranscriber implements Transcriber {
  readonly name = 'whisper';
  readonly needsSizeReduction = true; // OpenAI's 25 MB per-file limit
  private engine?: OpenAIEngine;

  // Client is built lazily so --dry-run (no key) never constructs it.
  constructor(private apiKey: string, private baseUrl?: string, private model = 'whisper-1') {}

  async transcribe(filePath: string, opts: TranscribeOpts = {}): Promise<TranscriptResult> {
    if (!this.engine) {
      if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for Whisper transcription.');
      this.engine = new OpenAIEngine(this.apiKey, this.baseUrl);
    }
    const text = await this.engine.transcribe(filePath, this.model, opts.language);
    return { text: text.trim() };
  }

  estimateUsd(durationSec: number): number {
    return (durationSec / 60) * 0.006;
  }
}

export interface TranscriberConfig {
  transcriber: 'elevenlabs' | 'whisper';
  elevenLabsApiKey: string;
  elevenLabsModel: string;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  whisperModel: string;
}

export function makeTranscriber(cfg: TranscriberConfig): Transcriber {
  if (cfg.transcriber === 'whisper') {
    return new WhisperTranscriber(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.whisperModel);
  }
  return new ElevenLabsTranscriber(cfg.elevenLabsApiKey, cfg.elevenLabsModel);
}
