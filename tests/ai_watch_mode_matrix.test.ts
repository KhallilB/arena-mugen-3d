import { describe, expect, it } from 'vitest';
import { createHeadlessMatch } from './harness/headless_sim.ts';

const ROSTER_IDS = [
  'kaze_striker',
  'tecton_grappler',
  'pip_brawler',
  'vesper_phantom',
  'solaris_arcanist',
  'valkyr_sentinel',
];

describe('AC-008: Autonomous AI (AILevel 1–8), Watch Mode 15-Pair Matrix & Passive Training-Dummy Ring Occupancy', () => {
  it('engages within <= 300 ticks across all 15 unique pairings with exact reaction latency max(2, 20 - 2*L)', () => {
    let pairCount = 0;
    for (let i = 0; i < ROSTER_IDS.length; i++) {
      for (let j = i + 1; j < ROSTER_IDS.length; j++) {
        pairCount++;
        const idA = ROSTER_IDS[i];
        const idB = ROSTER_IDS[j];
        const sim = createHeadlessMatch(idA, idB, {
          spawnDistance: 7.0,
          enableAiP1: true,
          enableAiP2: true,
          aiLevelP1: 6,
          aiLevelP2: 6,
          matchSeed: 0x1000 + pairCount,
        });

        let engagedTick = -1;
        for (let t = 1; t <= 300; t++) {
          const prevEng = sim.ticksSinceLastEngagement;
          sim.stepOneTick();
          if (sim.ticksSinceLastEngagement === 0 && prevEng >= 0 && engagedTick === -1) {
            engagedTick = t;
            break;
          }
        }
        expect(engagedTick, `Pairing ${idA} vs ${idB} failed to engage within 300 ticks`).toBeGreaterThan(0);
        expect(engagedTick).toBeLessThanOrEqual(300);
        expect(sim.aiControllers[0]!.lastObservedReactionDelayTicks).toBe(Math.max(2, 20 - 2 * 6));
      }
    }
    expect(pairCount).toBe(15);
  });

  it('maintains >= 60% of IDLE/MOVE ticks inside preferredRangeMeters against a passive training dummy for all 6 archetypes', () => {
    for (const charId of ROSTER_IDS) {
      const [prefMin, prefMax] = createHeadlessMatch(charId, 'kaze_striker', {
        enableAiP1: true,
      }).aiControllers[0]!.config.personality.preferredRangeMeters;
      const startDist = 0.5 * (prefMin + prefMax);

      const sim = createHeadlessMatch(charId, 'kaze_striker', {
        spawnDistance: startDist,
        enableAiP1: true,
        enableAiP2: false,
        aiLevelP1: 6,
        matchSeed: 0x55aa,
      });

      let neutralTicks = 0;
      let inRingTicks = 0;

      for (let t = 1; t <= 360; t++) {
        sim.stepOneTick();
        // Keep passive dummy stationary so spacing ring occupancy is measured cleanly
        sim.fighters[1].velocity.set(0, 0, 0);
        const f1 = sim.fighters[0];
        if (f1.state === 'IDLE' || f1.state === 'MOVE') {
          neutralTicks++;
          const d = f1.position.distanceTo(sim.fighters[1].position);
          if (d >= prefMin && d <= prefMax) {
            inRingTicks++;
          }
        }
      }

      expect(neutralTicks).toBeGreaterThan(20);
      const occupancy = inRingTicks / neutralTicks;
      expect(occupancy, `${charId} ring occupancy ${occupancy.toFixed(2)} < 0.60`).toBeGreaterThanOrEqual(0.60);
    }
  });
});
