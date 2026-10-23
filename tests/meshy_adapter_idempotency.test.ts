import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from './harness/headless_sim.ts';

const MESHY_ADAPTER_PY = path.join(PROJECT_ROOT, 'tools/meshy_adapter.py');
const PYTHON_BIN = fs.existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3';

function runAdapterAsync(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    execFile(PYTHON_BIN, [MESHY_ADAPTER_PY, ...args], { env }, (err) => {
      if (!err) {
        resolve(0);
      } else {
        resolve(typeof (err as any).code === 'number' ? (err as any).code : 1);
      }
    });
  });
}

describe('AC-006: meshy_adapter.py Pre-Flight Validation & Task Idempotency', () => {
  it('exits 2 with 0 HTTP requests on invalid asset-spec.yaml and recovers PENDING/SUCCEEDED/SUBMITTING states idempotently', async () => {
    const recordedRequests: Array<{ method: string; url: string }> = [];

    const server = http.createServer((req, res) => {
      recordedRequests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ id: 'task-existing-001', status: 'IN_PROGRESS' }));
      } else {
        res.end(JSON.stringify({ result: 'task-created-002', status: 'PENDING' }));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const env = {
      ...process.env,
      MESHY_API_BASE_URL: `http://127.0.0.1:${addr.port}`,
      MESHY_API_KEY: 'vitest-fake-key',
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mugen-meshy-'));
    try {
      // 1. Invalid asset-spec.yaml (triangle_budget > 15000) -> exits 2 with 0 HTTP requests
      fs.writeFileSync(
        path.join(tmpDir, 'asset-spec.yaml'),
        [
          'asset_id: character.test.v1',
          'kind: character',
          'rights_status: original-design',
          'engine:',
          '  name: ArenaMugen3D',
          '  version: 0.1.0',
          '  import_format: glb',
          'geometry:',
          '  triangle_budget: 20000',
          'rig:',
          '  skeleton: canonical-16-bone-humanoid',
          'art:',
          '  original_brief: "test prompt"',
          '',
        ].join('\n'),
      );

      const exitCode = await runAdapterAsync([tmpDir], env);
      expect(exitCode).toBe(2);
      expect(recordedRequests.length).toBe(0);

      // Fix triangle_budget to 12000
      fs.writeFileSync(
        path.join(tmpDir, 'asset-spec.yaml'),
        [
          'asset_id: character.test.v1',
          'kind: character',
          'rights_status: original-design',
          'engine:',
          '  name: ArenaMugen3D',
          '  version: 0.1.0',
          '  import_format: glb',
          'geometry:',
          '  triangle_budget: 12000',
          'rig:',
          '  skeleton: canonical-16-bone-humanoid',
          'art:',
          '  original_brief: "test prompt"',
          '',
        ].join('\n'),
      );

      // 2. First valid run creates task via POST and writes PENDING
      expect(await runAdapterAsync([tmpDir], env)).toBe(0);
      expect(recordedRequests).toEqual([{ method: 'POST', url: '/v2/text-to-3d' }]);

      // 3. Second run with same idempotency_key in PENDING state calls GET /v2/text-to-3d/task-created-002 (NOT POST)
      recordedRequests.length = 0;
      expect(await runAdapterAsync([tmpDir], env)).toBe(0);
      expect(recordedRequests).toEqual([{ method: 'GET', url: '/v2/text-to-3d/task-created-002' }]);

      // 4. SUCCEEDED task makes 0 HTTP calls
      recordedRequests.length = 0;
      const taskPath = path.join(tmpDir, 'generation-task.json');
      const taskDoc = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      taskDoc.status = 'SUCCEEDED';
      fs.writeFileSync(taskPath, JSON.stringify(taskDoc, null, 2));
      expect(await runAdapterAsync([tmpDir], env)).toBe(0);
      expect(recordedRequests).toEqual([]);

      // 5. SUBMITTING without task_id stops (exits 1) with 0 HTTP calls
      taskDoc.status = 'SUBMITTING';
      taskDoc.task_id = null;
      fs.writeFileSync(taskPath, JSON.stringify(taskDoc, null, 2));
      const subExit = await runAdapterAsync([tmpDir], env);
      expect(subExit).toBe(1);
      expect(recordedRequests).toEqual([]);
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
