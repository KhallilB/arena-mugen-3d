import * as THREE from 'three';

export type FighterStateId =
  | 'IDLE'
  | 'MOVE'
  | 'STEP_DODGE'
  | 'HOMING_DASH'
  | 'JUMP'
  | 'ATTACK_STARTUP'
  | 'ATTACK_ACTIVE'
  | 'ATTACK_RECOVERY'
  | 'GUARD'
  | 'BLOCKSTUN'
  | 'GUARD_CRUSH'
  | 'HITSTUN'
  | 'LAUNCHED'
  | 'WALL_BOUNCE'
  | 'KNOCKDOWN'
  | 'WAKEUP'
  | 'THROWN';

export type InputButton = 'LIGHT' | 'HEAVY' | 'SPECIAL' | 'DASH' | 'JUMP' | 'GUARD';
export type InputDirection = 'NEUTRAL' | 'FORWARD' | 'BACK' | 'LEFT' | 'RIGHT' | 'LATERAL' | 'ANY';

export interface FighterInputFrame {
  stickX: number; // -1 (left) .. +1 (right) in target-relative orbit frame
  stickZ: number; // -1 (back) .. +1 (forward) in target-relative frame
  lightPressed: boolean;
  heavyPressed: boolean;
  specialPressed: boolean;
  dashPressed: boolean;
  jumpPressed: boolean;
  guardHeld: boolean;
}

export interface HurtboxSpec {
  id: string;
  socket: string;
  radius: number;
  offset: [number, number, number];
  scaleWithHeight?: boolean;
}

export interface HitboxSpec {
  id: string;
  startFrame: number;
  endFrame: number;
  socket: string;
  endSocket?: string;
  radius: number;
  offset: [number, number, number];
  scaleWithHeight?: boolean;
  maxHits?: number;
  rehitIntervalFrames?: number;
  unblockable?: boolean;
  throwReleaseFrame?: number;
  damage: number;
  guardDamage: number;
  hitstunFrames: number;
  blockstunFrames: number;
  hitstopFrames: number;
  launch?: boolean;
  radialKnockback?: boolean;
  knockback: { forward: number; up: number; lateral: number };
}

export interface MoveSpec {
  displayName: string;
  type: 'STRIKE' | 'THROW' | 'PROJECTILE' | 'TELEPORT';
  chainOnly?: boolean;
  input: { button: 'LIGHT' | 'HEAVY' | 'SPECIAL'; direction: InputDirection; airborne: boolean };
  animation: string;
  totalFrames: number;
  pitchTracking?: boolean;
  pitchLimb?: 'upper_arm_l' | 'upper_arm_r' | 'both_arms' | 'thigh_l' | 'thigh_r' | 'both_legs' | 'torso';
  tracking?: { startFrame: number; endFrame: number; turnRateDegPerSec: number };
  armor?: { startFrame: number; endFrame: number; hits: number };
  velocity?: Array<{ startFrame: number; endFrame: number; forward: number; up: number; lateral: number }>;
  hitboxes?: HitboxSpec[];
  projectile?: {
    spawnFrames: number[];
    socket: string;
    speed: number;
    turnRateDegPerSec: number;
    lifetimeFrames: number;
    radius: number;
    pierce: boolean;
    damage: number;
    guardDamage: number;
    hitstunFrames: number;
    blockstunFrames: number;
    hitstopFrames: number;
    launch: boolean;
    knockback: { forward: number; up: number; lateral: number };
  };
  teleport?: {
    vanishFrame: number;
    reappearFrame: number;
    invulnerableFrames: [number, number];
    targetAnchor: 'BEHIND_OPPONENT';
    offsetMeters: number;
    clampArenaRadiusMeters: number;
    faceOpponentOnExit: boolean;
  };
  cancels?: Array<{
    startFrame: number;
    endFrame: number;
    condition: 'ON_HIT' | 'ON_BLOCK' | 'ON_HIT_OR_BLOCK' | 'ALWAYS';
    targets: string[];
  }>;
}

export interface CharacterConfig {
  id: string;
  displayName: string;
  title: string;
  archetype: string;
  version: string;
  themeColor: string;
  secondaryColor: string;
  model: {
    file: string;
    heightMeters: number;
    statureRatio: number;
    shoulderWidthRatio: number;
    armSpreadOffsetDeg: number;
    forwardAxis: string;
  };
  stats: {
    maxHealth: number;
    maxGuard: number;
    maxMeter: number;
    walkSpeed: number;
    strafeSpeed: number;
    dashSpeed: number;
    homingDashSpeed: number;
    jumpVelocity: number;
    gravity: number;
    weight: number;
  };
  boneMap: Record<string, string>;
  hurtboxes: HurtboxSpec[];
}

export interface HurtboxVolume {
  id: string;
  socket: string;
  scaledRadius: number;
  centerWorld: THREE.Vector3;
}

export interface ActiveHitboxVolume extends HitboxSpec {
  scaledRadius: number;
  startWorld: THREE.Vector3;
  endWorld: THREE.Vector3;
  isThrow: boolean;
}

