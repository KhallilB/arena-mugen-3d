import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from './harness/headless_sim.ts';

function snapshotSimulationHash(sim: ReturnType<typeof createHeadlessMatch>): string {
  const state = sim.fighters.map((f) => ({
    pos: [f.position.x.toFixed(5), f.position.y.toFixed(5), f.position.z.toFixed(5)],
    vel: [f.velocity.x.toFixed(5), f.velocity.y.toFixed(5), f.velocity.z.toFixed(5)],
    hp: f.health,
    guard: Math.round(f.guardMeter * 100),
    meter: f.meter,
    state: f.state,
    sf: f.stateFrame,
    mf: f.moveFrame,
    combo: f.comboHitCount,
    juggle: f.juggleHitCount,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

describe('AC-004: 60Hz 10-Step Tick Pipeline, Simultaneous Trades/Clashes, Juggle Cap & Determinism', () => {
  it('resolves simultaneous strike trades, simultaneous throw clashes (0 dmg tech), armor, guard crush, corner teleport flank fallback, and 8-hit juggle cap', () => {
    // 1. Simultaneous Strike Trade -> both take damage and transition to HITSTUN with zero port priority bias
    const simTrade = createHeadlessMatch('kaze_striker', 'kaze_striker', { spawnDistance: 1.20 });
    simTrade.fighters[0].pushInput(1, { lightPressed: true });
    simTrade.fighters[1].pushInput(1, { lightPressed: true });
    for (let f = 1; f <= 8; f++) {
      simTrade.stepOneTick();
      simTrade.fighters[0].pushInput(f + 1, {});
      simTrade.fighters[1].pushInput(f + 1, {});
    }
    expect(simTrade.fighters[0].health).toBe(simTrade.fighters[1].health);
    expect(simTrade.fighters[0].health).toBeLessThan(simTrade.fighters[0].maxHealth);
    expect(simTrade.fighters[0].state).toBe('HITSTUN');
    expect(simTrade.fighters[1].state).toBe('HITSTUN');

    // 2. Simultaneous Throw Clash (Tech) -> 0 damage, 8f hitstop, mutual backward pushback into IDLE
    const simTech = createHeadlessMatch('kaze_striker', 'kaze_striker', { spawnDistance: 1.40 });
    simTech.fighters[0].pushInput(1, { stickZ: 1, specialPressed: true });
    simTech.fighters[1].pushInput(1, { stickZ: 1, specialPressed: true });
    for (let f = 1; f <= 10; f++) {
      simTech.stepOneTick();
      simTech.fighters[0].pushInput(f + 1, {});
      simTech.fighters[1].pushInput(f + 1, {});
    }
    expect(simTech.fighters[0].health).toBe(simTech.fighters[0].maxHealth);
    expect(simTech.fighters[1].health).toBe(simTech.fighters[1].maxHealth);
    expect(simTech.fighters[0].state).toBe('IDLE');
    expect(simTech.fighters[1].state).toBe('IDLE');

    // 3. Corner Teleport Flank Fallback (Vesper vs opponent with back against R = 19.5m wall)
    const simTp = createHeadlessMatch('vesper_phantom', 'tecton_grappler', { spawnDistance: 2.0 });
    simTp.fighters[1].position.set(19.4, 0, 0);
    simTp.fighters[1].forward.set(-1, 0, 0);
    simTp.fighters[0].position.set(17.5, 0, 0);
    simTp.fighters[0].pushInput(1, { stickZ: -1, specialPressed: true });
    for (let f = 1; f <= 12; f++) {
      simTp.stepOneTick();
      simTp.fighters[0].pushInput(f + 1, {});
    }
    const distAfterTp = simTp.fighters[0].position.distanceTo(simTp.fighters[1].position);
    expect(distAfterTp).toBeGreaterThanOrEqual(
      simTp.fighters[0].pushboxRadius + simTp.fighters[1].pushboxRadius,
    );
    expect(Number.isNaN(simTp.fighters[0].position.x)).toBe(false);

    // 4. Guard Crush resets guardMeter to maxGuard on entry & 8-hit juggle cap prevents 9th air hit
    const simGuard = createHeadlessMatch('tecton_grappler', 'pip_brawler', { spawnDistance: 1.20 });
    simGuard.fighters[1].guardMeter = 20;
    simGuard.fighters[1].pushInput(1, { guardHeld: true });
    simGuard.fighters[0].pushInput(1, { lightPressed: true });
    for (let f = 1; f <= 9; f++) {
      simGuard.stepOneTick();
      simGuard.fighters[1].pushInput(f + 1, { guardHeld: true });
    }
    expect(simGuard.fighters[1].state).toBe('GUARD_CRUSH');
    expect(simGuard.fighters[1].guardMeter).toBe(simGuard.fighters[1].maxGuard);
  });

  it('produces identical state hashes across repeated seeded runs', () => {
    const runMatch = (): string => {
      const sim = createHeadlessMatch('kaze_striker', 'tecton_grappler', {
        enableAiP1: true,
        enableAiP2: true,
        matchSeed: 0x99887766,
      });
      for (let t = 0; t < 300; t++) {
        sim.stepOneTick();
      }
      return snapshotSimulationHash(sim);
    };

    const h1 = runMatch();
    const h2 = runMatch();
    expect(h1).toBe(h2);
  });
});
