import { PlaudConfig, PlaudAuth, TokenRejectedError } from '@plaud/core';
import type { PlaudTokenData } from '@plaud/core';

export const TOKEN_OK = 0;
export const TOKEN_EXPIRING = 1;
export const TOKEN_INVALID = 2;

export interface TokenStatus {
  code: number;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Classify a stored token by its expiry alone (no network). */
export function evaluateToken(
  token: PlaudTokenData | undefined,
  warnDays: number,
  now = Date.now(),
): TokenStatus {
  if (!token) {
    return { code: TOKEN_INVALID, message: 'No Plaud token stored. Run `plaud login`.' };
  }
  const expires = new Date(token.expiresAt).toLocaleString();
  const left = token.expiresAt - now;
  if (left <= 0) {
    return { code: TOKEN_INVALID, message: `Plaud token EXPIRED at ${expires}. Run \`plaud login\`.` };
  }
  const days = (left / DAY_MS).toFixed(1);
  if (left <= warnDays * DAY_MS) {
    return {
      code: TOKEN_EXPIRING,
      message: `Plaud token expires in ${days} days (${expires}). Run \`plaud login\` to refresh.`,
    };
  }
  return { code: TOKEN_OK, message: `Plaud token OK: expires in ${days} days (${expires}).` };
}

/**
 * Report token health via exit code so cron/Make can act on it:
 * 0 ok, 1 expiring within --warn-days, 2 missing/expired/rejected.
 */
export async function tokenStatusCommand(args: string[]): Promise<void> {
  const i = args.indexOf('--warn-days');
  const warnDays = i >= 0 ? Number(args[i + 1]) : 3;
  if (!Number.isFinite(warnDays) || warnDays < 0) {
    throw new Error(`--warn-days must be a non-negative number (got '${args[i + 1]}')`);
  }

  const config = new PlaudConfig();
  const status = evaluateToken(config.getToken(), warnDays);

  if (args.includes('--verify') && status.code !== TOKEN_INVALID) {
    try {
      await new PlaudAuth(config).verifyToken();
      status.message += ' Server accepted it.';
    } catch (err: any) {
      if (err instanceof TokenRejectedError) {
        status.code = TOKEN_INVALID;
        status.message = `Plaud REJECTED the token: ${err.message} Run \`plaud login\`.`;
      } else {
        // Couldn't reach Plaud: not evidence the token is bad, so keep the expiry verdict.
        status.message += ` (Server check failed: ${err?.message ?? err})`;
      }
    }
  }

  console.log(status.message);
  process.exitCode = status.code;
}
