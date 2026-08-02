import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runArchive } from '../src/archive/pipeline.js';
import type { Engine, ChatMessage } from '../src/archive/openai.js';
import type { Transcriber, TranscribeOpts, TranscriptResult } from '../src/archive/transcriber.js';
import type { ResolvedConfig } from '../src/archive/config.js';

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;

const REC = {
  id: 'recX',
  filename: '06-17 Lecture: Biology',
  fullname: '06-17 Lecture: Biology',
  filesize: 5000,
  duration: 60000,
  start_time: Date.UTC(2026, 5, 17, 9, 0),
  end_time: Date.UTC(2026, 5, 17, 10, 0),
  is_trash: false,
  is_trans: true,
  is_summary: false,
  keywords: [],
  serial_number: 'SN',
};

class FakeEngine implements Engine {
  calls: string[] = [];
  async transcribe(): Promise<string> {
    this.calls.push('transcribe'); // should NOT be called — transcription goes via the Transcriber
    return 'unused';
  }
  async chat(model: string, _messages: ChatMessage[], opts?: { json?: boolean }) {
    this.calls.push(opts?.json ? 'classify' : 'summarize');
    const content = opts?.json
      ? JSON.stringify({ template: 'lecture', topicSlug: 'ignored-because-title', confidence: 0.9 })
      : '## TL;DR\nA fake summary.';
    return { content, usage: { promptTokens: 10, completionTokens: 5 }, usd: 0 };
  }
}

/** Diarizing transcriber (like ElevenLabs): returns speaker turns, no size reduction. */
class FakeDiarizer implements Transcriber {
  readonly name = 'fake-eleven';
  readonly needsSizeReduction = false;
  calls: string[] = [];
  lastFile?: string;
  async transcribe(file: string, _opts?: TranscribeOpts): Promise<TranscriptResult> {
    this.calls.push('transcribe');
    this.lastFile = file;
    return {
      text: 'Speaker 1: Привет\n\nSpeaker 2: Hello',
      turns: [
        { speaker: 'Speaker 1', text: 'Привет' },
        { speaker: 'Speaker 2', text: 'Hello' },
      ],
      speakerCount: 2,
    };
  }
  estimateUsd() { return 0; }
}

/** Non-diarizing transcriber (like Whisper): needs size reduction, plain text. */
class FakeWhisper implements Transcriber {
  readonly name = 'fake-whisper';
  readonly needsSizeReduction = true;
  async transcribe(): Promise<TranscriptResult> {
    return { text: 'plain transcript no speakers' };
  }
  estimateUsd() { return 0; }
}

function makeConfig(vaultRoot: string, audioDir: string): ResolvedConfig {
  return {
    vaultRoot,
    audioDir,
    templatesDir: TEMPLATES_DIR,
    models: { transcribe: 'whisper-1', classify: 'gpt-4o-mini', summarize: 'gpt-4o' },
    audio: { maxBytes: 24_000_000, targetBitrateKbps: 32, chunkSeconds: 1200 },
    transcriptLanguage: null,
    transcriber: 'elevenlabs',
    elevenLabsModel: 'scribe_v2',
    numSpeakers: null,
    minDurationSec: 0,
    openaiApiKey: '', // injected engine bypasses the key requirement
    elevenLabsApiKey: '', // injected transcriber bypasses the key requirement
  };
}

const fakeClient = {
  async listRecordings() { return [REC]; },
  async getMp3Url() { return null; },
  async downloadAudio() { return new ArrayBuffer(0); },
} as any;

