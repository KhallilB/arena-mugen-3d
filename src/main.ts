import { ArenaSimulation } from './engine/ArenaSimulation.ts';

export const TICK_DT = 1.0 / 60.0;

/**
 * Fixed-60Hz accumulator loop decoupled from variable display refresh rates (60Hz / 120Hz ProMotion).
 */
export class FixedStepRunner {
  private accumulator = 0;

  public advanceWallClockDelta(
    sim: ArenaSimulation,
    deltaSeconds: number,
    speedMultiplier = 1.0,
    maxSubSteps = 8,
  ): number {
    const clampedDelta = Math.min(0.25, Math.max(0, deltaSeconds)) * speedMultiplier;
    this.accumulator += clampedDelta;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < maxSubSteps) {
      sim.stepOneTick();
      this.accumulator -= TICK_DT;
      steps++;
    }
    return steps;
  }
}
