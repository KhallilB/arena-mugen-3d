import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineConfig, type Plugin } from 'vite';
import {
  CHAR_ID_REGEX,
  discoverApprovedCharacters,
  sha256File,
} from './src/engine/ModLoader.ts';

const execFileAsync = promisify(execFile);
const ALLOWED_FILES = new Set(['character', 'moveset', 'ai']);
const ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface CharsApiConfig {
  projectRoot: string;
  charsRoot: string;
  blenderBin?: string;
}

export function createCharsApiHandler(cfg: CharsApiConfig) {
  let normalizeJobRunning = false;

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const validateCharDir = (
    charId: string,
  ): { ok: boolean; status: number; error?: string; charDir?: string } => {
    if (!CHAR_ID_REGEX.test(charId)) {
      return { ok: false, status: 400, error: 'Invalid character ID format' };
    }
    const candidate = path.join(cfg.charsRoot, charId);
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(candidate);
    } catch {
      return { ok: false, status: 404, error: 'Character directory does not exist' };
    }
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
      return { ok: false, status: 400, error: 'Symlinked or non-directory path rejected' };
    }
    const realRoot = fs.realpathSync(cfg.charsRoot);
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(realRoot + path.sep)) {
      return { ok: false, status: 400, error: 'Path escapes charsRoot' };
    }
    // Verify exact case match on case-insensitive APFS via character.json#id
    const charJsonPath = path.join(realCandidate, 'character.json');
    if (!fs.existsSync(charJsonPath)) {
      return { ok: false, status: 404, error: 'Missing character.json' };
    }
    try {
      const charJson = JSON.parse(fs.readFileSync(charJsonPath, 'utf8'));
      if (charJson.id !== charId) {
        return { ok: false, status: 404, error: 'Directory name case mismatch with character.json#id' };
      }
    } catch {
      return { ok: false, status: 400, error: 'Corrupt character.json' };
    }
    return { ok: true, status: 200, charDir: realCandidate };
  };

  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/chars')) {
      if (next) next();
      return;
    }

    // GET /api/chars
    if (req.method === 'GET' && url === '/api/chars') {
      const chars = discoverApprovedCharacters(cfg.charsRoot);
      sendJson(res, 200, { characters: chars });
      return;
    }

    // POST /api/chars/:id/normalize
    const normMatch = url.match(/^\/api\/chars\/([^/]+)\/normalize$/);
    if (req.method === 'POST' && normMatch) {
      const charId = decodeURIComponent(normMatch[1]);
      const origin = req.headers['origin'];
      const customHeader = req.headers['x-arena-mugen'];
      if ((origin && !ORIGIN_REGEX.test(String(origin))) || customHeader !== '1') {
        sendJson(res, 403, { error: 'Forbidden: missing X-Arena-Mugen: 1 or invalid Origin' });
        return;
      }
      const dirCheck = validateCharDir(charId);
      if (!dirCheck.ok || !dirCheck.charDir) {
        sendJson(res, dirCheck.status, { error: dirCheck.error });
        return;
      }
      if (normalizeJobRunning) {
        sendJson(res, 409, { error: 'Another normalization job is currently running' });
        return;
      }

      normalizeJobRunning = true;
      try {
        const blenderBin = cfg.blenderBin ?? '/opt/homebrew/bin/blender';
        await execFileAsync(
          blenderBin,
          [
            '-b',
            '--factory-startup',
            '--python-exit-code',
            '1',
            '-P',
            path.join(cfg.projectRoot, 'tools/normalize_char.py'),
            '--',
            dirCheck.charDir,
          ],
          { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
        );

        // Update output.hash and reset approval.status to pending (§2.4 Condition 4)
        const glbHash = sha256File(path.join(dirCheck.charDir, 'model.glb'));
        const manifestJsonPath = path.join(dirCheck.charDir, 'asset-manifest.json');
        if (fs.existsSync(manifestJsonPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
          manifest.output.hash = glbHash;
          manifest.approval.status = 'pending';
          fs.writeFileSync(manifestJsonPath, JSON.stringify(manifest));
        }
        sendJson(res, 200, { ok: true, id: charId, hash: glbHash, approvalStatus: 'pending' });
      } catch (err) {
        sendJson(res, 500, { error: `Normalization failed: ${(err as Error).message}` });
      } finally {
        normalizeJobRunning = false;
      }
      return;
    }

    // PUT /api/chars/:id/:file
    const putMatch = url.match(/^\/api\/chars\/([^/]+)\/([^/]+)$/);
    if (req.method === 'PUT' && putMatch) {
      const charId = decodeURIComponent(putMatch[1]);
      const fileKind = decodeURIComponent(putMatch[2]);
      if (!ALLOWED_FILES.has(fileKind)) {
        sendJson(res, 400, { error: 'Unsupported file target' });
        return;
      }
      const dirCheck = validateCharDir(charId);
      if (!dirCheck.ok || !dirCheck.charDir) {
        sendJson(res, dirCheck.status, { error: dirCheck.error });
        return;
      }

      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(res, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      const targetPath = path.join(dirCheck.charDir, `${fileKind}.json`);
      if (fs.existsSync(targetPath)) {
        const st = fs.lstatSync(targetPath);
        if (st.isSymbolicLink()) {
          sendJson(res, 400, { error: 'Symlinked target file rejected' });
          return;
        }
      }

      // Read body with 1 MiB ceiling
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > 1024 * 1024) {
          tooLarge = true;
          break;
        }
        chunks.push(buf);
      }
      if (tooLarge) {
        sendJson(res, 413, { error: 'Payload exceeds 1 MiB limit' });
        return;
      }

      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'Malformed JSON body' });
        return;
      }

      // Validate schema/frame-data invariants (422)
      if (fileKind === 'character') {
        const existingChar = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        if (JSON.stringify(parsed.model) !== JSON.stringify(existingChar.model)) {
          sendJson(res, 422, { error: 'Changes to model.* require re-normalization' });
          return;
        }
        if (parsed.id !== charId) {
          sendJson(res, 422, { error: 'Cannot change character.json#id' });
          return;
        }
      } else if (fileKind === 'moveset') {
        if (!parsed.moves || typeof parsed.moves !== 'object') {
          sendJson(res, 422, { error: 'moveset.json must contain moves object' });
          return;
        }
        for (const [mId, mv] of Object.entries< any >(parsed.moves)) {
          const totalF = Number(mv.totalFrames ?? 0);
          if (totalF < 2) {
            sendJson(res, 422, { error: `Move ${mId} invalid totalFrames` });
            return;
          }
          for (const hb of mv.hitboxes ?? []) {
            if (!(1 <= hb.startFrame && hb.startFrame <= hb.endFrame && hb.endFrame < totalF)) {
              sendJson(res, 422, { error: `Move ${mId} hitbox ${hb.id} violates 1 <= start <= end < totalFrames` });
              return;
            }
          }
        }
      } else if (fileKind === 'ai') {
        if (!parsed.personality || !Array.isArray(parsed.comboRoutes) || !Array.isArray(parsed.triggers)) {
          sendJson(res, 422, { error: 'Invalid ai.json schema' });
          return;
        }
      }

      // Atomic write via wx temp file + fsync + rename (§2.4 Condition 4)
      const rand = crypto.randomBytes(6).toString('hex');
      const tmpPath = path.join(dirCheck.charDir, `.${fileKind}.${process.pid}.${rand}.tmp`);
      const serialized = JSON.stringify(parsed, null, 2) + '\n';
      const fd = fs.openSync(tmpPath, 'wx');
      try {
        fs.writeFileSync(fd, serialized, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, targetPath);
      sendJson(res, 200, { ok: true, id: charId, file: fileKind });
      return;
    }

    sendJson(res, 404, { error: 'Unknown /api/chars endpoint' });
  };
}

function charsFsMiddlewarePlugin(): Plugin {
  const projectRoot = process.cwd();
  const charsRoot = path.join(projectRoot, 'chars');
  const handler = createCharsApiHandler({ projectRoot, charsRoot });
  return {
    name: 'arena-mugen-chars-fs-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [charsFsMiddlewarePlugin()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
