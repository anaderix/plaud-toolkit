import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth, tokenExpiryWarning } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeJwt(expSecondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp, iat })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

describe('PlaudAuth', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-'));
    config = new PlaudConfig(tmpDir);
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('requestLoginCode', () => {
    it('returns the OTP token from a successful send-code response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, token: 'otp-session-jwt' }),
      });

      const session = await auth.requestLoginCode({ email: 'test@plaud.ai', region: 'eu' });
      expect(session.otpToken).toBe('otp-session-jwt');
      expect(session.apiBase).toBe('https://api-euc1.plaud.ai');
    });

    it('follows a -302 redirect to the server-provided host', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: -302, data: { domains: { api: 'https://api-euc1.plaud.ai' } } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, token: 'otp-jwt-after-redirect' }),
      });

      const session = await auth.requestLoginCode({ email: 'test@plaud.ai', region: 'us' });
      expect(session.apiBase).toBe('https://api-euc1.plaud.ai');
      expect(session.otpToken).toBe('otp-jwt-after-redirect');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // second attempt must hit the redirected host, not a remapped us/eu host
      expect(mockFetch.mock.calls[1][0]).toBe('https://api-euc1.plaud.ai/auth/otp-send-code');
    });

    it('follows a -302 redirect to a region outside us/eu (e.g. apse1)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: -302, data: { domains: { api: 'https://api-apse1.plaud.ai' } } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, token: 'apac-otp' }),
      });

      const session = await auth.requestLoginCode({ email: 'asia@plaud.ai', region: 'us' });
      expect(session.apiBase).toBe('https://api-apse1.plaud.ai');
      expect(session.otpToken).toBe('apac-otp');
      expect(mockFetch.mock.calls[1][0]).toBe('https://api-apse1.plaud.ai/auth/otp-send-code');
    });

    it('throws a clear error when the server returns a non-JSON (HTML) page', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '<!DOCTYPE html><html><head><title>404</title></head></html>',
      });

      await expect(
        auth.requestLoginCode({ email: 'test@plaud.ai', region: 'us' })
      ).rejects.toThrow(/non-JSON response/);
    });

    it('throws when send-code returns a non-zero status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: -1, msg: 'email not found' }),
      });

      await expect(
        auth.requestLoginCode({ email: 'nobody@plaud.ai', region: 'eu' })
      ).rejects.toThrow('email not found');
    });
  });

  describe('submitLoginCode', () => {
    it('persists token + credentials (incl. apiBase) on success and never writes the OTP code', async () => {
      const fakeToken = makeJwt(300 * 86400);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
      });

      const token = await auth.submitLoginCode({
        email: 'test@plaud.ai',
        code: '123456',
        otpToken: 'otp-session',
        apiBase: 'https://api-euc1.plaud.ai',
      });
      expect(token).toBe(fakeToken);
      expect(config.getToken()?.accessToken).toBe(fakeToken);
      expect(config.getCredentials()?.email).toBe('test@plaud.ai');
      expect(config.getCredentials()?.region).toBe('eu');
      expect(config.getCredentials()?.apiBase).toBe('https://api-euc1.plaud.ai');

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      expect(raw).not.toContain('123456');
      expect(raw).not.toContain('otp-session');
    });

    it('labels a non-us/eu host (apse1) as apac and stores its apiBase', async () => {
      const fakeToken = makeJwt(300 * 86400);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, access_token: fakeToken }),
      });

      await auth.submitLoginCode({
        email: 'asia@plaud.ai',
        code: '123456',
        otpToken: 'otp-session',
        apiBase: 'https://api-apse1.plaud.ai',
      });
      expect(config.getCredentials()?.region).toBe('apac');
      expect(config.getCredentials()?.apiBase).toBe('https://api-apse1.plaud.ai');
      expect(mockFetch.mock.calls[0][0]).toBe('https://api-apse1.plaud.ai/auth/otp-login');
    });

    it('accepts access_token nested under data', async () => {
      const fakeToken = makeJwt(300 * 86400);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 0, data: { access_token: fakeToken } }),
      });

      const token = await auth.submitLoginCode({
        email: 'test@plaud.ai',
        code: '123456',
        otpToken: 'otp-session',
        apiBase: 'https://api-euc1.plaud.ai',
      });
      expect(token).toBe(fakeToken);
    });

    it('persists nothing on a wrong-code response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: -2, msg: 'invalid verification code' }),
      });

      await expect(
        auth.submitLoginCode({
          email: 'test@plaud.ai',
          code: '000000',
          otpToken: 'otp-session',
          apiBase: 'https://api-euc1.plaud.ai',
        })
      ).rejects.toThrow('invalid verification code');

      expect(config.getToken()).toBeUndefined();
      expect(config.getCredentials()).toBeUndefined();
    });
  });

  describe('getToken', () => {
    it('returns the cached token when still valid', async () => {
      const fakeToken = makeJwt(300 * 86400);
      config.saveToken({
        accessToken: fakeToken,
        tokenType: 'Bearer',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300 * 86400 * 1000,
      });

      const token = await auth.getToken();
      expect(token).toBe(fakeToken);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when no token stored', async () => {
      await expect(auth.getToken()).rejects.toThrow(/plaud login/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when token is expired (no auto-refresh)', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 1000;
      const expiredToken = makeJwt(-1000);
      config.saveToken({
        accessToken: expiredToken,
        tokenType: 'Bearer',
        issuedAt: (pastExp - 86400) * 1000,
        expiresAt: pastExp * 1000,
      });

      await expect(auth.getToken()).rejects.toThrow(/expir/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('tokenExpiryWarning', () => {
    const DAY = 86400 * 1000;
    const now = Date.parse('2026-10-01T00:00:00Z');

    it('is silent when more than 3 days remain', () => {
      expect(tokenExpiryWarning(now + 30 * DAY, now)).toBeUndefined();
      expect(tokenExpiryWarning(now + 3 * DAY + 1000, now)).toBeUndefined();
    });

    it('warns with days and hours when within 3 days', () => {
      expect(tokenExpiryWarning(now + 2 * DAY + 5 * 3600 * 1000, now)).toMatch(/expires in 2d 5h.*plaud login/);
    });

    it('warns in hours when under a day', () => {
      expect(tokenExpiryWarning(now + 7 * 3600 * 1000, now)).toMatch(/expires in 7h/);
    });

    it('leaves already-expired tokens to getToken()', () => {
      expect(tokenExpiryWarning(now - 1000, now)).toBeUndefined();
    });
  });
});
