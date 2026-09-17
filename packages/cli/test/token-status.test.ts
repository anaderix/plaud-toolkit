import { describe, it, expect } from 'vitest';
import { evaluateToken, TOKEN_OK, TOKEN_EXPIRING, TOKEN_INVALID } from '../src/commands/token-status.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-01T00:00:00Z');
const token = (expiresAt: number) => ({ accessToken: 'x', tokenType: 'Bearer', issuedAt: now, expiresAt });

describe('evaluateToken', () => {
  it('is OK when more than warnDays remain', () => {
    expect(evaluateToken(token(now + 20 * DAY), 3, now).code).toBe(TOKEN_OK);
  });

  it('flags a token expiring within warnDays', () => {
    const s = evaluateToken(token(now + 2 * DAY), 3, now);
    expect(s.code).toBe(TOKEN_EXPIRING);
    expect(s.message).toMatch(/expires in 2\.0 days.*plaud login/);
  });

  it('treats an expired token as invalid', () => {
    expect(evaluateToken(token(now - 1), 3, now).code).toBe(TOKEN_INVALID);
  });

  it('treats a missing token as invalid', () => {
    expect(evaluateToken(undefined, 3, now).code).toBe(TOKEN_INVALID);
  });
});
