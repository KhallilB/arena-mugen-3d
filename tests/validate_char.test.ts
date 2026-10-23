import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverApprovedCharacters,
  verifyApprovedAssetDirectory,
} from '../src/engine/ModLoader.ts';
import { CHARS_ROOT, PROJECT_ROOT } from './harness/headless_sim.ts';

const VALIDATE_PY = path.join(PROJECT_ROOT, 'tools/validate_char.py');
const APPROVE_PY = path.join(PROJECT_ROOT, 'tools/approve_char.py');

describe('AC-001 & AC-002: validate_char.py & ModLoader ApprovedAsset Gate', () => {
  it('validates all 6 launch roster characters and discovers them via ModLoader', () => {
    const discovered = discoverApprovedCharacters(CHARS_ROOT);
    expect(discovered.map((c) => c.id)).toEqual([
      'kaze_striker',
      'pip_brawler',
      'solaris_arcanist',
      'tecton_grappler',
      'valkyr_sentinel',
      'vesper_phantom',
    ]);
  });

  it('fails closed on corrupted fixtures while keeping asset-spec.yaml and character.json byte-identical', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mugen-val-'));
    try {
      const charCopy = path.join(tmpBase, 'tecton_grappler');
      fs.cpSync(path.join(CHARS_ROOT, 'tecton_grappler'), charCopy, { recursive: true });

      const specBytesBefore = fs.readFileSync(path.join(charCopy, 'asset-spec.yaml'));
      const charBytesBefore = fs.readFileSync(path.join(charCopy, 'character.json'));

      // 1. Valid copy passes
      expect(verifyApprovedAssetDirectory(charCopy).ok).toBe(true);

      // 2. Hash mismatch on model.glb -> rejected
      const manifestPath = path.join(charCopy, 'asset-manifest.json');
      const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const origHash = manifestObj.output.hash;
      manifestObj.output.hash = 'sha256:' + '0'.repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifestObj));
      expect(verifyApprovedAssetDirectory(charCopy).ok).toBe(false);

      // Restore hash, break approval
      manifestObj.output.hash = origHash;
      manifestObj.approval.status = 'pending';
      fs.writeFileSync(manifestPath, JSON.stringify(manifestObj));
      expect(verifyApprovedAssetDirectory(charCopy).ok).toBe(false);

      // 3. Invalid cancel target in moveset.json -> validate_char.py exits 1 without mutating contract files
      execFileSync('python3', [APPROVE_PY, charCopy, '--by', 'vitest']);
      const movesetPath = path.join(charCopy, 'moveset.json');
      const movesetObj = JSON.parse(fs.readFileSync(movesetPath, 'utf8'));
      movesetObj.moves.light_1.cancels[0].targets.push('nonexistent_move');
      fs.writeFileSync(movesetPath, JSON.stringify(movesetObj, null, 2));

      let exitCode = 0;
      try {
        execFileSync('python3', [VALIDATE_PY, charCopy], { stdio: 'pipe' });
      } catch (err: any) {
        exitCode = err.status ?? 1;
      }
      expect(exitCode).toBe(1);

      expect(fs.readFileSync(path.join(charCopy, 'asset-spec.yaml')).equals(specBytesBefore)).toBe(true);
      expect(fs.readFileSync(path.join(charCopy, 'character.json')).equals(charBytesBefore)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
