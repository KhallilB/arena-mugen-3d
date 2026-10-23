import * as THREE from 'three';
import {
  collectPendingFighterHits,
  isDefenderInvulnerable,
  segmentSegmentDistSq,
  type PendingHit,
} from './CollisionSolver.ts';
import type { FighterController, MoveSpec } from './FighterController.ts';
import type { CpuAiController } from './CpuAiController.ts';
import type { ArenaCamera } from './ArenaCamera.ts';

export interface ActiveProjectile {
  id: number;
  ownerIndex: number;
  moveId: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  turnRateDegPerSec: number;
  remainingFrames: number;
  scaledRadius: number;
  pierce: boolean;
  damage: number;
  guardDamage: number;
  hitstunFrames: number;
  blockstunFrames: number;
  hitstopFrames: number;
  launch: boolean;
  knockback: { forward: number; up: number; lateral: number };
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function hash32(a: number, b: number, c: number, d: number): number {
  let h = a | 0;
  h = Math.imul(h ^ (b | 0), 0x9e3779b9);
  h = Math.imul(h ^ (c | 0), 0x85ebca6b);
  h = Math.imul(h ^ (d | 0), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class ArenaSimulation {
  public readonly fighters: [FighterController, FighterController];
  public readonly aiControllers: [CpuAiController | null, CpuAiController | null] = [null, null];
  public camera: ArenaCamera | null = null;
  public readonly projectiles: ActiveProjectile[] = [];
  private nextProjectileId = 1;

  public matchSeed: number;
  public matchTick = 0;
  public roundNumber = 1;
  public roundTimerTicks = 3600;
  public roundWins: [number, number] = [0, 0];
  public inSuddenDeath = false;
  public matchWinnerIndex: number | null = null;

  // Anti-stalemate director tracking (§6.5.3)
  public ticksSinceLastEngagement = 0;
  public aggressionBoost = 0;
  public lastTickContacts: PendingHit[] = [];

  constructor(
    p1: FighterController,
    p2: FighterController,
    matchSeed = 0x12345678,
  ) {
    this.fighters = [p1, p2];
    this.matchSeed = matchSeed;
    this.resetRound(true);
  }

  public resetRound(isFirstRound = false, spawnDistance = 7.0): void {
    const halfD = spawnDistance * 0.5;
    this.fighters[0].resetForRound(-halfD, 0, +halfD);
    this.fighters[1].resetForRound(+halfD, 0, -halfD);
    if (isFirstRound) {
      this.fighters[0].meter = 200;
      this.fighters[1].meter = 200;
      this.roundWins = [0, 0];
      this.roundNumber = 1;
      this.matchWinnerIndex = null;
      this.inSuddenDeath = false;
    } else {
      for (const f of this.fighters) {
        f.meter = Math.min(f.maxMeter, f.meter + 150);
      }
    }
    this.projectiles.length = 0;
    this.roundTimerTicks = 3600;
    this.ticksSinceLastEngagement = 0;
    this.aggressionBoost = 0;
    for (const f of this.fighters) {
      f.seekBasePosePass1();
      f.capturePass1Snapshot();
    }
  }

  /**
   * Executes the strict 10-step 60Hz intra-tick pipeline with 3 explicit updateMatrixWorld(true) passes (§6.1).
   */
  public stepOneTick(): void {
    this.matchTick++;
    const [p1, p2] = this.fighters;

    // 1. Advance round/state timers, decrement hitstopFrames, and sample AI / input ring buffers
    const bothOutHitstop = p1.hitstopFrames === 0 && p2.hitstopFrames === 0;
    if (bothOutHitstop && this.roundTimerTicks > 0) {
      this.roundTimerTicks--;
    }

    this.ticksSinceLastEngagement++;
    if (this.ticksSinceLastEngagement > 180) {
      const overSec = (this.ticksSinceLastEngagement - 180) / 60.0;
      this.aggressionBoost = clamp(overSec * 0.20, 0.0, 1.0);
    } else {
      this.aggressionBoost = 0.0;
    }

    for (let i = 0; i < 2; i++) {
      const ai = this.aiControllers[i];
      if (ai) {
        const opp = this.fighters[1 - i];
        const aiInput = ai.decideNextInput(this.matchTick, opp, this.ticksSinceLastEngagement, this.aggressionBoost);
        this.fighters[i].pushInput(this.matchTick, aiInput);
      }
    }

    p1.stepTimersAndInputs(p2);
    p2.stepTimersAndInputs(p1);

    // 2. Integrate active root velocities and apply gravity (skipped for fighters with hitstopFrames > 0)
    p1.integrateVelocityAndGravity(p2);
    p2.integrateVelocityAndGravity(p1);

    // Check near-miss engagement reset (< 1.5m attack frame)
    if (
      (p1.activeMoveId || p2.activeMoveId) &&
      p1.position.distanceTo(p2.position) <= 1.5
    ) {
      this.ticksSinceLastEngagement = 0;
      this.aggressionBoost = 0;
    }

    // 3. Solve Fighter-vs-Fighter XZ Root Pushbox separation & Arena Wall Clamp (R <= 19.5m with residual transfer)
    this.solvePushboxAndWallSeparation();

    // 4. Pass 1 Pose Seek — Base skeletal animation pose for current integer frame
    for (const f of this.fighters) {
      f.seekBasePosePass1();
    }

    // 4b. Snapshot every fighter's hurtbox centres + Layer 3 pivot sockets (no port-order bias)
    for (const f of this.fighters) {
      f.capturePass1Snapshot();
    }

    // 5. Pass 2 Pitch Aiming — Layer 3 parent-local premultiply around R_world (-55°..+40° pitch, ±25° limb yaw)
    if (p1.shouldApplyPitchAiming()) {
      p1.applyLayer3PitchAiming(p2.pass1Snapshot);
    }
    if (p2.shouldApplyPitchAiming()) {
      p2.applyLayer3PitchAiming(p1.pass1Snapshot);
    }

    // 6. Pass 3 Socket-Pinned Throws — Layer 4 Stage A victim root alignment to post-pitch attacker.hand_r
    for (const f of this.fighters) {
      if (f.state === 'THROWN' && f.throwAttacker) {
        f.pinVictimToAttackerHand();
      }
    }

    // 7. Spawn new projectiles (at post-pitch socket world positions) and advance active 3D projectiles
    this.spawnAndAdvanceProjectiles();

    // 8. Phase A Read-Only Contact Snapshot — Run CollisionSolver against frozen Pass 2/3 matrices
    const pendingHits: PendingHit[] = [];
    if (p1.hitstopFrames === 0) {
      collectPendingFighterHits(p1, p2, pendingHits);
    }
    if (p2.hitstopFrames === 0) {
      collectPendingFighterHits(p2, p1, pendingHits);
    }
    this.collectPendingProjectileHits(pendingHits);
    this.lastTickContacts = pendingHits;

    // 9. Phase B Simultaneous Resolution — Apply trades, throw clashes, blocks, armor, damage, and state transitions
    if (pendingHits.length > 0) {
      this.resolveSimultaneousHits(pendingHits);
      this.ticksSinceLastEngagement = 0;
      this.aggressionBoost = 0;
    }

    // 10. Update ArenaCamera framing and push post-tick fighter snapshots into the 20-frame AI perception ring buffer
    if (this.camera) {
      this.camera.updateFraming(p1, p2, 1.0 / 60.0);
    }
    for (let i = 0; i < 2; i++) {
      this.aiControllers[i]?.recordOpponentSnapshot(this.matchTick, this.fighters[1 - i], this.projectiles);
    }

    this.checkRoundEndConditions();
  }

  private solvePushboxAndWallSeparation(): void {
    const [p1, p2] = this.fighters;
    const skipPush =
      p1.state === 'THROWN' ||
      p2.state === 'THROWN' ||
      p1.isInTeleportVanish() ||
      p2.isInTeleportVanish();

    if (!skipPush && Math.abs(p1.position.y - p2.position.y) < 1.2) {
      const dx = p2.position.x - p1.position.x;
      const dz = p2.position.z - p1.position.z;
      const dXZ = Math.hypot(dx, dz);
      const minSep = p1.pushboxRadius + p2.pushboxRadius;

      if (dXZ < minSep) {
        const nx = dXZ >= 1e-4 ? dx / dXZ : p1.forward.x;
        const nz = dXZ >= 1e-4 ? dz / dXZ : p1.forward.z;
        const pushHalf = 0.5 * (minSep - dXZ);

        p1.position.x -= nx * pushHalf;
        p1.position.z -= nz * pushHalf;
        p2.position.x += nx * pushHalf;
        p2.position.z += nz * pushHalf;
      }
    }

    // Arena wall clamp R <= 19.5m with corner residual transfer (§6.3.1)
    const R_WALL = 19.5;
    for (let i = 0; i < 2; i++) {
      const self = this.fighters[i];
      const other = this.fighters[1 - i];
      const r = Math.hypot(self.position.x, self.position.z);
      if (r > R_WALL) {
        const clampedX = (self.position.x * R_WALL) / r;
        const clampedZ = (self.position.z * R_WALL) / r;
        const truncX = clampedX - self.position.x;
        const truncZ = clampedZ - self.position.z;
        self.position.x = clampedX;
        self.position.z = clampedZ;
        if (!skipPush && self.position.distanceTo(other.position) < self.pushboxRadius + other.pushboxRadius) {
          other.position.x += truncX;
          other.position.z += truncZ;
        }
      }
      self.syncRootTransform();
    }
  }

  private spawnAndAdvanceProjectiles(): void {
    // Spawn new projectiles at post-pitch socket world positions (§5.4)
    for (let i = 0; i < 2; i++) {
      const attacker = this.fighters[i];
      const defender = this.fighters[1 - i];
      if (attacker.hitstopFrames > 0 || !attacker.activeMoveId) continue;
      const mv = attacker.moveset[attacker.activeMoveId];
      if (mv?.type !== 'PROJECTILE' || !mv.projectile) continue;
      if (!mv.projectile.spawnFrames.includes(attacker.moveFrame)) continue;

      const projSpec = mv.projectile;
      const spawnWorld = new THREE.Vector3();
      attacker.computeSocketOffsetWorld(projSpec.socket, [0, 0.08, 0], attacker.hitboxScale, spawnWorld);

      const targetChest = new THREE.Vector3();
      defender.computeSocketOffsetWorld('chest', [0, 0.08, 0], defender.hurtboxScale, targetChest);

      const delta = _tmpVecA.subVectors(targetChest, spawnWorld);
      const dXZ = Math.hypot(delta.x, delta.z);
      const maxPitch = (35 * Math.PI) / 180;
      const phi = clamp(Math.atan2(delta.y, Math.max(dXZ, 0.6)), -maxPitch, maxPitch);

      const vel = new THREE.Vector3(
        attacker.forward.x * Math.cos(phi) * projSpec.speed,
        Math.sin(phi) * projSpec.speed,
        attacker.forward.z * Math.cos(phi) * projSpec.speed,
      );

      this.projectiles.push({
        id: this.nextProjectileId++,
        ownerIndex: i,
        moveId: attacker.activeMoveId,
        position: spawnWorld,
        velocity: vel,
        speed: projSpec.speed,
        turnRateDegPerSec: projSpec.turnRateDegPerSec,
        remainingFrames: projSpec.lifetimeFrames,
        scaledRadius: projSpec.radius * attacker.hitboxScale,
        pierce: projSpec.pierce,
        damage: projSpec.damage,
        guardDamage: projSpec.guardDamage,
        hitstunFrames: projSpec.hitstunFrames,
        blockstunFrames: projSpec.blockstunFrames,
        hitstopFrames: projSpec.hitstopFrames,
        launch: projSpec.launch,
        knockback: { ...projSpec.knockback },
      });
    }

    // Advance active projectiles
    const dt = 1.0 / 60.0;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const target = this.fighters[1 - p.ownerIndex];
      const targetChest = _tmpVecB;
      target.computeSocketOffsetWorld('chest', [0, 0.08, 0], target.hurtboxScale, targetChest);

      if (p.turnRateDegPerSec > 0) {
        const toTarget = _tmpVecA.subVectors(targetChest, p.position);
        if (toTarget.lengthSq() >= 1e-8 && p.velocity.lengthSq() >= 1e-8) {
          toTarget.normalize();
          const curDir = p.velocity.clone().normalize();
          const maxTurnRad = (p.turnRateDegPerSec * Math.PI) / (180 * 60);
          const angle = curDir.angleTo(toTarget);
          if (angle > 1e-5) {
            const t = Math.min(1.0, maxTurnRad / angle);
            curDir.lerp(toTarget, t).normalize();
            p.velocity.copy(curDir).multiplyScalar(p.speed);
          }
        }
      }

      p.position.addScaledVector(p.velocity, dt);
      if (p.position.y < p.scaledRadius) {
        p.position.y = p.scaledRadius;
      }
      p.remainingFrames--;
      if (p.remainingFrames <= 0 || Math.hypot(p.position.x, p.position.z) > 22.0) {
        this.projectiles.splice(i, 1);
      }
    }

    // Projectile-vs-Projectile clash (§6.3.4)
    const toRemove = new Set<number>();
    for (let i = 0; i < this.projectiles.length; i++) {
      for (let j = i + 1; j < this.projectiles.length; j++) {
        const a = this.projectiles[i];
        const b = this.projectiles[j];
        if (a.ownerIndex === b.ownerIndex) continue;
        const rSum = a.scaledRadius + b.scaledRadius;
        if (a.position.distanceToSquared(b.position) <= rSum * rSum) {
          if (!a.pierce) toRemove.add(a.id);
          if (!b.pierce) toRemove.add(b.id);
        }
      }
    }
    if (toRemove.size > 0) {
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        if (toRemove.has(this.projectiles[i].id)) {
          this.projectiles.splice(i, 1);
        }
      }
    }
  }

  private collectPendingProjectileHits(outPending: PendingHit[]): void {
    for (const proj of this.projectiles) {
      const defender = this.fighters[1 - proj.ownerIndex];
      if (isDefenderInvulnerable(defender, 'PROJECTILE')) continue;

      const hurtboxes = defender.getHurtboxesWorld();
      for (const hurt of hurtboxes) {
        const dSq = segmentSegmentDistSq(proj.position, proj.position, hurt.centerWorld, hurt.centerWorld);
        const rSum = proj.scaledRadius + hurt.scaledRadius;
        if (dSq <= rSum * rSum) {
          outPending.push({
            attackerIndex: proj.ownerIndex,
            defenderIndex: defender.fighterIndex,
            moveId: proj.moveId,
            hitbox: {
              id: `proj_${proj.id}`,
              startFrame: 1,
              endFrame: 1,
              socket: 'hand_r',
              radius: proj.scaledRadius,
              offset: [0, 0, 0],
              damage: proj.damage,
              guardDamage: proj.guardDamage,
              hitstunFrames: proj.hitstunFrames,
              blockstunFrames: proj.blockstunFrames,
              hitstopFrames: proj.hitstopFrames,
              launch: proj.launch,
              knockback: proj.knockback,
              scaledRadius: proj.scaledRadius,
              startWorld: proj.position.clone(),
              endWorld: proj.position.clone(),
              isThrow: false,
            },
            hurtbox: hurt,
            isThrow: false,
            isProjectile: true,
            projectileId: proj.id,
            distSq: dSq,
            marginMeters: rSum - Math.sqrt(dSq),
          });
          break;
        }
      }
    }
  }

  private resolveSimultaneousHits(pendingHits: PendingHit[]): void {
    const p1Hit = pendingHits.find((h) => h.attackerIndex === 0);
    const p2Hit = pendingHits.find((h) => h.attackerIndex === 1);

    // Case A: Simultaneous Throw Clash (Tech) (§6.3.4)
    if (p1Hit?.isThrow && p2Hit?.isThrow) {
      for (const f of this.fighters) {
        f.hitstopFrames = 8;
        f.velocity.copy(f.forward).multiplyScalar(-3.5);
        f.transitionToState('IDLE');
      }
      return;
    }

    // Case B: Strike vs. Throw on same tick T (§6.3.4)
    if (p1Hit && p2Hit && p1Hit.isThrow !== p2Hit.isThrow) {
      const throwHit = p1Hit.isThrow ? p1Hit : p2Hit;
      const strikeHit = p1Hit.isThrow ? p2Hit : p1Hit;
      const grabber = this.fighters[throwHit.attackerIndex];
      if (!grabber.isArmorActiveOnCurrentFrame()) {
        // Unarmored throw loses to strike on same tick T
        this.applySingleHit(strikeHit);
        return;
      }
      // Armored throw absorbs strike (50% grey damage) and completes the throw pin
      grabber.armorHitsRemaining--;
      grabber.health = Math.max(1, grabber.health - Math.round(strikeHit.hitbox.damage * 0.5));
      this.fighters[strikeHit.attackerIndex].recordHitboxHit(strikeHit.hitbox.id, this.matchTick);
      this.applySingleHit(throwHit);
      return;
    }

    // Apply all hits (single hit or simultaneous Strike/Projectile Trade)
    for (const hit of pendingHits) {
      this.applySingleHit(hit);
    }

    if (p1Hit && p2Hit && !p1Hit.isThrow && !p2Hit.isThrow) {
      const sharedStop = Math.max(p1Hit.hitbox.hitstopFrames, p2Hit.hitbox.hitstopFrames);
      this.fighters[0].hitstopFrames = sharedStop;
      this.fighters[1].hitstopFrames = sharedStop;
    }
  }

  private applySingleHit(hit: PendingHit): void {
    const attacker = this.fighters[hit.attackerIndex];
    const defender = this.fighters[hit.defenderIndex];
    const hb = hit.hitbox;

    if (!hit.isProjectile) {
      attacker.recordHitboxHit(hb.id, this.matchTick);
    } else if (hit.projectileId !== undefined) {
      const idx = this.projectiles.findIndex((p) => p.id === hit.projectileId);
      if (idx >= 0 && !this.projectiles[idx].pierce) {
        this.projectiles.splice(idx, 1);
      }
    }

    // Stage A Throw Connect (§4.4.2)
    if (hit.isThrow) {
      attacker.moveHitConfirmed = 'ON_HIT';
      attacker.meter = Math.min(attacker.maxMeter, attacker.meter + 45);
      attacker.throwVictim = defender;
      defender.throwAttacker = attacker;
      attacker.latchedAimTheta = attacker.lastAimTheta;
      attacker.latchedAimPsi = attacker.lastAimPsi;
      defender.transitionToState('THROWN');
      defender.seekBasePosePass1();
      defender.pinVictimToAttackerHand();
      attacker.throwConnectVictimRootY = defender.position.y;
      return;
    }

    // Check Guard / Block (§6.1.1 & §6.4.3)
    const canBlock =
      !hb.unblockable &&
      (defender.state === 'GUARD' || defender.state === 'BLOCKSTUN') &&
      defender.guardMeter > 0;

    if (canBlock) {
      attacker.moveHitConfirmed = 'ON_BLOCK';
      attacker.meter = Math.min(attacker.maxMeter, attacker.meter + 20);
      defender.meter = Math.min(defender.maxMeter, defender.meter + 30);
      defender.guardMeter -= hb.guardDamage;
      defender.stunTimer = hb.blockstunFrames;
      if (!hit.isProjectile) {
        attacker.hitstopFrames = hb.hitstopFrames;
      }
      defender.hitstopFrames = hb.hitstopFrames;
      const invW = 1.0 / defender.config.stats.weight;
      defender.velocity.copy(defender.forward).multiplyScalar(hb.knockback.forward * 0.6 * invW);
      if (defender.guardMeter <= 0) {
        defender.transitionToState('GUARD_CRUSH');
      } else {
        defender.transitionToState('BLOCKSTUN');
      }
      return;
    }

    // Check Super Armor (§6.4.4)
    if (defender.isArmorActiveOnCurrentFrame()) {
      defender.armorHitsRemaining--;
      attacker.moveHitConfirmed = 'ON_HIT';
      const greyDmg = Math.round(hb.damage * 0.5);
      defender.health = Math.max(1, defender.health - greyDmg);
      if (!hit.isProjectile) {
        attacker.hitstopFrames = hb.hitstopFrames;
      }
      defender.hitstopFrames = hb.hitstopFrames;
      return;
    }

    // Unblocked Clean Hit (§6.4.5)
    attacker.moveHitConfirmed = 'ON_HIT';
    attacker.meter = Math.min(attacker.maxMeter, attacker.meter + 45);
    defender.meter = Math.min(defender.maxMeter, defender.meter + 30);

    defender.comboHitCount++;
    const n = defender.comboHitCount;
    const proration = Math.max(0.20, Math.pow(0.90, n - 1));
    const scaledDamage = Math.round(hb.damage * proration);
    defender.health = Math.max(0, defender.health - scaledDamage);

    if (!hit.isProjectile) {
      attacker.hitstopFrames = hb.hitstopFrames;
    }
    defender.hitstopFrames = hb.hitstopFrames;

    const isAirHit = defender.position.y > 0.05 || defender.state === 'LAUNCHED';
    const resolvesAsLaunch = Boolean(hb.launch || isAirHit);

    const invW = 1.0 / defender.config.stats.weight;
    const invSqrtW = 1.0 / Math.sqrt(defender.config.stats.weight);

    if (resolvesAsLaunch) {
      defender.juggleHitCount++;
      if (hb.launch) {
        defender.launchCount++;
      }
      const juggleUpReduction = Math.pow(0.90, Math.max(0, defender.juggleHitCount - 1));
      const relaunchMult = hb.launch && defender.launchCount > 1 ? 0.4 : 1.0;
      const baseUp = hb.knockback.up > 0 ? hb.knockback.up : 6.0;
      const upVel = baseUp * invSqrtW * juggleUpReduction * relaunchMult;

      defender.velocity
        .copy(defender.forward)
        .multiplyScalar(hb.knockback.forward * invW)
        .addScaledVector(defender.right, hb.knockback.lateral * invW);
      defender.velocity.y = upVel;
      if (defender.position.y <= 0.05) {
        defender.position.y = 0.06;
      }
      defender.transitionToState('LAUNCHED');
    } else {
      // Standing hitstun decay: max(8, floor(hitstunFrames * (1 - 0.07*(n-1)) + 0.5))
      const effStun = Math.max(8, Math.floor(hb.hitstunFrames * (1.0 - 0.07 * (n - 1)) + 0.5));
      defender.stunTimer = effStun;
      defender.velocity
        .copy(defender.forward)
        .multiplyScalar(hb.knockback.forward * invW)
        .addScaledVector(defender.right, hb.knockback.lateral * invW);
      defender.velocity.y = 0;
      defender.transitionToState('HITSTUN');
    }
  }

  private checkRoundEndConditions(): void {
    const [p1, p2] = this.fighters;
    const p1KO = p1.health <= 0;
    const p2KO = p2.health <= 0;
    const timeout = this.roundTimerTicks <= 0;

    if (!p1KO && !p2KO && !timeout) return;

    const hp1Pct = p1.health / p1.maxHealth;
    const hp2Pct = p2.health / p2.maxHealth;
    const tiedHp = Math.abs(hp1Pct - hp2Pct) <= 1e-4;

    if ((p1KO && p2KO) || (timeout && tiedHp)) {
      if (!this.inSuddenDeath) {
        // Trigger 900-tick (15s) Sudden Death overtime (§6.4.7)
        this.inSuddenDeath = true;
        this.resetRound(false);
        p1.health = Math.round(0.10 * p1.maxHealth);
        p2.health = Math.round(0.10 * p2.maxHealth);
        this.roundTimerTicks = 900;
        this.ticksSinceLastEngagement = 181;
        this.aggressionBoost = 1.0;
        return;
      }
    }

    this.inSuddenDeath = false;
    if (hp1Pct > hp2Pct + 1e-4) {
      this.roundWins[0]++;
    } else if (hp2Pct > hp1Pct + 1e-4) {
      this.roundWins[1]++;
    }

    if (this.roundWins[0] >= 2) {
      this.matchWinnerIndex = 0;
    } else if (this.roundWins[1] >= 2) {
      this.matchWinnerIndex = 1;
    } else if (this.roundNumber >= 5) {
      this.matchWinnerIndex = hash32(this.matchSeed, 0, 0, 0) & 1;
    } else {
      this.roundNumber++;
      this.resetRound(false);
    }
  }
}
