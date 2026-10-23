import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FighterFactoryOverlay } from '../src/editor/FighterFactoryOverlay.ts';
import { createHeadlessMatch } from './harness/headless_sim.ts';

describe('FighterFactoryOverlay & ArenaCamera UI/Gizmo Verification', () => {
  it('computes timeline bar segments and steps simulation frame-by-frame while paused', () => {
    const scene = new THREE.Scene();
    const factory = new FighterFactoryOverlay(scene);
    const sim = createHeadlessMatch('kaze_striker', 'tecton_grappler');

    expect(factory.isOpen).toBe(false);
    factory.toggle();
    expect(factory.isOpen).toBe(true);

    const segments = factory.buildTimelineSegments(sim.fighters[0], 'light_1');
    expect(segments.map((s) => s.kind)).toEqual(['STARTUP', 'ACTIVE', 'CANCEL', 'RECOVERY']);

    const tickBefore = sim.matchTick;
    factory.stepForwardOneTick(sim);
    expect(factory.isPaused).toBe(true);
    expect(sim.matchTick).toBe(tickBefore + 1);
  });
});
