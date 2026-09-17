import * as fs from 'fs';
import * as path from 'path';

/**
 * Marker file that must exist inside the archive dir before anything is moved
 * there. Its job is to catch a dead mount: if the rclone/gdrive mount drops,
 * the mount point turns into an ordinary empty directory and a "move" would
 * silently fill the local disk instead. Create it with `make gdrive-init`.
 */
export const ARCHIVE_MARKER = '.plaud-audio-archive';

export function archiveReady(archiveDir: string): boolean {
  return fs.existsSync(path.join(archiveDir, ARCHIVE_MARKER));
}

export interface FileOps {
  rename(src: string, dest: string): void;
  copy(src: string, dest: string): void;
}

/** Real filesystem; tests substitute these to exercise the cross-device path. */
const REAL_OPS: FileOps = {
  rename: (s, d) => fs.renameSync(s, d),
  copy: (s, d) => fs.copyFileSync(s, d),
};

/**
 * Move a file to another directory, tolerating a cross-device destination
 * (a FUSE mount always is one): rename first, else copy → verify size →
 * unlink. The local original is only removed once the copy is known good, so
 * a failed move never loses audio.
 */
export function moveFile(src: string, destDir: string, ops: FileOps = REAL_OPS): string {
  const dest = path.join(destDir, path.basename(src));
  try {
    ops.rename(src, dest);
    return dest;
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
  }

  const srcSize = fs.statSync(src).size;
  ops.copy(src, dest);
  const destSize = fs.statSync(dest).size;
  if (destSize !== srcSize) {
    // Keep both copies; the caller reports it and the local file stays usable.
    throw new Error(`copy to ${dest} is ${destSize} bytes, expected ${srcSize}`);
  }
  fs.unlinkSync(src);
  return dest;
}

export interface ArchiveAudioResult {
  /** Where the audio lives now. */
  path: string;
  moved: boolean;
  /** Why nothing was moved, when moved is false. */
  reason?: string;
}

/**
 * Put a recording's audio in the archive dir. Already-archived files (moved
 * out of band, e.g. by `rclone move`) are simply reported, so the state file
 * can be reconciled without touching Drive.
 */
export function archiveAudio(audioFile: string, archiveDir: string, ops?: FileOps): ArchiveAudioResult {
  const dest = path.join(archiveDir, path.basename(audioFile));

  if (!archiveReady(archiveDir)) {
    return { path: audioFile, moved: false, reason: `archive dir not ready (no ${ARCHIVE_MARKER} in ${archiveDir})` };
  }
  if (fs.existsSync(dest)) {
    // Destination wins: drop a leftover local duplicate only if it matches.
    if (fs.existsSync(audioFile) && fs.statSync(audioFile).size === fs.statSync(dest).size) {
      fs.unlinkSync(audioFile);
    }
    return { path: dest, moved: false, reason: 'already in archive' };
  }
  if (!fs.existsSync(audioFile)) {
    return { path: audioFile, moved: false, reason: 'audio file is gone' };
  }
  return { path: moveFile(audioFile, archiveDir, ops), moved: true };
}
