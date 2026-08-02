import { describe, it, expect } from 'vitest';
import { audioSlug, topicSlug, isDescriptiveTitle, dateStamp } from '../src/archive/slug.js';

describe('audioSlug', () => {
  it('matches the dl-all.mts naming (underscores, keeps case + Cyrillic)', () => {
    expect(audioSlug('06-17 Встреча: Условия')).toBe('06_17_Встреча_Условия');
    expect(audioSlug('2026-06-17 09:10:46')).toBe('2026_06_17_09_10_46');
  });
  it('caps length at 60', () => {
    expect(audioSlug('a'.repeat(100)).length).toBe(60);
  });
});

describe('topicSlug', () => {
  it('lowercases, kebabs, keeps Cyrillic', () => {
    expect(topicSlug('06-17 Lecture: Biology')).toBe('06-17-lecture-biology');
    expect(topicSlug('Встреча Условия')).toBe('встреча-условия');
  });
  it('falls back to "untitled" when empty', () => {
    expect(topicSlug('!!!')).toBe('untitled');
  });
});

describe('isDescriptiveTitle', () => {
  it('treats bare timestamps as non-descriptive', () => {
    expect(isDescriptiveTitle('2026-06-17 09:10:46')).toBe(false);
    expect(isDescriptiveTitle('2026_06_17_09_10_46')).toBe(false);
  });
  it('treats titled recordings as descriptive', () => {
    expect(isDescriptiveTitle('06-17 Lecture: Biology')).toBe(true);
    expect(isDescriptiveTitle('Переговоры')).toBe(true);
  });
  it('handles empty/missing', () => {
    expect(isDescriptiveTitle('')).toBe(false);
    expect(isDescriptiveTitle(undefined)).toBe(false);
    expect(isDescriptiveTitle('   ')).toBe(false);
  });
});

describe('dateStamp', () => {
  it('formats epoch ms as YYYY-MM-DD (UTC)', () => {
    expect(dateStamp(Date.UTC(2026, 5, 17, 9, 10))).toBe('2026-06-17');
  });
});
