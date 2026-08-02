import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

// Usage: npx tsx rename-audio.mts <audioDir> [--apply]
const audioDir = process.argv[2] || 'audio';
const apply = process.argv.includes('--apply');

const audioSlug = (name: string) =>
  name.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const dateStamp = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const config = new PlaudConfig();
const creds = config.getCredentials();
const client = new PlaudClient(new PlaudAuth(config), creds?.apiBase ?? creds?.region ?? 'us');

const recs = await client.listRecordings();
let renamed = 0, already = 0;
const known = new Set<string>();

for (const rec of recs) {
  const date = dateStamp(rec.start_time);
  const slug = audioSlug(rec.filename || rec.id);
  const oldBase = `${date}_${slug}`;
  const newBase = `${rec.id}_${date}_${slug}`;
  for (const ext of ['mp3', 'opus']) {
    known.add(`${newBase}.${ext}`);
    known.add(`${oldBase}.${ext}`); // accounted for (will be / was renamed)
    const oldP = path.join(audioDir, `${oldBase}.${ext}`);
    const newP = path.join(audioDir, `${newBase}.${ext}`);
    if (fs.existsSync(newP)) { already++; continue; }
    if (fs.existsSync(oldP)) {
      console.log(`${apply ? 'RENAME' : 'would rename'}: ${oldBase}.${ext}  ->  ${newBase}.${ext}`);
      if (apply) fs.renameSync(oldP, newP);
      renamed++;
    }
  }
}

const leftover = fs.existsSync(audioDir)
  ? fs.readdirSync(audioDir).filter(f => /\.(mp3|opus)$/.test(f) && !known.has(f))
  : [];
if (leftover.length) console.log(`\nUnmatched (left as-is): ${leftover.join(', ')}`);
console.log(`\n${apply ? 'Done' : 'DRY RUN'}: ${renamed} ${apply ? 'renamed' : 'to rename'}, ${already} already new-style, ${leftover.length} unmatched.`);
if (!apply) console.log('Re-run with --apply to perform the rename.');
