import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface MeetingTemplate {
  name: string;
  whenToUse: string;
  outputLanguage?: string;
  model?: string;
  /** Prompt body; may contain the literal placeholder {{transcript}}. */
  body: string;
  filePath: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse one template markdown file (YAML frontmatter + prompt body). */
export function parseTemplate(raw: string, filePath: string): MeetingTemplate {
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`Template ${filePath} is missing YAML frontmatter (--- ... ---).`);
  const meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const name = String(meta.name ?? path.basename(filePath, '.md')).trim();
  const whenToUse = String(meta.when_to_use ?? '').trim();
  const body = m[2].trim();
  if (!whenToUse) throw new Error(`Template ${filePath} is missing 'when_to_use'.`);
  if (!body) throw new Error(`Template ${filePath} has an empty prompt body.`);
  return {
    name,
    whenToUse,
    outputLanguage: meta.output_language ? String(meta.output_language) : undefined,
    model: meta.model ? String(meta.model) : undefined,
    body,
    filePath,
  };
}

export function loadTemplates(dir: string): MeetingTemplate[] {
  if (!fs.existsSync(dir)) throw new Error(`Templates dir not found: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error(`No template .md files in ${dir}`);
  return files.map(f => parseTemplate(fs.readFileSync(path.join(dir, f), 'utf-8'), path.join(dir, f)));
}

/** Bullet list of "name: when_to_use" lines for the classifier prompt. */
export function renderClassifierList(templates: MeetingTemplate[]): string {
  return templates.map(t => `- ${t.name}: ${t.whenToUse.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** Find a template by name, falling back to 'generic' (or the first) if absent. */
export function pickTemplate(templates: MeetingTemplate[], name: string): MeetingTemplate {
  return (
    templates.find(t => t.name === name) ??
    templates.find(t => t.name === 'generic') ??
    templates[0]
  );
}

/** Insert the transcript into the template body (placeholder or appended). */
export function renderPrompt(template: MeetingTemplate, transcript: string): string {
  if (template.body.includes('{{transcript}}')) {
    return template.body.replaceAll('{{transcript}}', transcript);
  }
  return `${template.body}\n\nTranscript:\n${transcript}`;
}
