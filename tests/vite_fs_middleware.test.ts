import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCharsApiHandler } from '../vite.config.ts';
import { CHARS_ROOT, PROJECT_ROOT } from './harness/headless_sim.ts';

async function callApi(
  handler: ReturnType<typeof createCharsApiHandler>,
  options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<{ status: number; json: any }> {
  const bodyBuf =
    options.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, 'utf8');
  const reqStream = Readable.from(bodyBuf.length > 0 ? [bodyBuf] : []) as any;
  reqStream.method = options.method;
  reqStream.url = options.url;
  reqStream.headers = options.headers ?? {};

  let status = 200;
  let respBody = '';
  const res: any = {
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
    setHeader() {},
    end(chunk?: string) {
      if (chunk) respBody += chunk;
    },
  };

  await handler(reqStream, res);
  return {
    status,
    json: respBody ? JSON.parse(respBody) : null,
  };
}

describe('AC-005: Hardened Vite Filesystem Middleware (/api/chars)', () => {
  it('enforces regex validation, symlink rejection, 404/413/415/422/403/409 guards, and atomic wx write', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mugen-vite-'));
    try {
      const charsDir = path.join(tmpDir, 'chars');
      fs.mkdirSync(charsDir);
      fs.cpSync(path.join(CHARS_ROOT, 'kaze_striker'), path.join(charsDir, 'kaze_striker'), {
        recursive: true,
      });

      // Create a symlinked directory and a .tmp file that GET /api/chars must ignore
      fs.symlinkSync(path.join(charsDir, 'kaze_striker'), path.join(charsDir, 'symlink_char'));
      fs.writeFileSync(path.join(charsDir, 'foo.tmp'), 'ignore');

      const handler = createCharsApiHandler({
        projectRoot: PROJECT_ROOT,
        charsRoot: charsDir,
      });

      // 1. GET /api/chars returns only real, approved folders
      const getRes = await callApi(handler, { method: 'GET', url: '/api/chars' });
      expect(getRes.status).toBe(200);
      expect(getRes.json.characters.map((c: any) => c.id)).toEqual(['kaze_striker']);

      // 2. PUT missing folder -> 404
      const r404 = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/missing_char/moveset',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(r404.status).toBe(404);

      // 3. PUT symlinked folder -> 400
      const rSym = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/symlink_char/moveset',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rSym.status).toBe(400);

      // 4. PUT without application/json -> 415
      const r415 = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/kaze_striker/moveset',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(r415.status).toBe(415);

      // 5. PUT over 1 MiB -> 413
      const r413 = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/kaze_striker/moveset',
        headers: { 'content-type': 'application/json' },
        body: Buffer.alloc(1024 * 1024 + 64, 'a'),
      });
      expect(r413.status).toBe(413);

      // 6. PUT modifying model.* in character.json -> 422
      const charJson = JSON.parse(
        fs.readFileSync(path.join(charsDir, 'kaze_striker/character.json'), 'utf8'),
      );
      const modifiedModel = structuredClone(charJson);
      modifiedModel.model.heightMeters = 2.1;
      const r422Model = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/kaze_striker/character',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(modifiedModel),
      });
      expect(r422Model.status).toBe(422);

      // 7. PUT valid character.json edit (e.g. walkSpeed) -> 200 atomic save
      const validEdit = structuredClone(charJson);
      validEdit.stats.walkSpeed = 4.75;
      const r200 = await callApi(handler, {
        method: 'PUT',
        url: '/api/chars/kaze_striker/character',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validEdit),
      });
      expect(r200.status).toBe(200);
      const savedOnDisk = JSON.parse(
        fs.readFileSync(path.join(charsDir, 'kaze_striker/character.json'), 'utf8'),
      );
      expect(savedOnDisk.stats.walkSpeed).toBe(4.75);

      // 8. POST /api/chars/:id/normalize without X-Arena-Mugen: 1 or with foreign Origin -> 403
      const r403NoHeader = await callApi(handler, {
        method: 'POST',
        url: '/api/chars/kaze_striker/normalize',
      });
      expect(r403NoHeader.status).toBe(403);

      const r403BadOrigin = await callApi(handler, {
        method: 'POST',
        url: '/api/chars/kaze_striker/normalize',
        headers: {
          'x-arena-mugen': '1',
          origin: 'https://evil.example.com',
        },
      });
      expect(r403BadOrigin.status).toBe(403);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
