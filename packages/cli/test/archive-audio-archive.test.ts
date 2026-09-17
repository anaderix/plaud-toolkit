import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { archiveAudio, moveFile, archiveReady, ARCHIVE_MARKER } from '../src/archive/audio-archive.js';
import type { FileOps } from '../src/archive/audio-archive.js';

/** Pretend src and dest are on different filesystems, as a FUSE mount is. */
const exdev = (copy: FileOps['copy']): FileOps => ({
  rename: () => { const e: any = new Error('cross-device link'); e.code = 'EXDEV'; throw e; },
  copy,
});

describe('audio archive', () => {
  let local: string;
  let remote: string;

  const audio = (name = 'rec1.mp3', body = 'AUDIO') => {
    const p = path.join(local, name);
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-local-'));
    remote = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-remote-'));
    fs.writeFileSync(path.join(remote, ARCHIVE_MARKER), '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('moves the file and reports the new path', () => {
    const src = audio();
    const res = archiveAudio(src, remote);
    expect(res).toEqual({ path: path.join(remote, 'rec1.mp3'), moved: true });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(res.path, 'utf-8')).toBe('AUDIO');
  });

  it('refuses to move when the marker is missing (dead mount)', () => {
    fs.unlinkSync(path.join(remote, ARCHIVE_MARKER));
    const src = audio();
    const res = archiveAudio(src, remote);
    expect(res.moved).toBe(false);
    expect(res.reason).toMatch(/not ready/);
    expect(res.path).toBe(src);
    expect(fs.existsSync(src)).toBe(true);
    expect(archiveReady(remote)).toBe(false);
  });

  it('falls back to copy+verify+unlink across devices (EXDEV)', () => {
    const src = audio('rec2.mp3');
    const dest = moveFile(src, remote, exdev((s, d) => fs.copyFileSync(s, d)));
    expect(dest).toBe(path.join(remote, 'rec2.mp3'));
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('AUDIO');
  });

  it('keeps the local file when the copy comes out short', () => {
    const src = audio('rec3.mp3');
    const truncating = exdev((_s, d) => fs.writeFileSync(d, 'AU'));
    expect(() => moveFile(src, remote, truncating)).toThrow(/expected 5/);
    expect(fs.existsSync(src)).toBe(true);
  });

  it('reconciles a file already moved out of band (rclone move)', () => {
    fs.writeFileSync(path.join(remote, 'rec4.mp3'), 'AUDIO');
    const res = archiveAudio(path.join(local, 'rec4.mp3'), remote);
    expect(res).toEqual({ path: path.join(remote, 'rec4.mp3'), moved: false, reason: 'already in archive' });
  });

  it('drops a local duplicate of an identical archived file', () => {
    const src = audio('rec5.mp3');
    fs.writeFileSync(path.join(remote, 'rec5.mp3'), 'AUDIO');
    const res = archiveAudio(src, remote);
    expect(res.path).toBe(path.join(remote, 'rec5.mp3'));
    expect(fs.existsSync(src)).toBe(false);
  });

  it('reports a missing source instead of throwing', () => {
    const res = archiveAudio(path.join(local, 'gone.mp3'), remote);
    expect(res.moved).toBe(false);
    expect(res.reason).toBe('audio file is gone');
  });
});
