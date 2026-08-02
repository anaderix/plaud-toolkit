import { describe, it, expect } from 'vitest';
import { planPreparation, estimateMp3Bytes } from '../src/archive/ffmpeg.js';

const audio = { maxBytes: 24_000_000, targetBitrateKbps: 32, chunkSeconds: 1200 };

describe('planPreparation', () => {
  it('uses the file as-is when under maxBytes', () => {
    expect(planPreparation(10_000_000, 600, audio)).toEqual({ strategy: 'asis', chunkSeconds: 1200, estChunks: 1 });
  });

  it('transcodes when over maxBytes but compresses under it', () => {
    // 30 min mono @32k ≈ 7.2 MB, well under 24 MB
    const p = planPreparation(40_000_000, 1800, audio);
    expect(p.strategy).toBe('transcode');
    expect(p.estChunks).toBe(1);
  });

  it('segments when even compressed audio exceeds maxBytes', () => {
    // 4 h @32k ≈ 57.6 MB > 24 MB → must split
    const p = planPreparation(200_000_000, 14400, audio);
    expect(p.strategy).toBe('segment');
    expect(p.estChunks).toBeGreaterThan(1);
    // each chunk must fit under maxBytes
    expect(estimateMp3Bytes(p.chunkSeconds, audio.targetBitrateKbps)).toBeLessThan(audio.maxBytes);
  });

  it('shrinks chunkSeconds when the configured value would still overflow', () => {
    const tiny = { maxBytes: 2_000_000, targetBitrateKbps: 32, chunkSeconds: 1200 };
    const p = planPreparation(10_000_000, 3600, tiny);
    expect(p.strategy).toBe('segment');
    expect(p.chunkSeconds).toBeLessThan(1200);
    expect(estimateMp3Bytes(p.chunkSeconds, tiny.targetBitrateKbps)).toBeLessThan(tiny.maxBytes);
  });
});

describe('estimateMp3Bytes', () => {
  it('scales with duration and bitrate', () => {
    expect(estimateMp3Bytes(60, 32)).toBe(Math.ceil((32 * 1000 * 60) / 8));
  });
});
