import * as THREE from 'three';
import type { FighterController, ActiveHitboxVolume, HurtboxVolume } from './FighterController.ts';

// Pre-allocated zero-GC scratch registers for analytical segment-to-segment distance
const _p1 = new THREE.Vector3();
const _q1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q2 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Computes closest distance squared between Segment A (p1 -> q1) and Segment B (p2 -> q2)
 * with zero heap allocations.
 */
export function segmentSegmentDistSq(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
  outClosestA?: THREE.Vector3,
  outClosestB?: THREE.Vector3,
): number {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);

  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);
  const EPS = 1e-8;

  let s = 0.0;
  let t = 0.0;

  if (a <= EPS && e <= EPS) {
    s = 0.0;
    t = 0.0;
  } else if (a <= EPS) {
    s = 0.0;
    t = Math.max(0.0, Math.min(1.0, f / e));
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0.0;
      s = Math.max(0.0, Math.min(1.0, -c / a));
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      if (denom !== 0.0) {
        s = Math.max(0.0, Math.min(1.0, (b * f - c * e) / denom));
      } else {
        s = 0.0;
      }
      t = (b * s + f) / e;
      if (t < 0.0) {
        t = 0.0;
        s = Math.max(0.0, Math.min(1.0, -c / a));
      } else if (t > 1.0) {
        t = 1.0;
        s = Math.max(0.0, Math.min(1.0, (b - c) / a));
      }
    }
  }

  _p1.copy(p1).addScaledVector(_d1, s);
  _p2.copy(p2).addScaledVector(_d2, t);
  if (outClosestA) outClosestA.copy(_p1);
  if (outClosestB) outClosestB.copy(_p2);
  return _p1.distanceToSquared(_p2);
}

export interface PendingHit {
  attackerIndex: number;
  defenderIndex: number;
  moveId: string;
  hitbox: ActiveHitboxVolume;
  hurtbox: HurtboxVolume;
  isThrow: boolean;
  isProjectile: boolean;
  projectileId?: number;
  distSq: number;
  marginMeters: number;
}

/**
 * Pre-collision hurtbox invulnerability filter (§6.3.2).
 * Returns true if the defender cannot be hit by this attack type on this tick
 * (without consuming the hitbox's hitRegistry / maxHits allowance).
 */
export function isDefenderInvulnerable(
  defender: FighterController,
  attackType: 'STRIKE' | 'THROW' | 'PROJECTILE',
): boolean {
  if (
    defender.state === 'KNOCKDOWN' ||
    defender.state === 'WAKEUP' ||
    defender.state === 'THROWN'
  ) {
    return true;
  }
  if (defender.isInTeleportInvulnerability()) {
    return true;
  }
  if (defender.state === 'STEP_DODGE' && defender.stateFrame >= 1 && defender.stateFrame <= 10) {
    return true;
  }
  if (attackType === 'THROW') {
    if (
      defender.position.y > 0.05 ||
      defender.state === 'BLOCKSTUN' ||
      defender.state === 'HITSTUN'
    ) {
      return true;
    }
  } else {
    // Airborne juggle cap invulnerability
    if (defender.state === 'LAUNCHED' && defender.juggleHitCount >= 8) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates Phase A read-only contact snapshot between attacker's active hitboxes and defender's hurtboxes.
 */
export function collectPendingFighterHits(
  attacker: FighterController,
  defender: FighterController,
  outPending: PendingHit[],
): void {
  const activeHitboxes = attacker.getActiveHitboxesWorld();
  if (activeHitboxes.length === 0) return;
  const hurtboxes = defender.getHurtboxesWorld();

  for (const hb of activeHitboxes) {
    const attackType = hb.isThrow ? 'THROW' : 'STRIKE';
    if (!attacker.canHitboxRegisterHit(hb.id, hb.maxHits, hb.rehitIntervalFrames)) {
      continue;
    }
    if (isDefenderInvulnerable(defender, attackType)) {
      continue;
    }

    let bestHurtbox: HurtboxVolume | null = null;
    let bestDistSq = Infinity;
    let bestMargin = -Infinity;

    for (const hurt of hurtboxes) {
      const dSq = segmentSegmentDistSq(hb.startWorld, hb.endWorld, hurt.centerWorld, hurt.centerWorld);
      const rSum = hb.scaledRadius + hurt.scaledRadius;
      const dist = Math.sqrt(dSq);
      const margin = rSum - dist;
      if (dSq <= rSum * rSum && margin > bestMargin) {
        bestMargin = margin;
        bestDistSq = dSq;
        bestHurtbox = hurt;
      }
    }

    if (bestHurtbox) {
      outPending.push({
        attackerIndex: attacker.fighterIndex,
        defenderIndex: defender.fighterIndex,
        moveId: attacker.activeMoveId || '',
        hitbox: hb,
        hurtbox: bestHurtbox,
        isThrow: hb.isThrow,
        isProjectile: false,
        distSq: bestDistSq,
        marginMeters: bestMargin,
      });
      break; // At most one hitbox per move registers on the same tick
    }
  }
}
