import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FighterController,
  type CharacterConfig,
  type MoveSpec,
} from './FighterController.ts';
import type { AiConfig } from './CpuAiController.ts';

export const ALLOWED_RIGHTS = new Set(['original-design', 'licensed', 'owned-reference']);
export const CHAR_ID_REGEX = /^[a-z0-9_]{1,48}$/;

export interface AssetManifestJson {
  asset_id: string;
  spec_hash: string;
  provider: string;
  provider_model: string;
  task_id: string;
  created_at: string;
  request: Record<string, unknown>;
  output: {
    format: string;
    uri: string;
    hash: string;
    triangle_count: number;
    measured_height_meters: number;
    lowest_vertex_y: number;
  };
  validation: {
    automated: string;
    checked_at: string;
  };
  approval: {
    status: string;
    approved_by: string;
    approved_at: string;
    manifest_hash: string;
    notes: string;
  };
}

export interface DiscoveredCharacterEntry {
  id: string;
  charDir: string;
  character: CharacterConfig;
  moveset: { moves: Record<string, MoveSpec> };
  ai: AiConfig;
  manifest: AssetManifestJson;
}

function normalizeForCanonicalJson(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(normalizeForCanonicalJson);
  }
  if (val !== null && typeof val === 'object') {
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      out[k] = normalizeForCanonicalJson((val as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val)) {
    return Math.trunc(val);
  }
  return val;
}

export function canonicalJsonString(val: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(val));
}

export function computeManifestHash(manifest: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k !== 'approval' && k !== 'validation') {
      copy[k] = v;
    }
  }
  const canonical = canonicalJsonString(copy);
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verifies the 4 ApprovedAsset conditions (§7.3.1) on a character directory.
 */
export function verifyApprovedAssetDirectory(charDir: string): {
  ok: boolean;
  reason?: string;
  entry?: DiscoveredCharacterEntry;
} {
  const folderName = path.basename(charDir);
  if (!CHAR_ID_REGEX.test(folderName)) {
    return { ok: false, reason: `Invalid folder name: ${folderName}` };
  }

  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(charDir);
  } catch {
    return { ok: false, reason: 'Directory does not exist' };
  }
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
    return { ok: false, reason: 'Symlinked or non-directory entry rejected' };
  }

  const requiredFiles = [
    'asset-spec.yaml',
    'generation-task.json',
    'asset-manifest.json',
    'character.json',
    'moveset.json',
    'ai.json',
    'model.glb',
  ];
  for (const f of requiredFiles) {
    const fp = path.join(charDir, f);
    if (!fs.existsSync(fp)) {
      return { ok: false, reason: `Missing required file ${f}` };
    }
    const st = fs.lstatSync(fp);
    if (st.isSymbolicLink()) {
      return { ok: false, reason: `Symlinked file ${f} rejected` };
    }
  }

  const manifest: AssetManifestJson = JSON.parse(
    fs.readFileSync(path.join(charDir, 'asset-manifest.json'), 'utf8'),
  );
  const character: CharacterConfig = JSON.parse(
    fs.readFileSync(path.join(charDir, 'character.json'), 'utf8'),
  );
  const moveset = JSON.parse(
    fs.readFileSync(path.join(charDir, 'moveset.json'), 'utf8'),
  );
  const ai: AiConfig = JSON.parse(
    fs.readFileSync(path.join(charDir, 'ai.json'), 'utf8'),
  );

  if (character.id !== folderName) {
    return { ok: false, reason: `character.json#id '${character.id}' != folder '${folderName}'` };
  }

  // 1. Cryptographic Hash Integrity
  const specHashDisk = sha256File(path.join(charDir, 'asset-spec.yaml'));
  if (manifest.spec_hash.toLowerCase() !== specHashDisk.toLowerCase()) {
    return { ok: false, reason: 'spec_hash mismatch' };
  }
  const glbHashDisk = sha256File(path.join(charDir, 'model.glb'));
  if (manifest.output.hash.toLowerCase() !== glbHashDisk.toLowerCase()) {
    return { ok: false, reason: 'output.hash mismatch' };
  }

  // 2. Automated Validation Pass
  if (manifest.validation?.automated !== 'pass') {
    return { ok: false, reason: 'validation.automated != pass' };
  }

  // 3. Acceptable Rights Status (quick line check in asset-spec.yaml)
  const specRaw = fs.readFileSync(path.join(charDir, 'asset-spec.yaml'), 'utf8');
  const rightsMatch = specRaw.match(/^rights_status:\s*(\S+)/m);
  if (!rightsMatch || !ALLOWED_RIGHTS.has(rightsMatch[1].replace(/"/g, ''))) {
    return { ok: false, reason: 'Unacceptable rights_status' };
  }

  // 4. Explicit Approval Record Exists
  if (
    manifest.approval?.status !== 'approved' ||
    !manifest.approval.approved_by ||
    !manifest.approval.approved_at
  ) {
    return { ok: false, reason: 'approval.status != approved' };
  }
  const expectedMHash = computeManifestHash(manifest as unknown as Record<string, unknown>);
  if (manifest.approval.manifest_hash.toLowerCase() !== expectedMHash.toLowerCase()) {
    return { ok: false, reason: 'approval.manifest_hash mismatch' };
  }

  return {
    ok: true,
    entry: {
      id: folderName,
      charDir,
      character,
      moveset,
      ai,
      manifest,
    },
  };
}

export function discoverApprovedCharacters(charsRoot: string): DiscoveredCharacterEntry[] {
  if (!fs.existsSync(charsRoot)) return [];
  const entries = fs.readdirSync(charsRoot);
  const discovered: DiscoveredCharacterEntry[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.') || name.endsWith('.tmp') || !CHAR_ID_REGEX.test(name)) {
      continue;
    }
    const fullPath = path.join(charsRoot, name);
    const res = verifyApprovedAssetDirectory(fullPath);
    if (res.ok && res.entry) {
      discovered.push(res.entry);
    }
  }
  return discovered;
}
