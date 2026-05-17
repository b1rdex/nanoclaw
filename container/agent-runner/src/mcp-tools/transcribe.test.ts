import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { transcribeAudio } from './transcribe.js';

function seedMessage(seq: number, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content)
       VALUES ($id, $seq, 'chat-sdk', '2026-05-17T00:00:00Z', $content)`,
    )
    .run({ $id: `msg-${seq}`, $seq: seq, $content: JSON.stringify(content) });
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  mock.restore();
});

describe('transcribe_audio MCP tool', () => {
  it('rejects non-integer message_id', async () => {
    const res = await transcribeAudio.handler({ message_id: 'oops' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/positive integer/);
  });

  it('errors when message not found', async () => {
    const res = await transcribeAudio.handler({ message_id: 42 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not found/);
  });

  it('errors when message has no audio attachment', async () => {
    seedMessage(7, { text: 'hi', attachments: [{ type: 'image', data: 'AAA' }] });
    const res = await transcribeAudio.handler({ message_id: 7 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/no audio attachment/);
  });

  it('errors when audio attachment has neither localPath nor data', async () => {
    seedMessage(8, { text: '', attachments: [{ type: 'audio', mimeType: 'audio/ogg' }] });
    const res = await transcribeAudio.handler({ message_id: 8 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/neither localPath nor data/);
  });

  it('errors when localPath escapes workspace', async () => {
    seedMessage(80, {
      text: '',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', localPath: '../etc/passwd' }],
    });
    const res = await transcribeAudio.handler({ message_id: 80 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/escapes workspace/);
  });

  it('reads audio from /workspace/<localPath>, posts to Groq, returns transcript', async () => {
    // Sandbox /workspace for the test
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
    const fakeWorkspace = '/workspace';
    // We can't actually create /workspace, so monkey-patch fs.readFileSync to
    // serve from tmpRoot when asked for /workspace/...
    const realRead = fs.readFileSync.bind(fs);
    const origRead = fs.readFileSync;
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((p: fs.PathLike) => {
      const ps = String(p);
      if (ps.startsWith(fakeWorkspace + '/')) {
        return realRead(path.join(tmpRoot, ps.slice(fakeWorkspace.length + 1)));
      }
      return realRead(p);
    }) as typeof fs.readFileSync;

    try {
      const rel = 'inbox/msg-9/audio.ogg';
      fs.mkdirSync(path.join(tmpRoot, 'inbox/msg-9'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, rel), Buffer.from('opus-bytes'));

      seedMessage(9, {
        text: '',
        attachments: [{ type: 'audio', mimeType: 'audio/ogg', localPath: rel }],
      });

      let calledUrl = '';
      let calledBody: unknown = null;
      globalThis.fetch = mock(async (url: string, init: RequestInit) => {
        calledUrl = url;
        calledBody = init.body;
        return new Response(JSON.stringify({ text: '  Привет  ' }), { status: 200 });
      }) as unknown as typeof fetch;

      const res = await transcribeAudio.handler({ message_id: 9, language: 'ru' });
      expect(res.isError).toBeFalsy();
      expect((res.content[0] as { text: string }).text).toBe('Привет');
      expect(calledUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(calledBody).toBeInstanceOf(FormData);
      const form = calledBody as FormData;
      expect(form.get('model')).toBe('whisper-large-v3-turbo');
      expect(form.get('language')).toBe('ru');
      expect(form.get('file')).toBeInstanceOf(Blob);
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origRead;
    }
  });

  it('returns error on non-OK upstream response', async () => {
    seedMessage(10, {
      text: '',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('xx').toString('base64') }],
    });
    globalThis.fetch = mock(async () => new Response('quota', { status: 429 })) as unknown as typeof fetch;

    const res = await transcribeAudio.handler({ message_id: 10 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/429/);
  });

  it('returns error on empty transcript', async () => {
    seedMessage(11, {
      text: '',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('xx').toString('base64') }],
    });
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ text: '   ' }), { status: 200 })) as unknown as typeof fetch;

    const res = await transcribeAudio.handler({ message_id: 11 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/empty transcript/);
  });
});
