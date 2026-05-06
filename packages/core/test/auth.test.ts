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

  it('login() persists token and credentials only on success', async () => {
    const fakeToken = makeJwt(300 * 86400);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    const token = await auth.login({ email: 'test@plaud.ai', password: 'pass123', region: 'eu' });
    expect(token).toBe(fakeToken);
    expect(config.getToken()?.accessToken).toBe(fakeToken);
    expect(config.getCredentials()?.email).toBe('test@plaud.ai');
    expect(config.getCredentials()?.region).toBe('eu');
  });

  it('login() does not persist password to disk', async () => {
    const fakeToken = makeJwt(300 * 86400);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    await auth.login({ email: 'test@plaud.ai', password: 'super-secret-password', region: 'eu' });

    const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
    expect(raw).not.toContain('super-secret-password');
    expect(raw).not.toContain('password');
  });

  it('login() does not persist anything on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password', access_token: '' }),
    });

    await expect(
      auth.login({ email: 'test@plaud.ai', password: 'wrong', region: 'eu' })
    ).rejects.toThrow('wrong account or password');

    expect(config.getToken()).toBeUndefined();
    expect(config.getCredentials()).toBeUndefined();
  });

  it('getToken() returns cached token when still valid', async () => {
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

  it('getToken() throws when no token stored (instructs to login)', async () => {
    await expect(auth.getToken()).rejects.toThrow(/plaud login/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('getToken() throws when token is expired (no auto-refresh)', async () => {
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
