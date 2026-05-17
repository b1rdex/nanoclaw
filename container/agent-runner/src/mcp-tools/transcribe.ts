/**
 * transcribe_audio MCP tool — Groq Whisper STT for inbound audio attachments.
 *
 * Looks up an inbound message by its seq, reads the first audio attachment
 * from disk (the host writes inbound attachments to `inbox/<messageId>/<file>`
 * under the session dir, mounted at `/workspace`), and POSTs the bytes as
 * multipart/form-data to Groq's `audio/transcriptions` endpoint. The OneCLI
 * gateway injects the Authorization header at request time (host pattern
 * `api.groq.com`) — no API key in the container.
 *
 * Agents invoke this when they see `[audio: ...]` in an inbound `<message id="N">`.
 */
import fs from 'fs';
import path from 'path';

import { getInboundDb } from '../db/connection.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const WORKSPACE_ROOT = '/workspace';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface AttachmentLike {
  type?: string;
  name?: string;
  mimeType?: string;
  localPath?: string;
  data?: string;
}

function pickAudioAttachment(attachments: unknown): AttachmentLike | null {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    if (a && typeof a === 'object' && (a as AttachmentLike).type === 'audio') {
      return a as AttachmentLike;
    }
  }
  return null;
}

function filenameFor(mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('mp3') || m.includes('mpeg')) return 'audio.mp3';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('m4a') || m.includes('mp4')) return 'audio.m4a';
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('flac')) return 'audio.flac';
  return 'audio.ogg';
}

export const transcribeAudio: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      'Transcribe an inbound voice/audio attachment to text using Groq Whisper. Pass the message id (the integer shown in `<message id="N">`). Returns the transcript. Supports any language Whisper does — pass `language` (ISO-639-1, e.g. "ru", "en") only if auto-detect picks wrong.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'integer',
          description: 'The seq id of the inbound message containing the audio attachment.',
        },
        language: {
          type: 'string',
          description: 'Optional ISO-639-1 language hint (e.g. "ru"). Omit for auto-detect.',
        },
      },
      required: ['message_id'],
    },
  },
  async handler(args) {
    const seq = Number(args.message_id);
    if (!Number.isInteger(seq) || seq <= 0) return err('message_id must be a positive integer');

    const row = getInboundDb()
      .prepare('SELECT content FROM messages_in WHERE seq = ?')
      .get(seq) as { content: string } | undefined;
    if (!row) return err(`Message #${seq} not found in this session`);

    let parsed: { attachments?: unknown };
    try {
      parsed = JSON.parse(row.content) as { attachments?: unknown };
    } catch {
      return err(`Message #${seq} has no parseable content`);
    }

    const attachment = pickAudioAttachment(parsed.attachments);
    if (!attachment) return err(`Message #${seq} has no audio attachment`);

    let buffer: Buffer;
    if (attachment.localPath) {
      const rel = attachment.localPath.replace(/^\/+/, '');
      const filePath = path.resolve(WORKSPACE_ROOT, rel);
      if (!filePath.startsWith(WORKSPACE_ROOT + path.sep)) {
        return err(`Audio path escapes workspace: ${attachment.localPath}`);
      }
      try {
        buffer = fs.readFileSync(filePath);
      } catch (e) {
        return err(`Could not read audio file ${attachment.localPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (attachment.data) {
      try {
        buffer = Buffer.from(attachment.data, 'base64');
      } catch {
        return err(`Message #${seq} audio data is not valid base64`);
      }
    } else {
      return err(`Message #${seq} audio attachment has neither localPath nor data — was it downloaded?`);
    }

    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: attachment.mimeType ?? 'audio/ogg' });
    form.append('file', blob, filenameFor(attachment.mimeType));
    form.append('model', DEFAULT_MODEL);
    form.append('response_format', 'json');
    const language = typeof args.language === 'string' ? args.language : '';
    if (language) form.append('language', language);

    let res: Response;
    try {
      res = await fetch(GROQ_URL, { method: 'POST', body: form });
    } catch (e) {
      return err(`Network error calling Groq: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return err(`Groq returned ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { text?: string };
    const text = (data.text ?? '').trim();
    if (!text) return err('Groq returned an empty transcript');

    return ok(text);
  },
};

registerTools([transcribeAudio]);
