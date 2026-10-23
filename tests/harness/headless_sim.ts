import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { ArenaCamera } from '../../src/engine/ArenaCamera.ts';
import { ArenaSimulation } from '../../src/engine/ArenaSimulation.ts';
import { CpuAiController, type AiConfig } from '../../src/engine/CpuAiController.ts';
import {
  FighterController,
  type CharacterConfig,
  type MoveSpec,
} from '../../src/engine/FighterController.ts';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
export const CHARS_ROOT = path.join(PROJECT_ROOT, 'chars');
export const COMMON_STATES_PATH = path.join(PROJECT_ROOT, 'engine_assets/common_states.json');

/**
 * Texture-less Node binary .glb loader that builds the exact Three.js Object3D bone hierarchy
 * and THREE.AnimationClip tracks (VectorKeyframeTrack / QuaternionKeyframeTrack) from model.glb.
 */
export function loadGlbSkeletonAndClipsFromDisk(glbPath: string): {
  modelRoot: THREE.Group;
  clips: THREE.AnimationClip[];
} {
  const buf = fs.readFileSync(glbPath);
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error(`Invalid GLB header in ${glbPath}`);
  }
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 28 + jsonLen;
  const binBuf = buf.subarray(binStart);

  const nodes: any[] = gltf.nodes ?? [];
  const objNodes: THREE.Object3D[] = nodes.map((n, idx) => {
    const obj = new THREE.Bone();
    obj.name = n.name ?? `Node_${idx}`;
    if (Array.isArray(n.translation)) {
      obj.position.set(n.translation[0], n.translation[1], n.translation[2]);
    }
    if (Array.isArray(n.rotation)) {
      obj.quaternion.set(n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]);
    }
    if (Array.isArray(n.scale)) {
      obj.scale.set(n.scale[0], n.scale[1], n.scale[2]);
    }
    return obj;
  });

  const hasParent = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    for (const childIdx of nodes[i].children ?? []) {
      objNodes[i].add(objNodes[childIdx]);
      hasParent.add(childIdx);
    }
  }

  const modelRoot = new THREE.Group();
  modelRoot.name = 'GLBRoot';
  for (let i = 0; i < objNodes.length; i++) {
    if (!hasParent.has(i)) {
      modelRoot.add(objNodes[i]);
    }
  }
  modelRoot.updateMatrixWorld(true);

  const readFloatAccessor = (accIdx: number, components: number): Float32Array => {
    const acc = gltf.accessors[accIdx];
    const bv = gltf.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count * components;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = binBuf.readFloatLE(byteOffset + i * 4);
    }
    return out;
  };

  const clips: THREE.AnimationClip[] = [];
  for (const anim of gltf.animations ?? []) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const ch of anim.channels ?? []) {
      const targetNodeIdx = ch.target?.node;
      const targetPath = ch.target?.path;
      if (targetNodeIdx === undefined || !targetPath) continue;
      const nodeUuid = objNodes[targetNodeIdx].uuid;
      const sampler = anim.samplers[ch.sampler];
      const times = readFloatAccessor(sampler.input, 1);

      if (targetPath === 'rotation') {
        const values = readFloatAccessor(sampler.output, 4);
        tracks.push(new THREE.QuaternionKeyframeTrack(`${nodeUuid}.quaternion`, times as any, values as any));
      } else if (targetPath === 'translation') {
        const values = readFloatAccessor(sampler.output, 3);
        tracks.push(new THREE.VectorKeyframeTrack(`${nodeUuid}.position`, times as any, values as any));
      } else if (targetPath === 'scale') {
        const values = readFloatAccessor(sampler.output, 3);
        tracks.push(new THREE.VectorKeyframeTrack(`${nodeUuid}.scale`, times as any, values as any));
      }
    }
    clips.push(new THREE.AnimationClip(anim.name, -1, tracks));
  }

  return { modelRoot, clips };
}

export function loadFighterFromDisk(
  charId: string,
  fighterIndex: number,
  clipSubsetMode: 'gate0' | 'all' = 'all',
): {
  fighter: FighterController;
  aiConfig: AiConfig;
} {
  const charDir = path.join(CHARS_ROOT, charId);
  const charCfg: CharacterConfig = JSON.parse(
    fs.readFileSync(path.join(charDir, 'character.json'), 'utf8'),
  );
  const movesetCfg: { moves: Record<string, MoveSpec> } = JSON.parse(
    fs.readFileSync(path.join(charDir, 'moveset.json'), 'utf8'),
  );
  const aiConfig: AiConfig = JSON.parse(
    fs.readFileSync(path.join(charDir, 'ai.json'), 'utf8'),
  );
  const statesCfg = JSON.parse(fs.readFileSync(COMMON_STATES_PATH, 'utf8'));
  const { modelRoot, clips } = loadGlbSkeletonAndClipsFromDisk(path.join(charDir, 'model.glb'));

  const fighter = new FighterController(
    fighterIndex,
    charCfg,
    movesetCfg.moves,
    modelRoot,
    clips,
    statesCfg.canonicalClips,
    clipSubsetMode,
  );
  return { fighter, aiConfig };
}

export function createHeadlessMatch(
  p1CharId: string,
  p2CharId: string,
  options: {
    spawnDistance?: number;
    enableAiP1?: boolean;
    enableAiP2?: boolean;
    aiLevelP1?: number;
    aiLevelP2?: number;
    matchSeed?: number;
    clipSubsetMode?: 'gate0' | 'all';
  } = {},
): ArenaSimulation {
  const seed = options.matchSeed ?? 0x20261022;
  const p1Data = loadFighterFromDisk(p1CharId, 0, options.clipSubsetMode ?? 'all');
  const p2Data = loadFighterFromDisk(p2CharId, 1, options.clipSubsetMode ?? 'all');
  const sim = new ArenaSimulation(p1Data.fighter, p2Data.fighter, seed);
  sim.camera = new ArenaCamera(16 / 9);
  sim.resetRound(true, options.spawnDistance ?? 7.0);

  if (options.enableAiP1) {
    sim.aiControllers[0] = new CpuAiController(
      p1Data.fighter,
      p1Data.aiConfig,
      seed,
      options.aiLevelP1 ?? p1Data.aiConfig.defaultAiLevel,
    );
  }
  if (options.enableAiP2) {
    sim.aiControllers[1] = new CpuAiController(
      p2Data.fighter,
      p2Data.aiConfig,
      seed,
      options.aiLevelP2 ?? p2Data.aiConfig.defaultAiLevel,
    );
  }
  return sim;
}
