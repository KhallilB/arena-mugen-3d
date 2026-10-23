import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { segmentSegmentDistSq } from '../src/engine/CollisionSolver.ts';
import { createHeadlessMatch, PROJECT_ROOT } from './harness/headless_sim.ts';

describe('AC-003 & Gate 0: Multi-Height Pitch Aiming, Hitbox Scaling & Socket-Pinned Throws', () => {
  it('connects light_1 on frame 7 in BOTH directions (Tecton 2.45m <-> Pip 1.15m) from 1.20m when pitchTracking=true and whiffs without pitch', () => {
    // 1. Tecton (2.45m) -> Pip (1.15m) WITH pitchTracking: true from 1.20m
    const simTallToShort = createHeadlessMatch('tecton_grappler', 'pip_brawler', {
      spawnDistance: 1.20,
      clipSubsetMode: 'gate0',
    });
    const [tecton, pip] = simTallToShort.fighters;

    tecton.pushInput(1, { lightPressed: true });
    let hitFrameTallToShort = -1;
    let marginTallToShort = -Infinity;

    for (let f = 1; f <= 12; f++) {
      simTallToShort.stepOneTick();
      if (f > 1) tecton.pushInput(f, {});
      if (simTallToShort.lastTickContacts.length > 0 && hitFrameTallToShort === -1) {
        hitFrameTallToShort = tecton.moveFrame;
        marginTallToShort = simTallToShort.lastTickContacts[0].marginMeters;
      }
    }

    expect(hitFrameTallToShort).toBe(7);
    expect(marginTallToShort).toBeGreaterThan(0.10);
    expect(pip.health).toBeLessThan(pip.maxHealth);

    // 2. Tecton (2.45m) -> Pip (1.15m) WITH pitchTracking: false from 1.20m -> WHIFFS
    const simNoPitch = createHeadlessMatch('tecton_grappler', 'pip_brawler', {
      spawnDistance: 1.20,
      clipSubsetMode: 'gate0',
    });
    simNoPitch.fighters[0].moveset['light_1'].pitchTracking = false;
    simNoPitch.fighters[0].pushInput(1, { lightPressed: true });

    let minWhiffMargin = -Infinity;
    for (let f = 1; f <= 12; f++) {
      simNoPitch.stepOneTick();
      if (f > 1) simNoPitch.fighters[0].pushInput(f, {});
      if (simNoPitch.fighters[0].moveFrame === 7) {
        const hbs = simNoPitch.fighters[0].getActiveHitboxesWorld();
        const hurts = simNoPitch.fighters[1].getHurtboxesWorld();
        for (const hb of hbs) {
          for (const ht of hurts) {
            const d = Math.sqrt(
              segmentSegmentDistSq(hb.startWorld, hb.endWorld, ht.centerWorld, ht.centerWorld),
            );
            minWhiffMargin = Math.max(minWhiffMargin, hb.scaledRadius + ht.scaledRadius - d);
          }
        }
      }
    }
    expect(simNoPitch.fighters[1].health).toBe(simNoPitch.fighters[1].maxHealth);
    expect(minWhiffMargin).toBeLessThan(-0.25);

    // 3. Pip (1.15m) -> Tecton (2.45m) WITH pitchTracking: true from 1.20m
    const simShortToTall = createHeadlessMatch('pip_brawler', 'tecton_grappler', {
      spawnDistance: 1.20,
      clipSubsetMode: 'gate0',
    });
    const [pipAttacker, tectonDefender] = simShortToTall.fighters;
    pipAttacker.pushInput(1, { lightPressed: true });

    let hitFrameShortToTall = -1;
    let marginShortToTall = -Infinity;
    for (let f = 1; f <= 12; f++) {
      simShortToTall.stepOneTick();
      if (f > 1) pipAttacker.pushInput(f, {});
      if (simShortToTall.lastTickContacts.length > 0 && hitFrameShortToTall === -1) {
        hitFrameShortToTall = pipAttacker.moveFrame;
        marginShortToTall = simShortToTall.lastTickContacts[0].marginMeters;
      }
    }

    expect(hitFrameShortToTall).toBe(7);
    expect(marginShortToTall).toBeGreaterThan(0.10);
    expect(tectonDefender.health).toBeLessThan(tectonDefender.maxHealth);

    // 4. Also run 1.40m start and record its margin (Gate 0 item 2)
    const sim140 = createHeadlessMatch('pip_brawler', 'tecton_grappler', {
      spawnDistance: 1.40,
      clipSubsetMode: 'gate0',
    });
    sim140.fighters[0].pushInput(1, { lightPressed: true });
    let margin140 = -Infinity;
    for (let f = 1; f <= 7; f++) {
      sim140.stepOneTick();
      if (f > 1) sim140.fighters[0].pushInput(f, {});
      if (sim140.lastTickContacts.length > 0) {
        margin140 = Math.max(margin140, sim140.lastTickContacts[0].marginMeters);
      }
    }
    expect(Number.isFinite(margin140)).toBe(true);
  });

  it('pins Pip chest to Tecton hand_r during special_forward with latched aim and logs floor-clamp residual for Pip -> Tecton grab', () => {
    // 1. Tecton (2.45m) grabs Pip (1.15m)
    const simGrab = createHeadlessMatch('tecton_grappler', 'pip_brawler', {
      spawnDistance: 1.60,
      clipSubsetMode: 'gate0',
    });
    const [tecton, pip] = simGrab.fighters;

    tecton.pushInput(1, { stickZ: 1, specialPressed: true });
    let grabConnected = false;
    let connectHandY = 0;
    let connectChestY = 0;
    let maxPinError = 0;

    for (let f = 1; f <= 32; f++) {
      simGrab.stepOneTick();
      if (f > 1) tecton.pushInput(f, {});

      if (pip.state === 'THROWN') {
        const handPos = new THREE.Vector3();
        const chestPos = new THREE.Vector3();
        tecton.sockets.get('hand_r')!.getWorldPosition(handPos);
        pip.sockets.get('chest')!.getWorldPosition(chestPos);

        if (!grabConnected) {
          grabConnected = true;
          connectHandY = handPos.y;
          connectChestY = chestPos.y;
        }
        const pinErr = handPos.distanceTo(chestPos);
        maxPinError = Math.max(maxPinError, pinErr);
        expect(pip.position.y).toBeGreaterThanOrEqual(0.0);
      }
    }

    expect(grabConnected).toBe(true);
    expect(maxPinError).toBeLessThan(0.02);
    expect(connectHandY).toBeGreaterThanOrEqual(connectChestY - 0.05);
    expect(Math.abs(tecton.throwReleaseVictimRootY - tecton.throwConnectVictimRootY)).toBeLessThan(0.05);
    expect(pip.state).toBe('LAUNCHED');

    // 2. Pip (1.15m) grabs Tecton (2.45m) -> floor clamp binds, residual logged
    const simShortGrab = createHeadlessMatch('pip_brawler', 'tecton_grappler', {
      spawnDistance: 1.40,
      clipSubsetMode: 'gate0',
    });
    const [pipG, tectonV] = simShortGrab.fighters;
    pipG.pushInput(1, { stickZ: 1, specialPressed: true });

    let observedResidual = 0;
    for (let f = 1; f <= 32; f++) {
      simShortGrab.stepOneTick();
      if (f > 1) pipG.pushInput(f, {});
      if (tectonV.state === 'THROWN') {
        observedResidual = Math.max(observedResidual, tectonV.lastThrowFloorClampResidual);
        expect(tectonV.position.y).toBe(0.0);
      }
    }
    expect(observedResidual).toBeGreaterThan(0.20);
    expect(tectonV.state).toBe('LAUNCHED');
  });

  it('executes 600-tick Tecton vs Pip exchange with p95 frame time < 16.6ms and writes evidence/gate0-frametime.json', () => {
    const sim = createHeadlessMatch('tecton_grappler', 'pip_brawler', {
      spawnDistance: 3.5,
      enableAiP1: true,
      enableAiP2: true,
      aiLevelP1: 7,
      aiLevelP2: 7,
      clipSubsetMode: 'gate0',
    });

    const frameTimesMs: number[] = [];
    for (let i = 0; i < 600; i++) {
      const t0 = performance.now();
      sim.stepOneTick();
      const t1 = performance.now();
      frameTimesMs.push(t1 - t0);
    }

    const sorted = [...frameTimesMs].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    const outPath = path.join(PROJECT_ROOT, 'evidence/gate0-frametime.json');
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          ticks: 600,
          thresholdMs: 16.6,
          p50Ms: Number(p50.toFixed(4)),
          p95Ms: Number(p95.toFixed(4)),
          p99Ms: Number(p99.toFixed(4)),
          pass: p95 < 16.6,
        },
        null,
        2,
      ) + '\n',
    );

    expect(p95).toBeLessThan(16.6);
  });
});