export interface Pass1Snapshot {
  hurtboxes: Array<{ id: string; socket: string; centerWorld: THREE.Vector3 }>;
  pivots: Record<string, THREE.Vector3>;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpQuatParentWorld = new THREE.Quaternion();
const _tmpQuatPitch = new THREE.Quaternion();
const _tmpQuatYaw = new THREE.Quaternion();
const _tmpAxisLocal = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class FighterController {
  public readonly fighterIndex: number;
  public readonly config: CharacterConfig;
  public moveset: Record<string, MoveSpec>;
  public readonly root: THREE.Group;
  public readonly visualShakeGroup: THREE.Group;
  public readonly mixer: THREE.AnimationMixer;
  public readonly actions: Map<string, THREE.AnimationAction> = new Map();
  public readonly clipFrameCounts: Map<string, number> = new Map();
  public readonly sockets: Map<string, THREE.Object3D> = new Map();
  private readonly pass1Quaternions: Map<string, THREE.Quaternion> = new Map();
  public readonly clipSubsetMode: 'gate0' | 'all';
  public readonly loggedSubstitutions: Set<string> = new Set();

  // Spatial & physical state
  public readonly position = new THREE.Vector3();
  public readonly velocity = new THREE.Vector3();
  public readonly forward = new THREE.Vector3(0, 0, 1);
  public readonly right = new THREE.Vector3(-1, 0, 0);
  public renderedYawRad = 0;

  // Combat resources & counters
  public health: number;
  public maxHealth: number;
  public guardMeter: number;
  public maxGuard: number;
  public meter = 200;
  public maxMeter: number;

  // State machine
  public state: FighterStateId = 'IDLE';
  public stateInstanceId = 1;
  public stateFrame = 0;
  public currentAnimFrame = 0;
  public activeClipName = 'idle';
  public activeAction: THREE.AnimationAction | null = null;
  public activeMoveId: string | null = null;
  public moveFrame = 0;
  public hitstopFrames = 0;
  public stunTimer = 0;
  public ticksOutsideBlockstun = 0;
  public homingDashCooldown = 0;
  public armorHitsRemaining = 0;

  // Combo & anti-infinite tracking
  public comboHitCount = 0;
  public juggleHitCount = 0;
  public launchCount = 0;
  public usedFreeLauncherDash = false;
  public usedWallBounce = false;
  public usedTeleportInCombo = false;

  // Hit confirmation & re-hit registry
  public moveHitConfirmed: 'NONE' | 'ON_HIT' | 'ON_BLOCK' = 'NONE';
  public pendingCancelMoveId: string | null = null;
  private readonly hitRegistry: Map<string, { count: number; lastHitTick: number }> = new Map();

  // Throw pairing & latched aim
  public throwVictim: FighterController | null = null;
  public throwAttacker: FighterController | null = null;
  public latchedAimTheta = 0;
  public latchedAimPsi = 0;
  public throwConnectVictimRootY = 0;
  public throwReleaseVictimRootY = 0;
  public lastThrowFloorClampResidual = 0;

  // Layer 3 telemetry
  public lastAimTheta = 0;
  public lastAimPsi = 0;
  public readonly lastAimPivot = new THREE.Vector3();
  public readonly lastAimTarget = new THREE.Vector3();

  // Scale factors (§4.4)
  public readonly hurtboxScale: number;
  public readonly hitboxScale: number;
  public readonly pushboxRadius: number;

  // 8-tick input ring buffer
  public readonly inputRing: Array<FighterInputFrame & { tick: number }> = [];
  private activeInput: FighterInputFrame = {
    stickX: 0,
    stickZ: 0,
    lightPressed: false,
    heavyPressed: false,
    specialPressed: false,
    dashPressed: false,
    jumpPressed: false,
    guardHeld: false,
  };

  // Pre-allocated Pass-1 snapshot
  public readonly pass1Snapshot: Pass1Snapshot = {
    hurtboxes: [],
    pivots: {
      upper_arm_l: new THREE.Vector3(),
      upper_arm_r: new THREE.Vector3(),
      thigh_l: new THREE.Vector3(),
      thigh_r: new THREE.Vector3(),
      spine: new THREE.Vector3(),
    },
  };

  constructor(
    fighterIndex: number,
    config: CharacterConfig,
    moveset: Record<string, MoveSpec>,
    modelRoot: THREE.Object3D,
    clips: THREE.AnimationClip[],
    canonicalClipLengths: Record<string, number>,
    clipSubsetMode: 'gate0' | 'all' = 'all',
  ) {
    this.fighterIndex = fighterIndex;
    this.config = config;
    this.moveset = moveset;
    this.clipSubsetMode = clipSubsetMode;

    this.maxHealth = config.stats.maxHealth;
    this.health = this.maxHealth;
    this.maxGuard = config.stats.maxGuard;
    this.guardMeter = this.maxGuard;
    this.maxMeter = config.stats.maxMeter;

    const hRatio = config.model.heightMeters / 1.80;
    this.hurtboxScale = clamp(hRatio, 0.75, 1.35);
    this.hitboxScale = clamp(hRatio, 1.0, 1.35);
    this.pushboxRadius = 0.30 * this.hurtboxScale;

    this.root = new THREE.Group();
    this.root.name = `FighterRoot_${config.id}_${fighterIndex}`;
    this.visualShakeGroup = new THREE.Group();
    this.visualShakeGroup.add(modelRoot);
    this.root.add(this.visualShakeGroup);

    // Bind 16 canonical sockets (support both raw .L/.R and GLTFLoader sanitized names)
    for (const [socketKey, boneName] of Object.entries(config.boneMap)) {
      const obj =
        modelRoot.getObjectByName(boneName) ??
        modelRoot.getObjectByName(boneName.replace(/\./g, '')) ??
        modelRoot.getObjectByName(boneName.replace(/\./g, '_'));
      if (obj) {
        this.sockets.set(socketKey, obj);
      }
    }

    this.mixer = new THREE.AnimationMixer(modelRoot);
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      this.actions.set(clip.name, action);
      this.clipFrameCounts.set(
        clip.name,
        canonicalClipLengths[clip.name] ?? Math.round(clip.duration * 60),
      );
    }
    for (const [cname, len] of Object.entries(canonicalClipLengths)) {
      if (!this.clipFrameCounts.has(cname)) {
        this.clipFrameCounts.set(cname, len);
      }
    }

    for (const hb of config.hurtboxes) {
      this.pass1Snapshot.hurtboxes.push({
        id: hb.id,
        socket: hb.socket,
        centerWorld: new THREE.Vector3(),
      });
    }

    this.playStateClip('idle', true);
  }

  public resetForRound(spawnX: number, spawnZ: number, facingTargetX: number): void {
    this.position.set(spawnX, 0, spawnZ);
    this.velocity.set(0, 0, 0);
    const dx = facingTargetX - spawnX;
    this.forward.set(dx >= 0 ? 1 : -1, 0, 0).normalize();
    this.right.crossVectors(this.forward, WORLD_UP).normalize();
    this.renderedYawRad = Math.atan2(this.forward.x, this.forward.z);
    this.syncRootTransform();

    this.health = this.maxHealth;
    this.guardMeter = this.maxGuard;
    this.hitstopFrames = 0;
    this.stunTimer = 0;
    this.homingDashCooldown = 0;
    this.throwVictim = null;
    this.throwAttacker = null;
    this.resetComboTracking();
    this.inputRing.length = 0;
    this.transitionToState('IDLE');
  }

