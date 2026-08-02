import * as fs from 'fs';
import OpenAI from 'openai';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  usd: number;
}

/** The transcription + chat surface the pipeline depends on (lets tests inject a fake). */
export interface Engine {
  transcribe(filePath: string, model: string, language?: string | null): Promise<string>;
  chat(model: string, messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<ChatResult>;
}

/** Approximate USD rates. Used for logging estimates only — not authoritative billing. */
const WHISPER_USD_PER_MIN: Record<string, number> = {
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
};
const CHAT_USD_PER_1M: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
};

export function estimateWhisperUsd(model: string, durationSec: number): number {
  const rate = WHISPER_USD_PER_MIN[model] ?? 0.006;
  return (durationSec / 60) * rate;
}

export function estimateChatUsd(model: string, promptTokens: number, completionTokens: number): number {
  const rate = CHAT_USD_PER_1M[model] ?? { in: 0, out: 0 };
  return (promptTokens / 1e6) * rate.in + (completionTokens / 1e6) * rate.out;
}

export class OpenAIEngine implements Engine {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  /** Transcribe one audio file. `language` left undefined => Whisper auto-detect. */
  async transcribe(filePath: string, model: string, language?: string | null): Promise<string> {
    const res = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model,
      response_format: 'text',
      ...(language ? { language } : {}),
    });
    // With response_format: 'text' the SDK returns the raw string.
    return typeof res === 'string' ? res : (res as { text?: string }).text ?? '';
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: { json?: boolean; temperature?: number } = {},
  ): Promise<ChatResult> {
    const res = await this.client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    });
    const content = res.choices[0]?.message?.content ?? '';
    const promptTokens = res.usage?.prompt_tokens ?? 0;
    const completionTokens = res.usage?.completion_tokens ?? 0;
    return {
      content,
      usage: { promptTokens, completionTokens },
      usd: estimateChatUsd(model, promptTokens, completionTokens),
    };
  }
}
