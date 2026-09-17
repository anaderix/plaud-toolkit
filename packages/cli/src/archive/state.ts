import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const StagesSchema = z.object({
  downloaded: z.boolean().default(false),
  prepared: z.boolean().default(false),
  transcribed: z.boolean().default(false),
  classified: z.boolean().default(false),
  summarized: z.boolean().default(false),
  /** Audio moved out to the long-term archive dir (e.g. a Google Drive mount). */
  archived: z.boolean().default(false),
});
export type Stages = z.infer<typeof StagesSchema>;

const RecordSchema = z.object({
  plaudId: z.string(),
  title: z.string().default(''),
  startTime: z.number().default(0),
  durationMs: z.number().default(0),
  outDir: z.string().nullable().default(null),
  audioFile: z.string().nullable().default(null),
  stages: StagesSchema.default({
    downloaded: false,
    prepared: false,
    transcribed: false,
    classified: false,
    summarized: false,
    archived: false,
  }),
  templateUsed: z.string().nullable().default(null),
  topicSlug: z.string().nullable().default(null),
  seeded: z.boolean().default(false),
  lastError: z.string().nullable().default(null),
  updatedAt: z.string().default(''),
  cost: z
    .object({
      transcribeUsd: z.number().default(0),
      summarizeUsd: z.number().default(0),
      seconds: z.number().default(0),
    })
    .default({ transcribeUsd: 0, summarizeUsd: 0, seconds: 0 }),
});
export type ArchiveRecord = z.infer<typeof RecordSchema>;

const StateSchema = z.object({
  version: z.literal(1).default(1),
  recordings: z.record(z.string(), RecordSchema).default({}),
});
export type ArchiveState = z.infer<typeof StateSchema>;

const STATE_FILE = '.plaud-archive-state.json';

export class StateStore {
  readonly filePath: string;
  private state: ArchiveState;

  /** @param stateDir directory the state file lives in (the audio dir). */
  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, STATE_FILE);
    this.state = this.read();
  }

  private read(): ArchiveState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return StateSchema.parse(raw);
    } catch {
      return StateSchema.parse({});
    }
  }

  /** Atomic write: temp file in the same dir, then rename. */
  private flush(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /** All known recording ids, in insertion order. */
  ids(): string[] {
    return Object.keys(this.state.recordings);
  }

  get(id: string): ArchiveRecord | undefined {
    return this.state.recordings[id];
  }

  /** A recording is fully done when it is both transcribed and summarized. */
  isDone(id: string): boolean {
    const r = this.state.recordings[id];
    return !!r && r.stages.transcribed && r.stages.summarized;
  }

  /** Create the record if missing; returns the (possibly new) record. */
  ensure(id: string, seed: Partial<ArchiveRecord>): ArchiveRecord {
    if (!this.state.recordings[id]) {
      this.state.recordings[id] = RecordSchema.parse({ plaudId: id, ...seed });
      this.flush();
    }
    return this.state.recordings[id];
  }

  /** Shallow-merge a patch into a record (stages/cost merge one level deep) and persist. */
  update(id: string, patch: Partial<ArchiveRecord>): ArchiveRecord {
    const cur = this.state.recordings[id] ?? RecordSchema.parse({ plaudId: id });
    const next: ArchiveRecord = {
      ...cur,
      ...patch,
      stages: { ...cur.stages, ...(patch.stages ?? {}) },
      cost: { ...cur.cost, ...(patch.cost ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    this.state.recordings[id] = next;
    this.flush();
    return next;
  }

  setStage(id: string, stage: keyof Stages, value = true): void {
    const cur = this.state.recordings[id];
    if (!cur) return;
    this.update(id, { stages: { ...cur.stages, [stage]: value } });
  }
}
