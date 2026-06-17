import * as crypto from 'crypto';
import { PlaudAuth } from './auth.js';
import { BASE_URLS, DEFAULT_USER_AGENT } from './types.js';
import type {
  PlaudRecording,
  PlaudRecordingDetail,
  PlaudUserInfo,
  PlaudFolder,
  PlaudSearchHit,
  PlaudSearchResult,
  PlaudMergeTask,
  PlaudCustomTemplate,
  PlaudTemplateType,
  PlaudPublicShare,
  PlaudShareContentConfig,
} from './types.js';

function defaultWebHeaders(): Record<string, string> {
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    'x-device-id': '[object Object]',
    'app-platform': 'web',
    'app-language': 'en',
    'X-Request-ID': crypto.randomBytes(8).toString('hex'),
  };
}

export class PlaudClient {
  private auth: PlaudAuth;
  private apiBase: string;

  /**
   * @param regionOrBase Either a region key ('us'/'eu') or a full API base URL
   *   (e.g. 'https://api-apse1.plaud.ai'). Prefer passing the `apiBase` stored
   *   in credentials so accounts outside us/eu reach the right host.
   */
  constructor(auth: PlaudAuth, regionOrBase: string = 'us') {
    this.auth = auth;
    this.apiBase = regionOrBase.startsWith('http')
      ? regionOrBase
      : (BASE_URLS[regionOrBase] ?? BASE_URLS['us']);
  }

  private get baseUrl(): string {
    return this.apiBase;
  }

