#!/usr/bin/env npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

async function main() {
  const config = new PlaudConfig();
  const creds = config.getCredentials();

  if (!creds) {
    console.error('No Plaud credentials found. Run `plaud login` first.');
    process.exit(1);
  }

  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds.region);

  const server = new McpServer({
    name: 'plaud-mcp',
    version: '0.1.0',
  });

  const recordingIdSchema = { recording_id: z.string().describe('The recording ID') };

  server.tool('plaud_list_recordings', 'List all Plaud recordings with ID, date, duration, and title.', async () => {
    const recs = await client.listRecordings();
    const result = recs.map(r => ({
      id: r.id,
      title: r.filename,
      date: new Date(r.start_time).toISOString().slice(0, 16),
      duration_minutes: Math.round(r.duration / 60000),
      has_transcript: r.is_trans,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('plaud_get_transcript', 'Get the transcript of a Plaud recording by ID.', recordingIdSchema, async (params) => {
    const detail = await client.getRecording(params.recording_id);
    const result = { id: detail.id, title: detail.filename, transcript: detail.transcript || 'No transcript available.' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('plaud_get_recording_detail', 'Get full details of a Plaud recording including metadata and transcript.', recordingIdSchema, async (params) => {
    const detail = await client.getRecording(params.recording_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
  });

  server.tool('plaud_user_info', 'Get current Plaud user information.', async () => {
    const user = await client.getUserInfo();
    return { content: [{ type: 'text' as const, text: JSON.stringify(user, null, 2) }] };
  });

  server.tool('plaud_get_mp3_url', 'Get a temporary download URL for the MP3 version of a recording.', recordingIdSchema, async (params) => {
    const url = await client.getMp3Url(params.recording_id);
    const result = { url: url || null, message: url ? 'Temporary URL valid for a short time.' : 'No MP3 available.' };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool(
    'plaud_search',
    'Full-text search across all Plaud recordings. Returns matching recording IDs, titles, and the matched keywords. Use this before fetching transcripts when looking for specific topics.',
    { query: z.string().describe('Search query (matches across transcript and title)') },
    async (params) => {
      const result = await client.search(params.query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plaud_list_folders',
    'List all Plaud folders (filetags) on the account. Returns folder id, name, icon, and color. Use to look up folder ids before moving recordings.',
    async () => {
      const folders = await client.listFolders();
      return { content: [{ type: 'text' as const, text: JSON.stringify(folders, null, 2) }] };
    },
  );

  server.tool(
    'plaud_move_to_folder',
    'Move one or more recordings into a folder. Pass an empty folder_id to remove the recordings from any folder. Use plaud_list_folders first to look up the target folder id.',
    {
      recording_ids: z.array(z.string()).min(1).describe('Recording IDs to move'),
      folder_id: z.string().describe('Target folder ID (empty string clears the folder assignment)'),
    },
    async (params) => {
      await client.moveToFolder(params.recording_ids, params.folder_id);
      return { content: [{ type: 'text' as const, text: `Moved ${params.recording_ids.length} recording(s) to folder ${params.folder_id || '(unfiled)'}` }] };
    },
  );

  server.tool(
    'plaud_rename_recording',
    'Rename a recording. The new name replaces the user-set filename; the AI-generated headline (used in the recordings list) is unaffected.',
    {
      recording_id: z.string().describe('Recording ID'),
      new_name: z.string().min(1).describe('New filename'),
    },
    async (params) => {
      await client.renameRecording(params.recording_id, params.new_name);
      return { content: [{ type: 'text' as const, text: `Renamed recording ${params.recording_id} to "${params.new_name}"` }] };
    },
  );

  server.tool(
    'plaud_trash_recordings',
    'Move one or more recordings to Trash. Reversible via plaud_restore_recordings while in Trash.',
    { recording_ids: z.array(z.string()).min(1).describe('Recording IDs to move to Trash') },
    async (params) => {
      await client.trashRecordings(params.recording_ids);
      return { content: [{ type: 'text' as const, text: `Moved ${params.recording_ids.length} recording(s) to Trash` }] };
    },
  );

  server.tool(
    'plaud_restore_recordings',
    'Restore one or more recordings from Trash back to All Files.',
    { recording_ids: z.array(z.string()).min(1).describe('Recording IDs to restore from Trash') },
    async (params) => {
      await client.restoreRecordings(params.recording_ids);
      return { content: [{ type: 'text' as const, text: `Restored ${params.recording_ids.length} recording(s) from Trash` }] };
    },
  );

  server.tool(
    'plaud_merge_recordings',
    'Merge two or more recordings into a new audio file. Order the IDs by start_time ascending — concatenation order matches array order. Source files are preserved (not deleted). Returns a task_id; the merge runs async — poll plaud_get_merge_task until status is "completed" to get the new file id.',
    {
      recording_ids: z.array(z.string()).min(2).describe('Recording IDs in playback order (oldest first)'),
      filename: z.string().min(1).describe('Display name for the merged file'),
    },
    async (params) => {
      const result = await client.mergeRecordings(params.recording_ids, params.filename);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plaud_get_merge_task',
    'Poll the status of a merge task started via plaud_merge_recordings. Returns status (pending/success/failed observed; treat both "success" and "completed" as terminal-ok). The new merged file id is on task.file.id once status === "success". Merges of short recordings typically finish in <10s.',
    { task_id: z.string().describe('Merge task ID returned by plaud_merge_recordings') },
    async (params) => {
      const task = await client.getMergeTask(params.task_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
    },
  );

  // ── Custom templates ──────────────────────────────────────────────────────

  server.tool(
    'plaud_list_custom_templates',
    'List the user\'s private custom AI summary templates. Returns id, name, content (the prompt), and metadata. Use the id to apply the template via plaud_apply_template.',
    async () => {
      const templates = await client.listCustomTemplates();
      return { content: [{ type: 'text' as const, text: JSON.stringify(templates, null, 2) }] };
    },
  );

  server.tool(
    'plaud_create_custom_template',
    'Create a private custom AI summary template. The content field is the AI prompt — describe how Plaud should structure summaries using this template.',
    {
      name: z.string().min(1).describe('Display name for the template'),
      content: z.string().min(1).describe('The AI prompt — instructions for how to structure the summary'),
    },
    async (params) => {
      const tpl = await client.createCustomTemplate(params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(tpl, null, 2) }] };
    },
  );

  server.tool(
    'plaud_update_custom_template',
    'Update a custom template\'s name or prompt content. Partial updates supported.',
    {
      template_id: z.string().describe('Template ID to update'),
      name: z.string().optional().describe('New display name'),
      content: z.string().optional().describe('New AI prompt content'),
    },
    async (params) => {
      const { template_id, ...patch } = params;
      const tpl = await client.updateCustomTemplate(template_id, patch);
      return { content: [{ type: 'text' as const, text: JSON.stringify(tpl, null, 2) }] };
    },
  );

  server.tool(
    'plaud_delete_custom_template',
    'Delete a custom template by id.',
    { template_id: z.string().describe('Template ID to delete') },
    async (params) => {
      await client.deleteCustomTemplate(params.template_id);
      return { content: [{ type: 'text' as const, text: `Deleted custom template ${params.template_id}` }] };
    },
  );

  // ── Apply template / delete tab ───────────────────────────────────────────

  server.tool(
    'plaud_apply_template',
    'Apply a template to a recording, generating a new summary tab. Non-destructive — adds a new tab without wiping existing content. Async: the new tab appears in the recording detail once the AI finishes (poll plaud_get_recording_detail). For official templates use a string token like "REASONING-NOTE" or "AI-CHOICE" with template_type "official". For your custom templates use the 32-hex id from plaud_list_custom_templates with template_type "custom". For community templates use template_type "community".',
    {
      recording_id: z.string().describe('Recording ID to apply the template to'),
      template_id: z.string().describe('Template ID — string token for official, 32-hex for custom/community'),
      template_type: z.enum(['official', 'community', 'custom']).describe('Template type'),
      tab_name: z.string().min(1).describe('Display name for the new tab on this recording'),
      info: z.string().optional().describe('Extra context for the AI (rarely needed; defaults to empty string)'),
    },
    async (params) => {
      const result = await client.applyTemplate(params.recording_id, {
        templateId: params.template_id,
        templateType: params.template_type,
        tabName: params.tab_name,
        info: params.info,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plaud_delete_note',
    'Delete a note tab (template-applied summary, summary, etc.) from a recording. Use the note_id from the recording detail\'s content_list (data_id field). Pair with plaud_apply_template for a clean undo of an unwanted tab.',
    {
      note_id: z.string().describe('Note ID — full data_id from content_list (e.g., "note:7f85616b:c9396a8f...")'),
      note_type: z.string().describe('Note type — matches data_type from content_list (e.g., "summary")'),
      note_content: z.string().optional().describe('Content body (rarely needed; defaults to empty)'),
    },
    async (params) => {
      await client.deleteNote({
        noteId: params.note_id,
        noteType: params.note_type,
        noteContent: params.note_content,
      });
      return { content: [{ type: 'text' as const, text: `Deleted note ${params.note_id}` }] };
    },
  );

  // ── Folder CRUD ───────────────────────────────────────────────────────────

  server.tool(
    'plaud_create_folder',
    'Create a new folder (filetag). Returns the folder id, which can be used with plaud_move_to_folder.',
    {
      name: z.string().min(1).describe('Folder name'),
      icon: z.string().optional().describe('Icon identifier (optional, defaults to empty)'),
      color: z.string().optional().describe('Color identifier (optional, defaults to empty)'),
    },
    async (params) => {
      const folder = await client.createFolder(params);
      return { content: [{ type: 'text' as const, text: JSON.stringify(folder, null, 2) }] };
    },
  );

  server.tool(
    'plaud_update_folder',
    'Rename or restyle a folder. The Plaud API requires all three fields (name, icon, color) on every PATCH — partial updates are not supported. To change just the name, fetch the folder via plaud_list_folders first and pass back its existing icon and color.',
    {
      folder_id: z.string().describe('Folder ID'),
      name: z.string().min(1).describe('New name'),
      icon: z.string().describe('Icon (pass existing value if not changing)'),
      color: z.string().describe('Color (pass existing value if not changing)'),
    },
    async (params) => {
      const folder = await client.updateFolder(params.folder_id, {
        name: params.name,
        icon: params.icon,
        color: params.color,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(folder, null, 2) }] };
    },
  );

  server.tool(
    'plaud_delete_folder',
    'Delete a folder. Files inside are moved to Trash (recoverable), not permanently destroyed.',
    { folder_id: z.string().describe('Folder ID to delete') },
    async (params) => {
      await client.deleteFolder(params.folder_id);
      return { content: [{ type: 'text' as const, text: `Deleted folder ${params.folder_id}. Files inside moved to Trash.` }] };
    },
  );

  // ── Public sharing ────────────────────────────────────────────────────────

  server.tool(
    'plaud_get_public_share',
    'Read the current public-share state for a recording. Returns null if no link exists, otherwise the share URL, key, expiry, and content config.',
    { recording_id: z.string().describe('Recording ID') },
    async (params) => {
      const share = await client.getPublicShare(params.recording_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(share, null, 2) }] };
    },
  );

  server.tool(
    'plaud_create_public_share',
    'Create a public share link for a recording. Returns the share URL — anyone with the link can access whatever is enabled in content_config. notes is an array of strings like "auto_sum:<workspace_short>:<file_id>" for the auto-summary tab, or "sum_multi:<workspace_short>:<file_id>:<note_id>" for template-applied tabs (look these up via plaud_get_recording_detail content_list data_id).',
    {
      recording_id: z.string().describe('Recording ID'),
      audio: z.boolean().describe('Expose audio file in the share'),
      transcript: z.boolean().describe('Expose transcript in the share'),
      notes: z.array(z.string()).optional().describe('Array of note tab references to expose (auto_sum:* or sum_multi:* strings)'),
    },
    async (params) => {
      const share = await client.createPublicShare(params.recording_id, {
        audio: params.audio,
        transcript: params.transcript,
        notes: params.notes ?? [],
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(share, null, 2) }] };
    },
  );

  server.tool(
    'plaud_delete_public_share',
    'Revoke the public share link for a recording. Idempotent — succeeds even when no link exists.',
    { recording_id: z.string().describe('Recording ID') },
    async (params) => {
      await client.deletePublicShare(params.recording_id);
      return { content: [{ type: 'text' as const, text: `Public share for ${params.recording_id} revoked` }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
