export interface PlaudCredentials {
  email: string;
  region: 'us' | 'eu';
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
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  progress?: number;
  source_file_ids?: string[];
  start_time?: number;
  end_time?: number;
  error_message?: string;
  /** Populated only once status === 'completed'. The new merged file's metadata. */
  file?: { id: string; filename?: string; [k: string]: unknown };
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