  private async request(path: string, options?: RequestInit, _redirects = 0): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...defaultWebHeaders(),
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 500) : ''}`);
    }

    const data = await res.json();

    if (data?.status === -302 && data?.data?.domains?.api) {
      if (_redirects >= 2) {
        throw new Error('Plaud kept redirecting between regions; aborting.');
      }
      this.apiBase = data.data.domains.api;
      return this.request(path, options, _redirects + 1);
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { Authorization: `Bearer ${token}`, ...defaultWebHeaders() },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=0`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }

  async listFolders(): Promise<PlaudFolder[]> {
    const data = await this.request('/filetag/');
    return (data?.data_filetag_list ?? []) as PlaudFolder[];
  }

  async search(query: string): Promise<PlaudSearchResult> {
    const data = await this.request('/gsearch/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    const result = data?.data ?? {};
    return {
      size: result.size ?? 0,
      query: result.query ?? query,
      hits: (result.list ?? []).map((h: any) => ({
        id: h.id,
        title: h.title,
        workspace_id: h.workspace_id,
        owner_member_id: h.owner_member_id,
      })) as PlaudSearchHit[],
      keywords: result.keywords ?? [],
    };
  }

  async moveToFolder(fileIds: string[], folderId: string): Promise<void> {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new Error('moveToFolder: fileIds must be a non-empty array');
    }
    await this.request('/file/update-tags', {
      method: 'POST',
      body: JSON.stringify({ file_id_list: fileIds, filetag_id: folderId }),
    });
  }

  async clearFolder(fileIds: string[]): Promise<void> {
    return this.moveToFolder(fileIds, '');
  }

  async renameRecording(id: string, newName: string): Promise<void> {
    if (!newName || typeof newName !== 'string') {
      throw new Error('renameRecording: newName must be a non-empty string');
    }
    await this.request(`/file/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ filename: newName }),
    });
  }

  async trashRecordings(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('trashRecordings: ids must be a non-empty array');
    }
    await this.request('/file/trash/', {
      method: 'POST',
      body: JSON.stringify(ids),
    });
  }

  async restoreRecordings(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('restoreRecordings: ids must be a non-empty array');
    }
    await this.request('/file/untrash/', {
      method: 'POST',
      body: JSON.stringify(ids),
    });
  }

  /**
   * Merge two or more recordings into a new audio file. Source files are
   * preserved (not deleted). The merge runs async — poll getMergeTask(task_id)
   * until status === 'completed' for the new file's id.
   *
   * file_ids order = concatenation order. Sort by start_time ascending or
   * the audio plays out of sequence.
   */
  async mergeRecordings(fileIds: string[], filename: string): Promise<{ task_id: string }> {
    if (!Array.isArray(fileIds) || fileIds.length < 2) {
      throw new Error('mergeRecordings: need at least 2 file ids to merge');
    }
    if (!filename || typeof filename !== 'string') {
      throw new Error('mergeRecordings: filename must be a non-empty string');
    }
    const data = await this.request('/file/combine', {
      method: 'POST',
      body: JSON.stringify({ file_ids: fileIds, filename }),
    });
    const taskId = data?.task_id ?? data?.data?.task_id;
    if (!taskId) {
      throw new Error(`mergeRecordings: no task_id in response: ${JSON.stringify(data)}`);
    }
    return { task_id: taskId };
  }

  async getMergeTask(taskId: string): Promise<PlaudMergeTask> {
    const data = await this.request(`/file/combine-tasks/${taskId}`);
    const t = data?.data ?? data;
    return {
      task_id: t.task_id ?? taskId,
      status: t.status,
      progress: t.progress,
      source_file_ids: t.source_file_ids,
      start_time: t.start_time,
      end_time: t.end_time,
      error_message: t.error_message,
      file: t.file,
    };
  }

  async listRunningMerges(): Promise<PlaudMergeTask[]> {
    const data = await this.request('/file/combine/running-tasks');
    return (data?.data ?? []) as PlaudMergeTask[];
  }

  // ── Custom templates (your private summary prompts) ───────────────────────

  async listCustomTemplates(): Promise<PlaudCustomTemplate[]> {
    const data = await this.request('/ai/customtemplates');
    return (data?.data ?? []) as PlaudCustomTemplate[];
  }

  async createCustomTemplate(input: { name: string; content: string }): Promise<PlaudCustomTemplate> {
    if (!input?.name || !input?.content) {
      throw new Error('createCustomTemplate: name and content are required');
    }
    const data = await this.request('/ai/customtemplates', {
      method: 'POST',
      body: JSON.stringify({ name: input.name, content: input.content }),
    });
    return (data?.data ?? data) as PlaudCustomTemplate;
  }

  async updateCustomTemplate(
    id: string,
    patch: { name?: string; content?: string },
  ): Promise<PlaudCustomTemplate> {
    if (!id) throw new Error('updateCustomTemplate: id is required');
    const data = await this.request(`/ai/customtemplates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return (data?.data ?? data) as PlaudCustomTemplate;
  }

  async deleteCustomTemplate(id: string): Promise<void> {
    if (!id) throw new Error('deleteCustomTemplate: id is required');
    await this.request(`/ai/customtemplates/${id}`, { method: 'DELETE' });
  }

  // ── Apply template to a recording (non-destructive — adds a new tab) ──────

  /**
   * Apply a template to a recording, generating a new summary tab. Async — Plaud
   * runs the AI in the background and the new tab appears in /file/detail/{id}'s
   * content_list once `task_status` flips to 1. Poll /ai/file-task-status to
   * monitor progress.
   *
   * **Non-destructive** — unlike `/ai/transsumm/{id}` with `is_reload:1`, this
   * only adds; it does not wipe existing tabs.
   */
  async applyTemplate(
    fileId: string,
    opts: {
      templateId: string;
      templateType: PlaudTemplateType;
      tabName: string;
      info?: string;
    },
  ): Promise<{ note_id?: string; status: number; msg?: string; raw: any }> {
    if (!fileId) throw new Error('applyTemplate: fileId is required');
    if (!opts?.templateId || !opts?.templateType || !opts?.tabName) {
      throw new Error('applyTemplate: templateId, templateType, and tabName are required');
    }
    // post_id is a client-generated millisecond timestamp (the API stores it
    // back as `extra.ori_post_id` on the resulting note), NOT a template id.
    // The HAR doc says "<template id>" but the server validates it as int.
    // The actual template id goes in `summ_type`.
    const data = await this.request(`/ai/sum_new_note/${fileId}`, {
      method: 'POST',
      body: JSON.stringify({
        post_id: Date.now(),
        summ_type: opts.templateId,
        summ_type_type: opts.templateType,
        info: opts.info ?? '',
        ppc_status: 0,
        tab_name: opts.tabName,
      }),
    });
    return {
      note_id: data?.data?.note_id,
      status: data?.status,
      msg: data?.msg,
      raw: data,
    };
  }

  /**
   * Delete a template-generated tab (or any note) from a recording. Pair with
   * applyTemplate for a clean undo. note_id matches the `data_id` of the
   * content_list entry on the file detail.
   */
  async deleteNote(input: { noteId: string; noteType: string; noteContent?: string }): Promise<void> {
    if (!input?.noteId || !input?.noteType) {
      throw new Error('deleteNote: noteId and noteType are required');
    }
    await this.request('/ai/del_note_info', {
      method: 'POST',
      body: JSON.stringify({
        note_id: input.noteId,
        note_type: input.noteType,
        note_content: input.noteContent ?? '',
      }),
    });
  }

  // ── Folder CRUD ───────────────────────────────────────────────────────────

  async createFolder(input: { name: string; icon?: string; color?: string }): Promise<PlaudFolder> {
    if (!input?.name) throw new Error('createFolder: name is required');
    const data = await this.request('/filetag/', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        icon: input.icon ?? '',
        color: input.color ?? '',
      }),
    });
    return (data?.data_filetag ?? data?.data ?? data) as PlaudFolder;
  }

  async updateFolder(
    id: string,
    patch: { name: string; icon: string; color: string },
  ): Promise<PlaudFolder> {
    if (!id) throw new Error('updateFolder: id is required');
    if (!patch?.name) throw new Error('updateFolder: name is required (PATCH expects all three fields together)');
    const data = await this.request(`/filetag/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: patch.name,
        icon: patch.icon,
        color: patch.color,
      }),
    });
    return (data?.data_filetag ?? data?.data ?? data) as PlaudFolder;
  }

  async deleteFolder(id: string): Promise<void> {
    if (!id) throw new Error('deleteFolder: id is required');
    await this.request(`/filetag/${id}`, { method: 'DELETE' });
  }

  // ── Public share CRUD ─────────────────────────────────────────────────────

  /**
   * Read the current public-share state for a file. Returns null when no share
   * exists (server returns `status: 40400` "Public share not found" — handled here).
   */
  async getPublicShare(fileId: string): Promise<PlaudPublicShare | null> {
    if (!fileId) throw new Error('getPublicShare: fileId is required');
    const data = await this.request('/share/public/get', {
      method: 'POST',
      body: JSON.stringify({ object_id: fileId, object_type: 'file' }),
    });
    if (data?.status === 40400 || !data?.data) return null;
    return data.data as PlaudPublicShare;
  }

  /**
   * Create a public share link. content_config controls what's exposed:
   *   - audio / transcript: booleans
   *   - notes: array of "auto_sum:<workspace_short>:<file_id>" or
   *            "sum_multi:<workspace_short>:<file_id>:<note_id>" entries
   *   - overview, highlights: vestigial; ignore if unused.
   */
  async createPublicShare(
    fileId: string,
    contentConfig: PlaudShareContentConfig,
  ): Promise<PlaudPublicShare> {
    if (!fileId) throw new Error('createPublicShare: fileId is required');
    const data = await this.request('/share/public/create', {
      method: 'POST',
      body: JSON.stringify({
        object_id: fileId,
        object_type: 'file',
        content_config: {
          audio: contentConfig.audio,
          transcript: contentConfig.transcript,
          notes: contentConfig.notes ?? [],
          overview: contentConfig.overview ?? false,
          highlights: contentConfig.highlights ?? 0,
        },
      }),
    });
    return (data?.data ?? data) as PlaudPublicShare;
  }

  /** Idempotent — succeeds even if no link exists. */
  async deletePublicShare(fileId: string): Promise<void> {
    if (!fileId) throw new Error('deletePublicShare: fileId is required');
    await this.request('/share/public/delete', {
      method: 'POST',
      body: JSON.stringify({ object_id: fileId, object_type: 'file' }),
    });
  }
}
