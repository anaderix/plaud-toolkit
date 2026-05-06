import { PlaudConfig } from './config.js';
import { BASE_URLS } from './types.js';
import type { PlaudTokenData } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface PlaudOtpRequest {
  email: string;
  region: 'us' | 'eu';
}

export interface PlaudOtpSession {
  /** Short-lived JWT returned by /auth/otp-send-code, passed back to /auth/otp-login. */
  otpToken: string;
  /** Resolved region after possible -302 region redirect. May differ from caller's input. */
  region: 'us' | 'eu';
}

export interface PlaudOtpSubmit {
  email: string;
  code: string;
  otpToken: string;
  region: 'us' | 'eu';
}

function regionFromHostname(host: string): 'us' | 'eu' {
  return host.includes('euc1') ? 'eu' : 'us';
}

export class PlaudAuth {
  private config: PlaudConfig;

  constructor(config: PlaudConfig) {
    this.config = config;
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken();
    if (!cached) {
      throw new Error('Not logged in. Run `plaud login` first.');
    }
    if (this.isExpiringSoon(cached)) {
      throw new Error('Token has expired or is expiring soon. Run `plaud login` to refresh.');
    }
    return cached.accessToken;
  }

  /**
   * Step 1 of OTP login: ask Plaud to email a verification code.
   * Returns a short-lived OTP session token plus the resolved region
   * (which may differ from input if Plaud redirects to another regional
   * server via status -302).
   */
  async requestLoginCode(input: PlaudOtpRequest, _redirects = 0): Promise<PlaudOtpSession> {
    const baseUrl = BASE_URLS[input.region] ?? BASE_URLS['us'];
    const res = await fetch(`${baseUrl}/auth/otp-send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: input.email }),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      token?: string;
      data?: { domains?: { api?: string } };
    };

    if (data.status === -302 && data.data?.domains?.api) {
      if (_redirects >= 2) {
        throw new Error('Plaud kept redirecting between regions; aborting.');
      }
      const redirectedRegion = regionFromHostname(data.data.domains.api);
      return this.requestLoginCode({ email: input.email, region: redirectedRegion }, _redirects + 1);
    }

    if (data.status !== 0 || !data.token) {
      throw new Error(data.msg || `Failed to send verification code (status ${data.status})`);
    }

    return { otpToken: data.token, region: input.region };
  }

  /**
   * Step 2 of OTP login: submit the emailed code with the session token,
   * persist email+region+access token on success.
   */
  async submitLoginCode(input: PlaudOtpSubmit): Promise<string> {
    const baseUrl = BASE_URLS[input.region] ?? BASE_URLS['us'];
    const res = await fetch(`${baseUrl}/auth/otp-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.code, token: input.otpToken }),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      access_token?: string;
      token_type?: string;
      data?: { access_token?: string };
    };

    const accessToken = data.access_token ?? data.data?.access_token;
    if (!accessToken) {
      throw new Error(data.msg || `Verification failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(accessToken);
    const tokenData: PlaudTokenData = {
      accessToken,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveCredentials({ email: input.email, region: input.region });
    this.config.saveToken(tokenData);
    return accessToken;
  }

  private isExpiringSoon(token: PlaudTokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
