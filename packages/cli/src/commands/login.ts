import * as readline from 'readline';
import { PlaudConfig, PlaudAuth, BASE_URLS } from '@plaud/core';

export async function loginCommand(args: string[]): Promise<void> {
  if (args.includes('--token')) {
    return tokenLoginCommand(args);
  }

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

/**
 * Log in with an existing Plaud bearer token (e.g. from the web app at
 * app.plaud.ai). Needed for accounts created via Google/Apple sign-in, which
 * the email-OTP flow can't reach. To find the token: open app.plaud.ai while
 * logged in → DevTools → Network → click any request to api*.plaud.ai → copy
 * the value after "Bearer " in the Authorization request header.
 *
 * The token can be supplied non-interactively (in priority order):
 *   1. as an argument:   plaud login --token <TOKEN>
 *   2. via env var:      PLAUD_TOKEN=<TOKEN> plaud login --token
 *   3. piped on stdin:   echo "<TOKEN>" | plaud login --token
 * Prefer the env var or stdin — a token passed as an argument is visible to
 * other users via the process list. Falls back to an interactive prompt only
 * when nothing is supplied and stdin is a TTY.
 */
async function tokenLoginCommand(args: string[]): Promise<void> {
  const token = (await resolveToken(args)).trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new Error(
      'No token provided. Pass it as `login --token <TOKEN>`, set PLAUD_TOKEN, or pipe it on stdin.'
    );
  }

  const config = new PlaudConfig();
  const auth = new PlaudAuth(config);
  const creds = await auth.saveAccessToken(token);

  const who = creds.email || 'your account';
  console.log(`Saved. Logged in as ${who} on ${creds.apiBase}.`);
}

/** Resolve the token from arg → env → stdin → interactive prompt. */
async function resolveToken(args: string[]): Promise<string> {
  const flagIdx = args.indexOf('--token');
  const argToken = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
  if (argToken && !argToken.startsWith('-')) {
    return argToken;
  }

  if (process.env.PLAUD_TOKEN) {
    return process.env.PLAUD_TOKEN;
  }

  // Non-TTY stdin → read the piped token.
  if (!process.stdin.isTTY) {
    return readAllStdin();
  }

  // Interactive fallback.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      'Paste a Plaud access token from your browser session at app.plaud.ai.\n' +
      'DevTools → Network → any request to api*.plaud.ai → Authorization header\n' +
      '(the part after "Bearer ").\n'
    );
    return await new Promise<string>(resolve => rl.question('Access token: ', resolve));
  } finally {
    rl.close();
  }
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
