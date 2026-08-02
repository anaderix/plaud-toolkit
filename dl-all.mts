import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

const outDir = process.argv[2] || 'audio';

const config = new PlaudConfig();
const creds = config.getCredentials();
const auth = new PlaudAuth(config);
const client = new PlaudClient(auth, creds?.apiBase ?? creds?.region ?? 'us');

fs.mkdirSync(outDir, { recursive: true });

const recs = await client.listRecordings();
console.log(`Found ${recs.length} recording(s). Saving audio to ${outDir}/`);

let ok = 0, skip = 0, fail = 0;
for (const rec of recs) {
  const date = new Date(rec.start_time).toISOString().slice(0, 10);
  const slug = (rec.filename || rec.id).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  try {
    const mp3Url = await client.getMp3Url(rec.id);
    let buf: Buffer;
    let ext: string;
    if (mp3Url) {
      const r = await fetch(mp3Url);
      buf = Buffer.from(await r.arrayBuffer());
      ext = 'mp3';
    } else {
      buf = Buffer.from(await client.downloadAudio(rec.id));
      ext = 'opus';
    }
    const fp = path.join(outDir, `${date}_${slug}.${ext}`);
    if (fs.existsSync(fp)) { skip++; console.log(`= skip ${path.basename(fp)}`); continue; }
    fs.writeFileSync(fp, buf);
    ok++;
    console.log(`✓ ${path.basename(fp)} (${(buf.length / 1024).toFixed(0)} KB)`);
  } catch (e: any) {
    fail++;
    console.log(`✗ ${rec.id} (${rec.filename}): ${e.message}`);
  }
}

console.log(`\nDone: ${ok} downloaded, ${skip} skipped, ${fail} failed.`);
