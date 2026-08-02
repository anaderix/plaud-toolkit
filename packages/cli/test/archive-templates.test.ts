import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  renderClassifierList,
  pickTemplate,
  renderPrompt,
} from '../src/archive/templates.js';

const SAMPLE = `---
name: lecture
when_to_use: >
  A talk or seminar.
output_language: same_as_source
---
Summarize the lecture.

Transcript:
{{transcript}}`;

describe('parseTemplate', () => {
  it('parses frontmatter + body', () => {
    const t = parseTemplate(SAMPLE, '/x/lecture.md');
    expect(t.name).toBe('lecture');
    expect(t.whenToUse).toContain('talk or seminar');
    expect(t.outputLanguage).toBe('same_as_source');
    expect(t.body).toContain('{{transcript}}');
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseTemplate('no frontmatter here', '/x/bad.md')).toThrow(/frontmatter/);
  });

  it('throws when when_to_use is missing', () => {
    expect(() => parseTemplate('---\nname: x\n---\nbody', '/x/bad.md')).toThrow(/when_to_use/);
  });
});

describe('renderClassifierList', () => {
  it('renders one collapsed line per template', () => {
    const t = parseTemplate(SAMPLE, '/x/lecture.md');
    expect(renderClassifierList([t])).toBe('- lecture: A talk or seminar.');
  });
});

describe('pickTemplate', () => {
  const lecture = parseTemplate(SAMPLE, '/x/lecture.md');
  const generic = parseTemplate('---\nname: generic\nwhen_to_use: fallback\n---\nbody', '/x/generic.md');
  it('finds by name', () => {
    expect(pickTemplate([lecture, generic], 'lecture').name).toBe('lecture');
  });
  it('falls back to generic for unknown names', () => {
    expect(pickTemplate([lecture, generic], 'nope').name).toBe('generic');
  });
});

describe('renderPrompt', () => {
  it('substitutes the {{transcript}} placeholder', () => {
    const t = parseTemplate(SAMPLE, '/x/lecture.md');
    expect(renderPrompt(t, 'HELLO')).toContain('HELLO');
    expect(renderPrompt(t, 'HELLO')).not.toContain('{{transcript}}');
  });
  it('appends the transcript when there is no placeholder', () => {
    const t = parseTemplate('---\nname: x\nwhen_to_use: y\n---\nJust summarize.', '/x/x.md');
    const out = renderPrompt(t, 'BODYTEXT');
    expect(out).toContain('Just summarize.');
    expect(out).toContain('BODYTEXT');
  });
});
