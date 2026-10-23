import * as THREE from 'three';
import { hash32, type ActiveProjectile } from './ArenaSimulation.ts';
import type { FighterController, FighterInputFrame, FighterStateId } from './FighterController.ts';

export interface AiComboRoute {
  id: string;
  starter: string;
  condition: 'ON_HIT' | 'ON_BLOCK';
  sequence: string[];
  weight: number;
}

export interface AiTriggerRule {
  id: string;
  priority: number;
  when: {
    opponentState?: FighterStateId[];
    distanceMeters?: [number, number];
    minMeter?: number;
    opponentAirborne?: boolean;
  };
  action: string;
  probability: number;
}

export interface AiConfig {
  aiVersion: string;
  defaultAiLevel: number;
  personality: {
    style: string;
    preferredRangeMeters: [number, number];
    aggression: number;
    defense: number;
    armorCounterBias: number;
    sidestepBias: number;
    homingDashBias: number;
    orbitDirectionBias: number;
    comboFollowthrough: number;
  };
  comboRoutes: AiComboRoute[];
  triggers: AiTriggerRule[];
}

export interface OpponentSnapshot {
  tick: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  state: FighterStateId;
  stateInstanceId: number;
  activeMoveId: string | null;
  hasIncomingProjectile: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mulberry32(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export class CpuAiController {
  public readonly self: FighterController;
  public config: AiConfig;
  public aiLevel: number;
  public matchSeed: number;
  private rollCounter = 0;

  // 20-frame delayed opponent perception ring buffer (§6.5.1)
  public readonly opponentRingBuffer: OpponentSnapshot[] = [];

  // Single-shot combo & trigger tracking
  private activeRoute: AiComboRoute | null = null;
  private activeRouteStepIndex = 0;
  private lastComboConfirmMoveId: string | null = null;
  private lastComboConfirmStep = -1;
  private readonly evaluatedTriggers: Map<string, { stateInstanceId: number; lastEvalTick: number }> = new Map();

  // Telemetry & latency verification
  public lastTelemetryBadge = '[IDLE]';
  public lastObservedReactionDelayTicks = 0;

  constructor(self: FighterController, config: AiConfig, matchSeed = 0x12345678, aiLevel?: number) {
    this.self = self;
    this.config = config;
    this.matchSeed = matchSeed;
    this.aiLevel = clamp(aiLevel ?? config.defaultAiLevel ?? 6, 1, 8);
  }

  public getReactionDelayTicks(): number {
    return Math.max(2, 20 - 2 * this.aiLevel);
  }

  private nextRandom(matchTick: number): number {
    return mulberry32(hash32(this.matchSeed, this.self.fighterIndex, matchTick, this.rollCounter++));
  }

  public recordOpponentSnapshot(
    matchTick: number,
    opponent: FighterController,
    projectiles: ActiveProjectile[],
  ): void {
    const hasIncomingProj = projectiles.some(
      (p) => p.ownerIndex === opponent.fighterIndex && p.position.distanceTo(this.self.position) <= 4.5,
    );
    this.opponentRingBuffer.push({
      tick: matchTick,
      position: opponent.position.clone(),
      velocity: opponent.velocity.clone(),
      state: opponent.state,
      stateInstanceId: opponent.stateInstanceId,
      activeMoveId: opponent.activeMoveId,
      hasIncomingProjectile: hasIncomingProj,
    });
    while (this.opponentRingBuffer.length > 24) {
      this.opponentRingBuffer.shift();
    }
  }

  private getDelayedOpponentSnapshot(matchTick: number, liveOpponent: FighterController): OpponentSnapshot {
    const delay = this.getReactionDelayTicks();
    this.lastObservedReactionDelayTicks = delay;
    const targetTick = matchTick - delay;
    for (let i = this.opponentRingBuffer.length - 1; i >= 0; i--) {
      if (this.opponentRingBuffer[i].tick <= targetTick) {
        return this.opponentRingBuffer[i];
      }
    }
    if (this.opponentRingBuffer.length > 0) {
      return this.opponentRingBuffer[0];
    }
    return {
      tick: matchTick,
      position: liveOpponent.position.clone(),
      velocity: liveOpponent.velocity.clone(),
      state: liveOpponent.state,
      stateInstanceId: liveOpponent.stateInstanceId,
      activeMoveId: liveOpponent.activeMoveId,
      hasIncomingProjectile: false,
    };
  }

  private actionToInputFrame(actionId: string): Partial<FighterInputFrame> {
    if (actionId === 'guard') {
      return { guardHeld: true };
    }
    if (actionId === 'step_dodge') {
      return { stickX: 1, dashPressed: true };
    }
    if (actionId === 'homing_dash') {
      return { stickZ: 1, dashPressed: true };
    }
    const mv = this.self.moveset[actionId];
    if (!mv) return {};
    const stickZ =
      mv.input.direction === 'FORWARD' ? 1 : mv.input.direction === 'BACK' ? -1 : 0;
    const stickX = mv.input.direction === 'LATERAL' ? 1 : 0;
    return {
      stickX,
      stickZ,
      lightPressed: mv.input.button === 'LIGHT',
      heavyPressed: mv.input.button === 'HEAVY',
      specialPressed: mv.input.button === 'SPECIAL',
    };
  }

  public decideNextInput(
    matchTick: number,
    liveOpponent: FighterController,
    ticksSinceLastEngagement: number,
    aggressionBoost: number,
  ): Partial<FighterInputFrame> {
    this.rollCounter = 0;

    // Priority 1: Immediate Self Proprioception (delay = 0) — Single-Shot Combo / Cancel Router
    if (
      this.self.activeMoveId &&
      this.self.hitstopFrames === 0 &&
      (this.self.moveHitConfirmed === 'ON_HIT' || this.self.moveHitConfirmed === 'ON_BLOCK')
    ) {
      if (this.lastComboConfirmMoveId !== this.self.activeMoveId) {
        this.lastComboConfirmMoveId = this.self.activeMoveId;
        const followProb =
          this.config.personality.comboFollowthrough * (0.35 + 0.65 * (this.aiLevel / 8.0));
        if (this.nextRandom(matchTick) < followProb) {
          if (!this.activeRoute || this.activeRoute.starter === this.self.activeMoveId) {
            const matching = this.config.comboRoutes.filter(
              (r) =>
                r.starter === this.self.activeMoveId &&
                r.condition === this.self.moveHitConfirmed,
            );
            if (matching.length > 0) {
              this.activeRoute = matching[0];
              this.activeRouteStepIndex = 0;
            }
          } else {
            this.activeRouteStepIndex++;
          }
          if (
            this.activeRoute &&
            this.activeRouteStepIndex < this.activeRoute.sequence.length
          ) {
            const nextAction = this.activeRoute.sequence[this.activeRouteStepIndex];
            this.lastComboConfirmStep = this.activeRouteStepIndex;
            this.lastTelemetryBadge = `[COMBO: ${this.activeRoute.id} step ${this.activeRouteStepIndex + 1}/${this.activeRoute.sequence.length}]`;
            return this.actionToInputFrame(nextAction);
          }
        } else {
          this.activeRoute = null;
        }
      }
    } else if (!this.self.activeMoveId && this.self.state !== 'HOMING_DASH') {
      this.lastComboConfirmMoveId = null;
      this.activeRoute = null;
    }

    // If mid-Homing Dash from a combo route, advance to air_light_1 or light_1 on arrival
    if (this.self.state === 'HOMING_DASH' && this.activeRoute) {
      const d3d = this.self.position.distanceTo(liveOpponent.position);
      if (d3d <= 1.55) {
        this.activeRouteStepIndex++;
        if (this.activeRouteStepIndex < this.activeRoute.sequence.length) {
          const nextAction = this.activeRoute.sequence[this.activeRouteStepIndex];
          this.lastTelemetryBadge = `[COMBO: ${this.activeRoute.id} step ${this.activeRouteStepIndex + 1}/${this.activeRoute.sequence.length}]`;
          return this.actionToInputFrame(nextAction);
        }
      }
    }

    // Delayed Opponent Perception Ring Buffer for Priorities 2–4
    const snap = this.getDelayedOpponentSnapshot(matchTick, liveOpponent);
    const dist = this.self.position.distanceTo(snap.position);

    // Priority 2: Defensive & Counter Reflex
    const isThreat =
      snap.hasIncomingProjectile ||
      ((snap.state === 'ATTACK_STARTUP' || snap.state === 'ATTACK_ACTIVE') && dist <= 2.6);
    if (isThreat && (this.self.state === 'IDLE' || this.self.state === 'MOVE')) {
      const defRoll = this.nextRandom(matchTick);
      if (defRoll < this.config.personality.defense * (this.aiLevel / 8.0)) {
        const subRoll = this.nextRandom(matchTick);
        if (subRoll < this.config.personality.sidestepBias * 0.5) {
          this.lastTelemetryBadge = '[DEFENSE: step_dodge]';
          return this.actionToInputFrame('step_dodge');
        }
        if (subRoll < this.config.personality.armorCounterBias * 0.5 && this.self.moveset['special_forward']) {
          this.lastTelemetryBadge = '[COUNTER: special_forward]';
          return this.actionToInputFrame('special_forward');
        }
        this.lastTelemetryBadge = '[DEFENSE: guard]';
        return { guardHeld: true };
      }
    }

    if (this.self.state !== 'IDLE' && this.self.state !== 'MOVE') {
      return {};
    }

    // Priority 3: M.U.G.E.N Declarative Triggers (Single-Shot per opponent stateInstanceId)
    const sortedTriggers = [...this.config.triggers].sort((a, b) => b.priority - a.priority);
    for (const trig of sortedTriggers) {
      const prev = this.evaluatedTriggers.get(trig.id);
      const isNeutral = snap.state === 'IDLE' || snap.state === 'MOVE';
      if (prev) {
        if (!isNeutral && prev.stateInstanceId === snap.stateInstanceId) continue;
        if (isNeutral && prev.stateInstanceId === snap.stateInstanceId && matchTick - prev.lastEvalTick < 24) {
          continue;
        }
      }

      if (trig.when.opponentState && !trig.when.opponentState.includes(snap.state)) continue;
      if (trig.when.distanceMeters) {
        const [dMin, dMax] = trig.when.distanceMeters;
        if (dist < dMin || dist > dMax) continue;
      }
      if (trig.when.minMeter !== undefined && this.self.meter < trig.when.minMeter) continue;
      if (trig.when.opponentAirborne !== undefined) {
        const oppAir = snap.position.y > 0.05;
        if (oppAir !== trig.when.opponentAirborne) continue;
      }

      this.evaluatedTriggers.set(trig.id, {
        stateInstanceId: snap.stateInstanceId,
        lastEvalTick: matchTick,
      });

      if (this.nextRandom(matchTick) < trig.probability) {
        this.lastTelemetryBadge = `[TRIGGER: ${trig.id}]`;
        return this.actionToInputFrame(trig.action);
      }
    }

    // Priority 4: 3D Neutral Ring Spacing + Anti-Stalemate Escalation (§6.5.3)
    const [rawMin, rawMax] = this.config.personality.preferredRangeMeters;
    const minEff = lerp(rawMin, 0.8, aggressionBoost);
    const maxEff = Math.max(minEff + 0.6, lerp(rawMax, 1.4, aggressionBoost));
    const escalate = ticksSinceLastEngagement > 180;

    if (dist > maxEff) {
      const dashProb =
        (this.config.personality.homingDashBias + (escalate ? 0.35 : 0.0)) * 0.08;
      if (this.nextRandom(matchTick) < dashProb) {
        this.lastTelemetryBadge = `[SPACING: HomingDash ${dist.toFixed(1)}m]`;
        return { stickZ: 1, dashPressed: true };
      }
      this.lastTelemetryBadge = `[SPACING: Advance ${dist.toFixed(1)}m]`;
      return { stickZ: 1, stickX: 0 };
    }

    if (dist < minEff && !escalate) {
      this.lastTelemetryBadge = `[SPACING: Retreat ${dist.toFixed(1)}m]`;
      return { stickZ: -1, stickX: 0 };
    }

    // Inside preferred range ring: orbit around ring midpoint or initiate attack
    if (matchTick % 12 === 0 || escalate) {
      const attackProb = (this.config.personality.aggression + aggressionBoost * 0.35) * 0.45;
      if (this.nextRandom(matchTick) < attackProb) {
        if (dist <= 2.2) {
          this.lastTelemetryBadge = '[NEUTRAL: light_1]';
          return this.actionToInputFrame('light_1');
        }
        if (dist >= 5.0 && this.self.moveset['special_neutral']) {
          this.lastTelemetryBadge = '[NEUTRAL: special_neutral]';
          return this.actionToInputFrame('special_neutral');
        }
        this.lastTelemetryBadge = '[NEUTRAL: heavy_neutral]';
        return this.actionToInputFrame('heavy_neutral');
      }
    }

    const rMid = 0.5 * (minEff + maxEff);
    const radialCorrection = clamp((dist - rMid) * 0.85, -0.5, 0.5);
    const orbitDir = this.config.personality.orbitDirectionBias >= 0 ? 1 : -1;
    this.lastTelemetryBadge = `[SPACING: Orbit ${dist.toFixed(1)}m]`;
    return { stickX: orbitDir * 0.6, stickZ: radialCorrection };
  }
}
