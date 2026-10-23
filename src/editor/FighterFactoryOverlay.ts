import * as THREE from 'three';
import type { ArenaSimulation } from '../engine/ArenaSimulation.ts';
import type { FighterController, MoveSpec } from '../engine/FighterController.ts';

export interface TimelineBarSegment {
  kind: 'STARTUP' | 'ACTIVE' | 'CANCEL' | 'RECOVERY';
  startFrame: number;
  endFrame: number;
  colorHex: string;
}

export class FighterFactoryOverlay {
  public isOpen = false;
  public isPaused = false;
  public readonly gizmoGroup = new THREE.Group();

  constructor(scene?: THREE.Scene) {
    this.gizmoGroup.name = 'FighterFactoryGizmos';
    if (scene) {
      scene.add(this.gizmoGroup);
    }
  }

  public toggle(): boolean {
    this.isOpen = !this.isOpen;
    this.gizmoGroup.visible = this.isOpen;
    return this.isOpen;
  }

  public stepForwardOneTick(sim: ArenaSimulation): void {
    this.isPaused = true;
    sim.stepOneTick();
  }

  /**
   * Computes color-coded frame bar segments (§8.1):
   * Startup (Gold), Active Hitbox Window (Crimson), Cancel Window (Cyan), Recovery (Slate).
   */
  public buildTimelineSegments(fighter: FighterController, moveId: string): TimelineBarSegment[] {
    const move: MoveSpec | undefined = fighter.moveset[moveId];
    if (!move) return [];
    const { activeStart, activeEnd } = fighter.getMoveActiveBounds(move);
    const segments: TimelineBarSegment[] = [];

    if (activeStart > 1) {
      segments.push({
        kind: 'STARTUP',
        startFrame: 1,
        endFrame: activeStart - 1,
        colorHex: '#f59e0b',
      });
    }
    segments.push({
      kind: 'ACTIVE',
      startFrame: activeStart,
      endFrame: activeEnd,
      colorHex: '#dc2626',
    });
    for (const cw of move.cancels ?? []) {
      segments.push({
        kind: 'CANCEL',
        startFrame: cw.startFrame,
        endFrame: cw.endFrame,
        colorHex: '#06b6d4',
      });
    }
    if (activeEnd < move.totalFrames) {
      segments.push({
        kind: 'RECOVERY',
        startFrame: activeEnd + 1,
        endFrame: move.totalFrames,
        colorHex: '#64748b',
      });
    }
    return segments;
  }
}