describe.skipIf(!ffmpegAvailable)('runArchive (integration, fakes)', () => {
  let root: string;
  let audioDir: string;
  let audioFile: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-vault-'));
    audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-audio-'));
    audioFile = path.join(audioDir, 'recX_2026-06-17_06_17_Lecture_Biology.mp3');
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', audioFile]);
    if (r.status !== 0) throw new Error('failed to synthesize test mp3');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(audioDir, { recursive: true, force: true });
  });

  it('diarizing engine: writes speaker-labeled transcript, skips ffmpeg, engine only classifies+summarizes', async () => {
    const engine = new FakeEngine();
    const diarizer = new FakeDiarizer();
    const res = await runArchive(fakeClient, makeConfig(root, audioDir), { limit: 1 }, engine, diarizer);

    expect(res.processed).toBe(1);
    expect(res.failed).toBe(0);
    expect(engine.calls).toEqual(['classify', 'summarize']); // engine never transcribes
    expect(diarizer.calls).toEqual(['transcribe']);
    // needsSizeReduction=false → transcriber gets the ORIGINAL audio file, not a workdir chunk.
    expect(diarizer.lastFile).toBe(audioFile);

    const outDir = path.join(root, '2026-06-17-06-17-lecture-biology');
    const transcript = fs.readFileSync(path.join(outDir, 'transcript.md'), 'utf-8');
    const summary = fs.readFileSync(path.join(outDir, 'summary.md'), 'utf-8');
    expect(transcript).toContain('**Speaker 1:** Привет');
    expect(transcript).toContain('**Speaker 2:** Hello');
    expect(transcript).toContain('speakers: 2');
    expect(transcript).toContain('transcriber: "fake-eleven"');
    expect(summary).toContain('A fake summary');
  });

  it('non-diarizing engine: plain transcript with no speaker labels', async () => {
    const outDir = path.join(root, '2026-06-17-06-17-lecture-biology');
    await runArchive(fakeClient, makeConfig(root, audioDir), { limit: 1 }, new FakeEngine(), new FakeWhisper());
    const transcript = fs.readFileSync(path.join(outDir, 'transcript.md'), 'utf-8');
    expect(transcript).toContain('plain transcript no speakers');
    expect(transcript).not.toContain('Speaker 1');
    expect(transcript).not.toContain('speakers:');
  });

  it('is idempotent: a second run skips the already-done recording', async () => {
    await runArchive(fakeClient, makeConfig(root, audioDir), { limit: 1 }, new FakeEngine(), new FakeDiarizer());
    const engine2 = new FakeEngine();
    const diarizer2 = new FakeDiarizer();
    const res2 = await runArchive(fakeClient, makeConfig(root, audioDir), {}, engine2, diarizer2);
    expect(res2.processed).toBe(0);
    expect(res2.skipped).toBe(1);
    expect(engine2.calls).toEqual([]);
    expect(diarizer2.calls).toEqual([]); // no re-transcribe
  });

  it('skips recordings shorter than minDurationSec, but --id overrides', async () => {
    // REC is 60s; require 120s.
    const cfg = { ...makeConfig(root, audioDir), minDurationSec: 120 };

    const skipRes = await runArchive(fakeClient, cfg, {}, new FakeEngine(), new FakeDiarizer());
    expect(skipRes.processed).toBe(0); // too short -> skipped

    const forceRes = await runArchive(fakeClient, cfg, { ids: [REC.id] }, new FakeEngine(), new FakeDiarizer());
    expect(forceRes.processed).toBe(1); // explicit id overrides the length filter
  });

  it('resumes after a summary failure without re-transcribing', async () => {
    const engine = new FakeEngine();
    engine.chat = async (_m, _msgs, opts) => {
      engine.calls.push(opts?.json ? 'classify' : 'summarize');
      if (!opts?.json) throw new Error('summary boom');
      return { content: JSON.stringify({ template: 'lecture', topicSlug: 't', confidence: 1 }), usage: { promptTokens: 1, completionTokens: 1 }, usd: 0 };
    };
    const r1 = await runArchive(fakeClient, makeConfig(root, audioDir), { limit: 1, verbose: true }, engine, new FakeDiarizer());
    expect(r1.failed).toBe(1);

    const engine2 = new FakeEngine();
    const diarizer2 = new FakeDiarizer();
    const r2 = await runArchive(fakeClient, makeConfig(root, audioDir), { verbose: true }, engine2, diarizer2);
    expect(r2.processed).toBe(1);
    expect(diarizer2.calls).toEqual([]); // transcript.json cached → no re-transcribe
    expect(engine2.calls).toContain('summarize');
  });
});
