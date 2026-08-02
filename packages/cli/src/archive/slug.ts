/**
 * Filename / topic slug helpers for the archive pipeline.
 *
 * `audioSlug` must reproduce EXACTLY the naming used by the throwaway
 * dl-all.mts so that audio files downloaded by either path interoperate
 * (and so --seed-existing can match the 26 files already on disk).
 */

/** Slug used for audio filenames: `<date>_<audioSlug>.<ext>` — matches dl-all.mts. */
export function audioSlug(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** Lowercase kebab slug for the `<date>-<topic>` output directory. Keeps Cyrillic. */
export function topicSlug(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled';
}

/**
 * A recording title is "descriptive" if it is NOT just the device's default
 * timestamp name (e.g. "2026-06-17 09:10:46" / "2026_06_17_09_10_46") and
 * contains at least one letter. Non-descriptive titles get a topic slug from
 * the LLM instead.
 */
const BARE_TIMESTAMP = /^\d{4}[-_ ]\d{2}[-_ ]\d{2}[ _]\d{2}[:_]\d{2}/;

export function isDescriptiveTitle(name: string | undefined | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (BARE_TIMESTAMP.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed);
}

/** YYYY-MM-DD from an epoch-ms timestamp (UTC). */
export function dateStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
