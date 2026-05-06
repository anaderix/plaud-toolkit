import { PlaudConfig } from './config.js';
import { BASE_URLS } from './types.js';
import type { PlaudTokenData } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface PlaudLoginInput {
  email: string;
  password: string;
  region: 'us' | 'eu';
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

  async login(input: PlaudLoginInput): Promise<string> {
    const baseUrl = BASE_URLS[input.region] ?? BASE_URLS['us'];
    const body = new URLSearchParams({
      username: input.email,
      password: input.password,
    });

    const res = await fetch(`${baseUrl}/auth/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      access_token: string;
      token_type: string;
    };

    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg || `Login failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(data.access_token);
    const tokenData: PlaudTokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveCredentials({ email: input.email, region: input.region });
    this.config.saveToken(tokenData);
    return data.access_token;
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