  public resetComboTracking(): void {
    this.comboHitCount = 0;
    this.juggleHitCount = 0;
    this.launchCount = 0;
    this.usedFreeLauncherDash = false;
    this.usedWallBounce = false;
    this.usedTeleportInCombo = false;
  }

  public syncRootTransform(): void {
    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.renderedYawRad, 0);
  }

  public updateTargetBasis(opponent: FighterController, allowFullTurn: boolean, turnRateDegPerSec = 720): void {
    const dx = opponent.position.x - this.position.x;
    const dz = opponent.position.z - this.position.z;
    const dXZ = Math.hypot(dx, dz);
    if (dXZ >= 1e-4) {
      this.forward.set(dx / dXZ, 0, dz / dXZ);
      this.right.crossVectors(this.forward, WORLD_UP).normalize();
    }
    if (allowFullTurn) {
      const desiredYaw = Math.atan2(this.forward.x, this.forward.z);
      let diff = desiredYaw - this.renderedYawRad;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const maxStep = (turnRateDegPerSec * Math.PI) / (180 * 60);
      this.renderedYawRad += clamp(diff, -maxStep, maxStep);
    }
    this.syncRootTransform();
  }

  public pushInput(tick: number, input: Partial<FighterInputFrame>): void {
    const full: FighterInputFrame & { tick: number } = {
      tick,
      stickX: input.stickX ?? 0,
      stickZ: input.stickZ ?? 0,
      lightPressed: input.lightPressed ?? false,
      heavyPressed: input.heavyPressed ?? false,
      specialPressed: input.specialPressed ?? false,
      dashPressed: input.dashPressed ?? false,
      jumpPressed: input.jumpPressed ?? false,
      guardHeld: input.guardHeld ?? false,
    };
    this.activeInput = full;
    this.inputRing.push(full);
    while (this.inputRing.length > 8) {
      this.inputRing.shift();
    }
    // Check if an input during hitstop or cancel window latches a pending cancel
    if (this.activeMoveId) {
      const latched = this.tryMatchCancelInput();
      if (latched) {
        this.pendingCancelMoveId = latched;
      }
    }
  }

  private restorePass1Quaternions(): void {
    for (const [sockKey, q] of this.pass1Quaternions) {
      const bone = this.sockets.get(sockKey);
      if (bone) {
        bone.quaternion.copy(q);
      }
    }
  }

  private playStateClip(clipName: string, loopRepeat: boolean): void {
    this.restorePass1Quaternions();
    let resolvedClip = clipName;
    if (!this.actions.has(resolvedClip)) {
      if (this.clipSubsetMode === 'gate0') {
        if (!this.loggedSubstitutions.has(resolvedClip)) {
          this.loggedSubstitutions.add(resolvedClip);
        }
        resolvedClip = 'idle';
      } else {
        throw new Error(`Missing required animation clip '${resolvedClip}' on ${this.config.id}`);
      }
    }
    const nextAction = this.actions.get(resolvedClip);
    if (!nextAction) return;

    if (this.activeAction && this.activeAction !== nextAction) {
      this.activeAction.stop();
    }
    nextAction.reset();
    nextAction.setLoop(loopRepeat ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    nextAction.clampWhenFinished = !loopRepeat;
    nextAction.play();
    this.activeAction = nextAction;
    this.activeClipName = resolvedClip;
  }

  public transitionToState(nextState: FighterStateId): void {
    const wasInThrow = this.activeMoveId && this.moveset[this.activeMoveId]?.type === 'THROW';
    if (
      wasInThrow &&
      nextState !== 'ATTACK_STARTUP' &&
      nextState !== 'ATTACK_ACTIVE' &&
      nextState !== 'ATTACK_RECOVERY' &&
      this.throwVictim
    ) {
      // Forced release (§4.4.2): attacker interrupted while holding a victim
      const victim = this.throwVictim;
      this.throwVictim = null;
      victim.throwAttacker = null;
      victim.position.y = Math.max(0.05, victim.position.y);
      const invW = 1.0 / victim.config.stats.weight;
      const invSqrtW = 1.0 / Math.sqrt(victim.config.stats.weight);
      victim.velocity
        .copy(victim.forward)
        .multiplyScalar(-3.0 * invW)
        .addScaledVector(WORLD_UP, 4.0 * invSqrtW);
      victim.transitionToState('LAUNCHED');
    }

    this.state = nextState;
    this.stateInstanceId++;
    this.stateFrame = 1;
    this.currentAnimFrame = 0;

    if (
      nextState === 'IDLE' ||
      nextState === 'MOVE' ||
      nextState === 'GUARD' ||
      nextState === 'KNOCKDOWN'
    ) {
      this.resetComboTracking();
    }

    if (
      nextState !== 'ATTACK_STARTUP' &&
      nextState !== 'ATTACK_ACTIVE' &&
      nextState !== 'ATTACK_RECOVERY'
    ) {
      this.activeMoveId = null;
      this.moveFrame = 0;
      this.pendingCancelMoveId = null;
      this.armorHitsRemaining = 0;
    }

    switch (nextState) {
      case 'IDLE':
        this.velocity.x = 0;
        this.velocity.z = 0;
        this.playStateClip('idle', true);
        break;
      case 'MOVE':
        this.playStateClip('walk_forward', true);
        break;
      case 'STEP_DODGE':
        this.playStateClip('step_dodge', false);
        break;
      case 'HOMING_DASH':
        this.playStateClip('dash_forward', true);
        break;
      case 'JUMP':
        this.playStateClip('jump_loop', true);
        break;
      case 'GUARD':
        this.velocity.x = 0;
        this.velocity.z = 0;
        this.playStateClip('guard', true);
        break;
      case 'BLOCKSTUN':
        this.playStateClip('guard', false);
        break;
      case 'GUARD_CRUSH':
        this.guardMeter = this.maxGuard; // Reset on entry (§6.4.3)
        this.stunTimer = 45;
        this.velocity.set(0, 0, 0);
        this.playStateClip('guard_crush', false);
        break;
      case 'HITSTUN':
        this.playStateClip('hitstun', false);
        break;
      case 'LAUNCHED':
        this.playStateClip('launched', true);
        break;
      case 'WALL_BOUNCE':
        this.stunTimer = 16;
        this.playStateClip('wall_bounce', false);
        break;
      case 'KNOCKDOWN':
        this.stunTimer = 25;
        this.velocity.set(0, 0, 0);
        this.position.y = 0;
        this.playStateClip('knockdown', false);
        break;
      case 'WAKEUP':
        this.stunTimer = 18;
        this.velocity.set(0, 0, 0);
        this.playStateClip('wakeup', false);
        break;
      case 'THROWN':
        this.velocity.set(0, 0, 0);
        this.playStateClip('hitstun', false);
        break;
      default:
        break;
    }
  }

  public startMove(moveId: string): boolean {
    const move = this.moveset[moveId];
    if (!move) return false;

    this.activeMoveId = moveId;
    this.moveFrame = 1;
    this.currentAnimFrame = 0;
    this.moveHitConfirmed = 'NONE';
    this.pendingCancelMoveId = null;
    this.hitRegistry.clear();
    this.armorHitsRemaining = move.armor ? move.armor.hits : 0;
    this.meter = Math.min(this.maxMeter, this.meter + 10); // +10 meter on move startup (§6.4.3)

    const { activeStart } = this.getMoveActiveBounds(move);
    this.state = this.moveFrame >= activeStart ? 'ATTACK_ACTIVE' : 'ATTACK_STARTUP';
    this.stateInstanceId++;
    this.stateFrame = 1;
    this.playStateClip(move.animation, false);
    return true;
  }

  public getMoveActiveBounds(move: MoveSpec): { activeStart: number; activeEnd: number } {
    let minF = move.totalFrames;
    let maxF = 1;
    if (move.hitboxes && move.hitboxes.length > 0) {
      for (const hb of move.hitboxes) {
        minF = Math.min(minF, hb.startFrame);
        maxF = Math.max(maxF, hb.endFrame);
      }
    } else if (move.projectile && move.projectile.spawnFrames.length > 0) {
      minF = Math.min(...move.projectile.spawnFrames);
      maxF = Math.max(...move.projectile.spawnFrames);
    } else if (move.teleport) {
      minF = move.teleport.vanishFrame;
      maxF = move.teleport.reappearFrame;
    }
    return { activeStart: minF, activeEnd: maxF };
  }

  private getInputDirection(): InputDirection {
    const { stickX, stickZ } = this.activeInput;
    if (Math.abs(stickZ) >= Math.abs(stickX) && Math.abs(stickZ) > 0.3) {
      return stickZ > 0 ? 'FORWARD' : 'BACK';
    }
    if (Math.abs(stickX) > 0.3) {
      return 'LATERAL';
    }
    return 'NEUTRAL';
  }

  private tryMatchMoveFromInput(allowedIds: string[] | null, airborne: boolean): string | null {
    const dir = this.getInputDirection();
    const candidates = allowedIds ?? Object.keys(this.moveset);
    let bestNeutral: string | null = null;

    for (const id of candidates) {
      if (id === 'homing_dash') {
        if (this.activeInput.dashPressed) return 'homing_dash';
        continue;
      }
      const mv = this.moveset[id];
      if (!mv) continue;
      if (allowedIds === null && mv.chainOnly) continue;
      if (mv.input.airborne !== airborne) continue;

      const btnMatch =
        (mv.input.button === 'LIGHT' && this.activeInput.lightPressed) ||
        (mv.input.button === 'HEAVY' && this.activeInput.heavyPressed) ||
        (mv.input.button === 'SPECIAL' && this.activeInput.specialPressed);
      if (!btnMatch) continue;

      if (mv.input.direction === dir && dir !== 'NEUTRAL') {
        return id; // Directional command moves take strict priority over NEUTRAL/ANY (§5.4)
      }
      if (mv.input.direction === 'ANY' || mv.input.direction === dir) {
        if (!bestNeutral) bestNeutral = id;
      }
    }
    return bestNeutral;
  }

  private tryMatchCancelInput(): string | null {
    if (!this.activeMoveId) return null;
    const mv = this.moveset[this.activeMoveId];
    if (!mv?.cancels) return null;
    const airborne = this.position.y > 0.05;

    for (const cw of mv.cancels) {
      if (this.moveFrame < cw.startFrame || this.moveFrame > cw.endFrame) continue;
      const condOk =
        cw.condition === 'ALWAYS' ||
        (cw.condition === 'ON_HIT' && this.moveHitConfirmed === 'ON_HIT') ||
        (cw.condition === 'ON_BLOCK' && this.moveHitConfirmed === 'ON_BLOCK') ||
        (cw.condition === 'ON_HIT_OR_BLOCK' &&
          (this.moveHitConfirmed === 'ON_HIT' || this.moveHitConfirmed === 'ON_BLOCK'));
      if (!condOk) continue;

      const matched = this.tryMatchMoveFromInput(cw.targets, airborne);
      if (matched) {
        if (
          cw.condition === 'ALWAYS' &&
          mv.type === 'TELEPORT' &&
          this.usedTeleportInCombo
        ) {
          continue;
        }
        return matched;
      }
    }
    return null;
  }

  public stepTimersAndInputs(opponent: FighterController): void {
    if (this.homingDashCooldown > 0) this.homingDashCooldown--;
    if (this.state !== 'BLOCKSTUN') {
      this.ticksOutsideBlockstun++;
      if (this.ticksOutsideBlockstun > 60 && this.guardMeter < this.maxGuard) {
        this.guardMeter = Math.min(this.maxGuard, this.guardMeter + 40 / 60);
      }
    } else {
      this.ticksOutsideBlockstun = 0;
    }

    if (this.hitstopFrames > 0) {
      this.hitstopFrames--;
      const sign = this.hitstopFrames % 2 === 0 ? 1 : -1;
      this.visualShakeGroup.position.x = sign * 0.04;
      if (this.hitstopFrames > 0) {
        return; // Frozen during hitstop
      }
      this.visualShakeGroup.position.x = 0;
    } else {
      this.visualShakeGroup.position.x = 0;
    }

    // Execute latched cancel on the first frame after hitstop ends
    if (this.pendingCancelMoveId && this.activeMoveId) {
      const targetId = this.pendingCancelMoveId;
      this.pendingCancelMoveId = null;
      const curMove = this.moveset[this.activeMoveId];
      if (curMove?.type === 'TELEPORT') {
        this.usedTeleportInCombo = true;
      }
      if (targetId === 'homing_dash') {
        if (curMove?.hitboxes?.some((h) => h.launch) && !this.usedFreeLauncherDash) {
          this.usedFreeLauncherDash = true;
          this.startHomingDash(opponent, true);
          return;
        }
      } else {
        this.startMove(targetId);
        return;
      }
    }

    // Advance state frames & transitions
    if (this.activeMoveId) {
      const move = this.moveset[this.activeMoveId];
      // Check live cancel window
      const cancelTarget = this.tryMatchCancelInput();
      if (cancelTarget) {
        if (cancelTarget === 'homing_dash') {
          this.usedFreeLauncherDash = true;
          this.startHomingDash(opponent, true);
          return;
        }
        if (move.type === 'TELEPORT') {
          this.usedTeleportInCombo = true;
        }
        this.startMove(cancelTarget);
        return;
      }

      this.moveFrame++;
      this.stateFrame++;
      if (this.moveFrame > move.totalFrames) {
        this.transitionToState(this.position.y > 0.05 ? 'JUMP' : 'IDLE');
        return;
      }
      this.currentAnimFrame = this.moveFrame - 1;
      const { activeStart, activeEnd } = this.getMoveActiveBounds(move);
      if (this.moveFrame < activeStart) {
        this.state = 'ATTACK_STARTUP';
      } else if (this.moveFrame <= activeEnd) {
        this.state = 'ATTACK_ACTIVE';
      } else {
        this.state = 'ATTACK_RECOVERY';
      }

      // Check Stage B throw release at throwReleaseFrame (§4.4.2)
      if (move.type === 'THROW' && this.throwVictim && move.hitboxes?.[0]) {
        const hb = move.hitboxes[0];
        if (this.moveFrame === hb.throwReleaseFrame) {
          const victim = this.throwVictim;
          this.throwReleaseVictimRootY = victim.position.y;
          this.throwVictim = null;
          victim.throwAttacker = null;
          victim.position.y = Math.max(0.05, victim.position.y);
          victim.comboHitCount++;
          victim.juggleHitCount = 1;
          victim.launchCount = 1;
          const proration = Math.max(0.20, Math.pow(0.90, victim.comboHitCount - 1));
          victim.health = Math.max(0, victim.health - Math.round(hb.damage * proration));
          this.hitstopFrames = hb.hitstopFrames;
          victim.hitstopFrames = hb.hitstopFrames;
          const invW = 1.0 / victim.config.stats.weight;
          const invSqrtW = 1.0 / Math.sqrt(victim.config.stats.weight);
          victim.velocity
            .copy(victim.forward)
            .multiplyScalar(hb.knockback.forward * invW)
            .addScaledVector(victim.right, hb.knockback.lateral * invW)
            .addScaledVector(WORLD_UP, hb.knockback.up * invSqrtW);
          victim.transitionToState('LAUNCHED');
        }
      }
      return;
    }

    // Non-attack states
    this.stateFrame++;
    const clipLen = this.clipFrameCounts.get(this.activeClipName) ?? 30;

    switch (this.state) {
      case 'IDLE':
      case 'MOVE': {
        this.currentAnimFrame = (this.stateFrame - 1) % clipLen;
        this.updateTargetBasis(opponent, true, 720);
        const moveMatch = this.tryMatchMoveFromInput(null, false);
        if (moveMatch) {
          this.startMove(moveMatch);
          return;
        }
        if (this.activeInput.guardHeld) {
          this.transitionToState('GUARD');
          return;
        }
        if (this.activeInput.jumpPressed) {
          this.velocity.y = this.config.stats.jumpVelocity;
          this.transitionToState('JUMP');
          return;
        }
        if (this.activeInput.dashPressed) {
          const dir = this.getInputDirection();
          if (dir === 'LATERAL') {
            this.transitionToState('STEP_DODGE');
            return;
          }
          if (this.meter >= 150 || this.homingDashCooldown === 0) {
            this.startHomingDash(opponent, this.homingDashCooldown === 0);
            return;
          }
        }
        const hasStick =
          Math.abs(this.activeInput.stickX) > 0.1 || Math.abs(this.activeInput.stickZ) > 0.1;
        if (hasStick && this.state === 'IDLE') {
          this.transitionToState('MOVE');
        } else if (!hasStick && this.state === 'MOVE') {
          this.transitionToState('IDLE');
        }
        break;
      }
      case 'STEP_DODGE': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        if (this.stateFrame >= 11 && this.stateFrame <= 18) {
          const moveMatch = this.tryMatchMoveFromInput(null, false);
          if (moveMatch) {
            this.startMove(moveMatch);
            return;
          }
        }
        if (this.stateFrame >= 18) {
          this.transitionToState('IDLE');
        }
        break;
      }
      case 'HOMING_DASH': {
        this.currentAnimFrame = (this.stateFrame - 1) % clipLen;
        this.updateTargetBasis(opponent, true, 1080);
        const airborne = this.position.y > 0.05;
        if (this.activeInput.lightPressed) {
          this.startMove(airborne ? 'air_light_1' : 'light_1');
          return;
        }
        const d3d = this.position.distanceTo(opponent.position);
        if (d3d <= 1.4 || this.stateFrame >= 36) {
          this.transitionToState(airborne ? 'JUMP' : 'IDLE');
        }
        break;
      }
      case 'JUMP': {
        this.currentAnimFrame = (this.stateFrame - 1) % clipLen;
        const airMove = this.tryMatchMoveFromInput(null, true);
        if (airMove) {
          this.startMove(airMove);
          return;
        }
        if (this.activeInput.dashPressed && this.meter >= 150) {
          this.startHomingDash(opponent, false);
        }
        break;
      }
      case 'GUARD': {
        this.currentAnimFrame = (this.stateFrame - 1) % clipLen;
        this.updateTargetBasis(opponent, true, 720);
        if (!this.activeInput.guardHeld) {
          this.transitionToState('IDLE');
        }
        break;
      }
      case 'BLOCKSTUN': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        this.stunTimer--;
        if (this.guardMeter <= 0) {
          this.transitionToState('GUARD_CRUSH');
        } else if (this.stunTimer <= 0) {
          this.transitionToState(this.activeInput.guardHeld ? 'GUARD' : 'IDLE');
        }
        break;
      }
      case 'GUARD_CRUSH':
      case 'HITSTUN': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        this.stunTimer--;
        if (this.stunTimer <= 0) {
          this.transitionToState('IDLE');
        }
        break;
      }
      case 'LAUNCHED': {
        this.currentAnimFrame = (this.stateFrame - 1) % clipLen;
        break;
      }
      case 'WALL_BOUNCE': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        this.stunTimer--;
        if (this.stunTimer <= 0) {
          this.transitionToState('LAUNCHED');
        }
        break;
      }
      case 'KNOCKDOWN': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        this.stunTimer--;
        if (this.stunTimer <= 0) {
          this.transitionToState('WAKEUP');
        }
        break;
      }
      case 'WAKEUP': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        this.stunTimer--;
        if (this.stunTimer <= 0) {
          this.transitionToState('IDLE');
        }
        break;
      }
      case 'THROWN': {
        this.currentAnimFrame = Math.min(this.stateFrame - 1, clipLen - 1);
        break;
      }
    }
  }

  public startHomingDash(opponent: FighterController, isFree: boolean): void {
    if (!isFree) {
      this.meter = Math.max(0, this.meter - 150);
    } else if (this.position.y <= 0.05 && !this.usedFreeLauncherDash) {
      this.homingDashCooldown = 120;
    }
    this.transitionToState('HOMING_DASH');
  }

  public integrateVelocityAndGravity(opponent: FighterController): void {
    if (this.hitstopFrames > 0 || this.state === 'THROWN') return;

    const dt = 1.0 / 60.0;

    if (this.activeMoveId) {
      const move = this.moveset[this.activeMoveId];
      if (move.tracking && this.moveFrame >= move.tracking.startFrame && this.moveFrame <= move.tracking.endFrame) {
        this.updateTargetBasis(opponent, true, move.tracking.turnRateDegPerSec);
      } else {
        this.updateTargetBasis(opponent, false, 0);
      }

      // Teleport destination & corner-flank fallback (§5.4)
      if (move.type === 'TELEPORT' && move.teleport && this.moveFrame === move.teleport.reappearFrame) {
        const dOff = Math.abs(move.teleport.offsetMeters);
        const rClamp = move.teleport.clampArenaRadiusMeters;
        _tmpVecA.copy(opponent.position).addScaledVector(opponent.forward, -dOff);
        _tmpVecA.y = 0;
        const rCand = Math.hypot(_tmpVecA.x, _tmpVecA.z);
        if (rCand > rClamp) {
          _tmpVecA.multiplyScalar(rClamp / rCand);
        }
        const clearance = this.pushboxRadius + opponent.pushboxRadius + 0.35;
        if (_tmpVecA.distanceTo(opponent.position) < clearance) {
          // Corner-flank fallback: choose inner lateral flank closer to arena center
          const flankPos = _tmpVecA.copy(opponent.position).addScaledVector(opponent.right, dOff);
          const flankNeg = _tmpVecB.copy(opponent.position).addScaledVector(opponent.right, -dOff);
          if (flankNeg.lengthSq() < flankPos.lengthSq()) {
            this.position.copy(flankNeg);
          } else {
            this.position.copy(flankPos);
          }
        } else {
          this.position.copy(_tmpVecA);
        }
        if (move.teleport.faceOpponentOnExit) {
          this.updateTargetBasis(opponent, true, 36000);
        }
      }

      let vx = 0;
      let vz = 0;
      let vy = this.position.y > 0.05 ? this.velocity.y : 0;
      for (const vw of move.velocity ?? []) {
        if (this.moveFrame >= vw.startFrame && this.moveFrame <= vw.endFrame) {
          vx = this.forward.x * vw.forward + this.right.x * vw.lateral;
          vz = this.forward.z * vw.forward + this.right.z * vw.lateral;
          if (vw.up !== 0) vy = vw.up;
        }
      }
      this.velocity.set(vx, vy, vz);
    } else if (this.state === 'MOVE') {
      const fwd = this.activeInput.stickZ * this.config.stats.walkSpeed;
      const lat = this.activeInput.stickX * this.config.stats.strafeSpeed;
      this.velocity.x = this.forward.x * fwd + this.right.x * lat;
      this.velocity.z = this.forward.z * fwd + this.right.z * lat;
    } else if (this.state === 'STEP_DODGE') {
      const sign = this.activeInput.stickX >= 0 ? 1 : -1;
      this.velocity.x = this.right.x * sign * this.config.stats.dashSpeed;
      this.velocity.z = this.right.z * sign * this.config.stats.dashSpeed;
    } else if (this.state === 'HOMING_DASH') {
      _tmpVecA.subVectors(opponent.position, this.position);
      if (_tmpVecA.lengthSq() > 1e-6) {
        _tmpVecA.normalize().multiplyScalar(this.config.stats.homingDashSpeed);
        this.velocity.copy(_tmpVecA);
      }
    } else if (this.state === 'HITSTUN' || this.state === 'BLOCKSTUN') {
      // Linearly decay horizontal knockback velocity to 0
      const decay = this.stunTimer > 1 ? (this.stunTimer - 1) / this.stunTimer : 0;
      this.velocity.x *= decay;
      this.velocity.z *= decay;
    }

    this.position.addScaledVector(this.velocity, dt);

    // Apply gravity when airborne or in LAUNCHED/JUMP/WALL_BOUNCE
    if (this.position.y > 0 || this.velocity.y > 0 || this.state === 'LAUNCHED' || this.state === 'WALL_BOUNCE') {
      const juggleScale = this.state === 'LAUNCHED' ? 1.0 + 0.12 * this.juggleHitCount : 1.0;
      this.velocity.y -= this.config.stats.gravity * juggleScale * dt;
      if (this.position.y <= 0 && this.velocity.y <= 0) {
        this.position.y = 0;
        this.velocity.y = 0;
        if (this.state === 'LAUNCHED' || this.state === 'WALL_BOUNCE') {
          // Check wall bounce vs floor knockdown
          this.transitionToState('KNOCKDOWN');
        } else if (this.state === 'JUMP') {
          this.transitionToState('IDLE');
        }
      }
    }

    // Wall bounce check during LAUNCHED (§6.4.6)
    if (this.state === 'LAUNCHED' && !this.usedWallBounce) {
      const rXZ = Math.hypot(this.position.x, this.position.z);
      if (rXZ >= 19.5) {
        const radialVel = (this.position.x * this.velocity.x + this.position.z * this.velocity.z) / rXZ;
        if (radialVel > 8.0) {
          this.usedWallBounce = true;
          this.velocity.x = -this.velocity.x * 0.45;
          this.velocity.z = -this.velocity.z * 0.45;
          this.velocity.y = Math.max(this.velocity.y, 5.5);
          this.transitionToState('WALL_BOUNCE');
        }
      }
    }

    this.syncRootTransform();
  }

  /**
   * Pass 1 Pose Seek (§6.1 Step 4 & Condition 2)
   */
  public seekBasePosePass1(): void {
    if (this.hitstopFrames === 0) {
      this.restorePass1Quaternions();
      this.mixer.setTime((this.currentAnimFrame + 0.001) / 60.0);
      for (const [sockKey, bone] of this.sockets) {
        let q = this.pass1Quaternions.get(sockKey);
        if (!q) {
          q = new THREE.Quaternion();
          this.pass1Quaternions.set(sockKey, q);
        }
        q.copy(bone.quaternion);
      }
    }
    this.root.updateMatrixWorld(true);
  }

  /**
   * Step 4b: Snapshot un-pitched hurtbox centers and Layer 3 pivot sockets after Pass 1.
   */
  public capturePass1Snapshot(): void {
    for (let i = 0; i < this.config.hurtboxes.length; i++) {
      const spec = this.config.hurtboxes[i];
      const snap = this.pass1Snapshot.hurtboxes[i];
      this.computeSocketOffsetWorld(spec.socket, spec.offset, spec.scaleWithHeight !== false ? this.hurtboxScale : 1.0, snap.centerWorld);
    }
    for (const sockKey of Object.keys(this.pass1Snapshot.pivots)) {
      const bone = this.sockets.get(sockKey);
      if (bone) {
        bone.getWorldPosition(this.pass1Snapshot.pivots[sockKey]);
      } else {
        this.pass1Snapshot.pivots[sockKey].copy(this.position);
      }
    }
  }

  public shouldApplyPitchAiming(): boolean {
    if (!this.activeMoveId) return false;
    const mv = this.moveset[this.activeMoveId];
    return Boolean(mv && mv.pitchTracking && mv.pitchLimb);
  }

  /**
   * Pass 2: Layer 3 Dynamic Upper-Body Pitch & Limb Yaw Aiming (§4.3).
   */
  public applyLayer3PitchAiming(opponentSnapshot: Pass1Snapshot): void {
    if (!this.activeMoveId) return;
    const mv = this.moveset[this.activeMoveId];
    if (!mv?.pitchTracking || !mv.pitchLimb) return;

    let theta = 0;
    let psi = 0;

    if (this.throwVictim !== null) {
      // Latched during throws (§4.3): prevent positive-feedback ratcheting
      theta = this.latchedAimTheta;
      psi = this.latchedAimPsi;
    } else {
      const limb = mv.pitchLimb;
      const pivKey =
        limb === 'upper_arm_l'
          ? 'upper_arm_l'
          : limb === 'upper_arm_r' || limb === 'both_arms'
            ? 'upper_arm_r'
            : limb === 'thigh_l'
              ? 'thigh_l'
              : limb === 'thigh_r' || limb === 'both_legs'
                ? 'thigh_r'
                : 'spine';

      const pPiv = this.pass1Snapshot.pivots[pivKey] ?? this.position;
      this.lastAimPivot.copy(pPiv);

      // Select defender hurtbox whose height Y_h is closest to Y_piv (ties -> chest)
      let bestHurt = opponentSnapshot.hurtboxes[0];
      let bestDy = Infinity;
      for (const h of opponentSnapshot.hurtboxes) {
        const dy = Math.abs(h.centerWorld.y - pPiv.y);
        if (dy < bestDy - 1e-6 || (Math.abs(dy - bestDy) <= 1e-6 && h.socket === 'chest')) {
          bestDy = dy;
          bestHurt = h;
        }
      }

      const pTgt = bestHurt ? bestHurt.centerWorld : this.position;
      this.lastAimTarget.copy(pTgt);

      const dx = pTgt.x - pPiv.x;
      const dy = pTgt.y - pPiv.y;
      const dz = pTgt.z - pPiv.z;
      const dXZ = Math.hypot(dx, dz);

      const minPitchRad = (-55 * Math.PI) / 180;
      const maxPitchRad = (40 * Math.PI) / 180;
      theta = clamp(Math.atan2(dy, Math.max(dXZ, 0.6)), minPitchRad, maxPitchRad);

      // R_world derived from rate-limited renderedYawRad
      const rWorldX = -Math.cos(this.renderedYawRad);
      const rWorldZ = Math.sin(this.renderedYawRad);
      const latOffset = dx * rWorldX + dz * rWorldZ;
      const maxYawRad = (25 * Math.PI) / 180;
      psi = clamp(Math.atan2(latOffset, Math.max(dXZ, 0.01)), -maxYawRad, maxYawRad);

      this.lastAimTheta = theta;
      this.lastAimPsi = psi;
    }

    // World right axis from renderedYawRad: F = (sin(yaw), 0, cos(yaw)), R = F x Y = (-cos(yaw), 0, sin(yaw))
    const rWorld = _tmpVecA.set(-Math.cos(this.renderedYawRad), 0, Math.sin(this.renderedYawRad)).normalize();

    const pitchBoneParentLocal = (socketKey: string, alpha: number, applyLimbYaw: boolean): void => {
      const bone = this.sockets.get(socketKey);
      if (!bone || !bone.parent) return;
      bone.parent.getWorldQuaternion(_tmpQuatParentWorld);
      const qParentInv = _tmpQuatParentWorld.invert();

      _tmpAxisLocal.copy(rWorld).applyQuaternion(qParentInv).normalize();
      _tmpQuatPitch.setFromAxisAngle(_tmpAxisLocal, alpha * theta);
      bone.quaternion.premultiply(_tmpQuatPitch);

      if (applyLimbYaw && Math.abs(psi) > 1e-6) {
        // Apply -psi around world +Y transformed into parent-local space after pitch
        _tmpAxisLocal.copy(WORLD_UP).applyQuaternion(qParentInv).normalize();
        _tmpQuatYaw.setFromAxisAngle(_tmpAxisLocal, -psi);
        bone.quaternion.premultiply(_tmpQuatYaw);
      }
      bone.updateWorldMatrix(false, true);
    };

    const profile = mv.pitchLimb;
    if (profile === 'upper_arm_l' || profile === 'upper_arm_r' || profile === 'both_arms') {
      pitchBoneParentLocal('spine', 0.4, false);
      if (profile === 'upper_arm_l' || profile === 'both_arms') {
        pitchBoneParentLocal('upper_arm_l', 0.6, true);
      }
      if (profile === 'upper_arm_r' || profile === 'both_arms') {
        pitchBoneParentLocal('upper_arm_r', 0.6, true);
      }
    } else if (profile === 'thigh_l' || profile === 'thigh_r' || profile === 'both_legs') {
      pitchBoneParentLocal('spine', 0.2, false);
      if (profile === 'thigh_l' || profile === 'both_legs') {
        pitchBoneParentLocal('thigh_l', 1.0, true);
      }
      if (profile === 'thigh_r' || profile === 'both_legs') {
        pitchBoneParentLocal('thigh_r', 1.0, true);
      }
    } else if (profile === 'torso') {
      pitchBoneParentLocal('spine', 0.5, false);
      pitchBoneParentLocal('chest', 0.5, false);
    }

    this.root.updateMatrixWorld(true); // Pass 2 updateMatrixWorld
  }

  /**
   * Pass 3: Layer 4 Stage A Victim Root Alignment to Attacker's hand_r (§4.4.2).
   */
  public pinVictimToAttackerHand(): void {
    if (this.state !== 'THROWN' || !this.throwAttacker) return;
    const handBone = this.throwAttacker.sockets.get('hand_r');
    const chestBone = this.sockets.get('chest');
    if (!handBone || !chestBone) return;

    const pHand = handBone.getWorldPosition(_tmpVecA);
    const pChest = chestBone.getWorldPosition(_tmpVecB);

    this.position.x += pHand.x - pChest.x;
    this.position.y += pHand.y - pChest.y;
    this.position.z += pHand.z - pChest.z;

    // Clamp to arena floor and boundary
    const unclampedY = this.position.y;
    if (this.position.y < 0.0) {
      this.position.y = 0.0;
    }
    this.lastThrowFloorClampResidual = Math.max(0.0, -unclampedY);

    const rXZ = Math.hypot(this.position.x, this.position.z);
    if (rXZ > 19.2) {
      this.position.x *= 19.2 / rXZ;
      this.position.z *= 19.2 / rXZ;
    }

    this.syncRootTransform();
    this.root.updateMatrixWorld(true); // Pass 3 updateMatrixWorld
  }

  public computeSocketOffsetWorld(
    socketKey: string,
    offset: [number, number, number],
    scaleFactor: number,
    outWorld: THREE.Vector3,
  ): THREE.Vector3 {
    const bone = this.sockets.get(socketKey);
    outWorld.set(offset[0] * scaleFactor, offset[1] * scaleFactor, offset[2] * scaleFactor);
    if (bone) {
      outWorld.applyMatrix4(bone.matrixWorld);
    } else {
      outWorld.add(this.position);
    }
    return outWorld;
  }

  public getHurtboxesWorld(): HurtboxVolume[] {
    return this.config.hurtboxes.map((hb) => {
      const s = hb.scaleWithHeight !== false ? this.hurtboxScale : 1.0;
      const centerWorld = new THREE.Vector3();
      this.computeSocketOffsetWorld(hb.socket, hb.offset, s, centerWorld);
      return {
        id: hb.id,
        socket: hb.socket,
        scaledRadius: hb.radius * s,
        centerWorld,
      };
    });
  }

  public getActiveHitboxesWorld(): ActiveHitboxVolume[] {
    if (!this.activeMoveId) return [];
    const mv = this.moveset[this.activeMoveId];
    if (!mv?.hitboxes) return [];

    const out: ActiveHitboxVolume[] = [];
    for (const hb of mv.hitboxes) {
      if (this.moveFrame < hb.startFrame || this.moveFrame > hb.endFrame) continue;
      const s = hb.scaleWithHeight !== false ? this.hitboxScale : 1.0;
      const startWorld = new THREE.Vector3();
      const endWorld = new THREE.Vector3();
      this.computeSocketOffsetWorld(hb.socket, hb.offset, s, startWorld);
      if (hb.endSocket) {
        this.computeSocketOffsetWorld(hb.endSocket, hb.offset, s, endWorld);
      } else {
        endWorld.copy(startWorld);
      }
      out.push({
        ...hb,
        scaledRadius: hb.radius * s,
        startWorld,
        endWorld,
        isThrow: mv.type === 'THROW',
      });
    }
    return out;
  }

  public isInTeleportInvulnerability(): boolean {
    if (!this.activeMoveId) return false;
    const mv = this.moveset[this.activeMoveId];
    if (mv?.type !== 'TELEPORT' || !mv.teleport) return false;
    const [invStart, invEnd] = mv.teleport.invulnerableFrames;
    return this.moveFrame >= invStart && this.moveFrame <= invEnd;
  }

  public isInTeleportVanish(): boolean {
    if (!this.activeMoveId) return false;
    const mv = this.moveset[this.activeMoveId];
    if (mv?.type !== 'TELEPORT' || !mv.teleport) return false;
    return this.moveFrame >= mv.teleport.vanishFrame && this.moveFrame < mv.teleport.reappearFrame;
  }

  public isArmorActiveOnCurrentFrame(): boolean {
    if (!this.activeMoveId || this.armorHitsRemaining <= 0) return false;
    const mv = this.moveset[this.activeMoveId];
    if (!mv?.armor) return false;
    return this.moveFrame >= mv.armor.startFrame && this.moveFrame <= mv.armor.endFrame;
  }

  public canHitboxRegisterHit(
    hitboxId: string,
    maxHits = 1,
    rehitIntervalFrames = 0,
    currentTick = 0,
  ): boolean {
    const entry = this.hitRegistry.get(hitboxId);
    if (!entry) return true;
    if (entry.count >= maxHits) return false;
    if (rehitIntervalFrames > 0 && currentTick - entry.lastHitTick < rehitIntervalFrames) {
      return false;
    }
    return true;
  }

  public recordHitboxHit(hitboxId: string, currentTick: number): void {
    const entry = this.hitRegistry.get(hitboxId);
    if (!entry) {
      this.hitRegistry.set(hitboxId, { count: 1, lastHitTick: currentTick });
    } else {
      entry.count++;
      entry.lastHitTick = currentTick;
    }
  }
}
