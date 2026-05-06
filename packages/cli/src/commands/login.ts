import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

function readPasswordHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf-8');
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\n' || ch === '\r') {
            stdin.off('data', onData);
            stdin.pause();
            resolve(buf);
            return;
          }
          buf += ch;
        }
      };
      stdin.on('data', onData);
      return;
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '') {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          reject(new Error('Aborted'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch.charCodeAt(0) < 32) continue;
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  let email: string;
  let region: 'us' | 'eu';
  try {
    email = (await ask('Plaud email: ')).trim();
    const regionInput = await ask('Region (us/eu) [eu]: ');
    region = (regionInput.trim() || 'eu') as 'us' | 'eu';
  } finally {
    rl.close();
  }

  const password = await readPasswordHidden('Password: ');

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  await auth.login({ email, password, region });
  console.log('Login successful! Token valid for ~300 days.');
}
