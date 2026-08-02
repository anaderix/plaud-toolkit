import { describe, it, expect } from 'vitest';
import {
  groupWordsIntoTurns,
  renderTurns,
  parseElevenLabsResponse,
} from '../src/archive/transcriber.js';

describe('groupWordsIntoTurns', () => {
  it('groups consecutive words per speaker and labels 1..N in first-seen order', () => {
    const words = [
      { text: 'Hello', type: 'word', speaker_id: 'speaker_0', start: 0, end: 0.5 },
      { text: ' ', type: 'spacing', speaker_id: 'speaker_0' },
      { text: 'there', type: 'word', speaker_id: 'speaker_0', end: 1.0 },
      { text: 'Hi', type: 'word', speaker_id: 'speaker_1', start: 1.2, end: 1.6 },
      { text: 'again', type: 'word', speaker_id: 'speaker_0', start: 2.0, end: 2.4 },
    ];
    const turns = groupWordsIntoTurns(words);
    expect(turns.map(t => t.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
    expect(turns[0].text).toBe('Hello there');
    expect(turns[1].text).toBe('Hi');
    expect(turns[2].text).toBe('again');
  });

  it('defaults missing speaker_id to a single speaker', () => {
    const turns = groupWordsIntoTurns([{ text: 'a' }, { text: ' ' }, { text: 'b' }]);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBe('Speaker 1');
    expect(turns[0].text).toBe('a b');
  });
});

describe('renderTurns', () => {
  const turns = [
    { speaker: 'Speaker 1', text: 'hello' },
    { speaker: 'Speaker 2', text: 'hi' },
  ];
  it('plain form', () => {
    expect(renderTurns(turns)).toBe('Speaker 1: hello\n\nSpeaker 2: hi');
  });
  it('markdown bold form', () => {
    expect(renderTurns(turns, true)).toBe('**Speaker 1:** hello\n\n**Speaker 2:** hi');
  });
});

describe('parseElevenLabsResponse', () => {
  it('produces labeled turns + speaker count when diarized', () => {
    const r = parseElevenLabsResponse({
      language_code: 'ru',
      text: 'ignored',
      words: [
        { text: 'Привет', speaker_id: 'speaker_0' },
        { text: 'Hello', speaker_id: 'speaker_1' },
      ],
    });
    expect(r.speakerCount).toBe(2);
    expect(r.turns).toHaveLength(2);
    expect(r.text).toBe('Speaker 1: Привет\n\nSpeaker 2: Hello');
    expect(r.language).toBe('ru');
  });

  it('falls back to plain text when no diarization present', () => {
    const r = parseElevenLabsResponse({ text: 'just text', words: [{ text: 'just' }] });
    expect(r.turns).toBeUndefined();
    expect(r.text).toBe('just text');
  });

  it('handles an empty/plain response', () => {
    const r = parseElevenLabsResponse({ text: '  hi  ' });
    expect(r.turns).toBeUndefined();
    expect(r.text).toBe('hi');
  });
});
