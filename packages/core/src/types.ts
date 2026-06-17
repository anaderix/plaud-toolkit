export interface PlaudCredentials {
  email: string;
  /** Human-readable region label (e.g. 'us', 'eu', 'apac'), best-effort. */
  region: string;
  /**
   * Authoritative API base URL resolved during login (e.g.
   * 'https://api-apse1.plaud.ai'). Plaud routes accounts to one of several
   * regional hosts via a -302 redirect; this is the host that actually
   * answered. Clients should prefer this over `region`.
   */
  apiBase?: string;
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

/**
 * Plaud's API sits behind Cloudflare, which 403s requests whose User-Agent
 * looks like a bot — including Node's default `User-Agent: node`. Sending a
 * browser-like UA gets us through, matching what the Plaud web app does.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords: string[];
  serial_number: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary?: string;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}

export interface PlaudFolder {
  id: string;
  name: string;
  icon: string;
  color: string;
}

export interface PlaudSearchHit {
  id: string;
  title: string;
  workspace_id?: string;
  owner_member_id?: string;
}

export interface PlaudSearchResult {
  size: number;
  query: string;
  hits: PlaudSearchHit[];
  keywords: string[];
}

export interface PlaudMergeTask {
  task_id: string;
  /**
   * Observed values: `'pending'`, `'success'`, `'failed'`. The HAR doc said
   * the terminal-success state was `'completed'` but live testing showed it's
   * actually `'success'`. Treat both as terminal-ok in clients that depend
   * on documentation rather than empirical observation.
   */
  status: 'pending' | 'running' | 'success' | 'completed' | 'failed' | string;
  progress?: number;
  source_file_ids?: string[];
  start_time?: number;
  end_time?: number;
  error_message?: string;
  /**
   * Populated once the merge finishes (status === 'success'). The new merged
   * file's full metadata — id, filename, filesize, duration, edit_from
   * ("combine"), serial_number, etc. To poll cleanly: keep calling getMergeTask
   * until status is one of {success, completed, failed}.
   */
  file?: { id: string; filename?: string; edit_from?: string; [k: string]: unknown };
}

export interface PlaudCustomTemplate {
  id: string;
  name: string;
  content: string;
  is_locked?: number;
  note_tab_name?: string;
  voiceprint_options?: number;
}

export type PlaudTemplateType = 'official' | 'community' | 'custom';

export interface PlaudShareContentConfig {
  audio: boolean;
  transcript: boolean;
  /** Auto-generated Summary tab + any template-applied tabs, encoded as
   *  "auto_sum:<workspace_short>:<file_id>" or
   *  "sum_multi:<workspace_short>:<file_id>:<note_id>" entries. */
  notes: string[];
  /** Vestigial — observed as false regardless of UI state. notes[] is source of truth. */
  overview?: boolean;
  /** Vestigial — observed as 0 regardless of UI state. */
  highlights?: number;
}

export interface PlaudPublicShare {
  object_id: string;
  object_type: string;
  share_key: string;
  share_url: string;
  share_type: string;
  expire_at: string | null;
  content_config: PlaudShareContentConfig;
  created_at: string;
}
