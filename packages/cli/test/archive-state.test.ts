import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateStore } from '../src/archive/state.js';

describe('StateStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-state-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('ensure creates a record with all stages false', () => {
    const s = new StateStore(dir);
    const r = s.ensure('rec1', { title: 'T', startTime: 1, durationMs: 2 });
    expect(r.plaudId).toBe('rec1');
    expect(r.stages).toEqual({
      downloaded: false, prepared: false, transcribed: false, classified: false, summarized: false,
    });
  });

  it('isDone requires both transcribed AND summarized (resume detection)', () => {
    const s = new StateStore(dir);
    s.ensure('rec1', {});
    s.setStage('rec1', 'transcribed');
    expect(s.isDone('rec1')).toBe(false); // transcribed but not summarized => still NEW
    s.setStage('rec1', 'summarized');
    expect(s.isDone('rec1')).toBe(true);
  });

  it('isDone is false for unknown ids', () => {
    expect(new StateStore(dir).isDone('nope')).toBe(false);
  });

  it('persists across instances (atomic write + reload)', () => {
    const s1 = new StateStore(dir);
    s1.ensure('rec1', { title: 'Hello' });
    s1.update('rec1', { templateUsed: 'lecture', stages: { ...s1.get('rec1')!.stages, transcribed: true } });
    const s2 = new StateStore(dir);
    expect(s2.get('rec1')?.templateUsed).toBe('lecture');
    expect(s2.get('rec1')?.stages.transcribed).toBe(true);
  });

  it('update merges stages/cost one level deep', () => {
    const s = new StateStore(dir);
    s.ensure('rec1', {});
    s.update('rec1', { cost: { ...s.get('rec1')!.cost, transcribeUsd: 0.5 } });
    s.update('rec1', { cost: { ...s.get('rec1')!.cost, summarizeUsd: 0.2 } });
    expect(s.get('rec1')?.cost).toEqual({ transcribeUsd: 0.5, summarizeUsd: 0.2, seconds: 0 });
  });

  it('records a seeded marker without marking transcribed', () => {
    const s = new StateStore(dir);
    s.ensure('rec1', {});
    s.update('rec1', { seeded: true, stages: { ...s.get('rec1')!.stages, downloaded: true } });
    expect(s.get('rec1')?.seeded).toBe(true);
    expect(s.isDone('rec1')).toBe(false);
  });
});
