import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth } from '../src/auth.js';
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
        json: async () => ({ status: 0, token: 'otp-session-jwt' }),
      });

      const session = await auth.requestLoginCode({ email: 'test@plaud.ai', region: 'eu' });
      expect(session.otpToken).toBe('otp-session-jwt');
      expect(session.region).toBe('eu');
    });

    it('follows a -302 region redirect and reports the resolved region', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: -302, data: { domains: { api: 'https://api-euc1.plaud.ai' } } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 0, token: 'otp-jwt-after-redirect' }),
      });

      const session = await auth.requestLoginCode({ email: 'test@plaud.ai', region: 'us' });
      expect(session.region).toBe('eu');
      expect(session.otpToken).toBe('otp-jwt-after-redirect');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws when send-code returns a non-zero status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: -1, msg: 'email not found' }),
      });

      await expect(
        auth.requestLoginCode({ email: 'nobody@plaud.ai', region: 'eu' })
      ).rejects.toThrow('email not found');
    });
  });

  describe('submitLoginCode', () => {
    it('persists token + credentials on success and never writes the OTP code', async () => {
      const fakeToken = makeJwt(300 * 86400);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
      });

      const token = await auth.submitLoginCode({
        email: 'test@plaud.ai',
        code: '123456',
        otpToken: 'otp-session',
        region: 'eu',
      });
      expect(token).toBe(fakeToken);
      expect(config.getToken()?.accessToken).toBe(fakeToken);
      expect(config.getCredentials()?.email).toBe('test@plaud.ai');
      expect(config.getCredentials()?.region).toBe('eu');

      const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
      expect(raw).not.toContain('123456');
      expect(raw).not.toContain('otp-session');
    });

    it('accepts access_token nested under data', async () => {
      const fakeToken = makeJwt(300 * 86400);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 0, data: { access_token: fakeToken } }),
      });

      const token = await auth.submitLoginCode({
        email: 'test@plaud.ai',
        code: '123456',
        otpToken: 'otp-session',
        region: 'eu',
      });
      expect(token).toBe(fakeToken);
    });

    it('persists nothing on a wrong-code response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: -2, msg: 'invalid verification code' }),
      });

      await expect(
        auth.submitLoginCode({
          email: 'test@plaud.ai',
          code: '000000',
          otpToken: 'otp-session',
          region: 'eu',
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
});
