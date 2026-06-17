import * as readline from 'readline';
import { PlaudConfig, PlaudAuth, BASE_URLS } from '@plaud/core';

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    const email = (await ask('Plaud email: ')).trim();
    const regionInput = await ask('Region (us/eu) [us]: ');
    const region = (regionInput.trim() || 'us') as 'us' | 'eu';

    const config = new PlaudConfig();
    const auth = new PlaudAuth(config);

    const session = await auth.requestLoginCode({ email, region });
    const expectedBase = BASE_URLS[region] ?? BASE_URLS['us'];
    if (session.apiBase !== expectedBase) {
      console.log(`Plaud routed your account to ${session.apiBase}.`);
    }
    console.log(`Verification code sent to ${email}.`);

    const code = (await ask('Verification code: ')).trim();
    await auth.submitLoginCode({ email, code, otpToken: session.otpToken, apiBase: session.apiBase });
    console.log('Login successful! Token valid for ~300 days.');
  } finally {
    rl.close();
  }
}
