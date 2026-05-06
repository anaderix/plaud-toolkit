import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

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
    if (session.region !== region) {
      console.log(`Plaud redirected to the ${session.region.toUpperCase()} region.`);
    }
    console.log(`Verification code sent to ${email}.`);

    const code = (await ask('Verification code: ')).trim();
    await auth.submitLoginCode({ email, code, otpToken: session.otpToken, region: session.region });
    console.log('Login successful! Token valid for ~300 days.');
  } finally {
    rl.close();
  }
}
