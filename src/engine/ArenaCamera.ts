import * as THREE from 'three';
import type { FighterController } from './FighterController.ts';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _p1Chest = new THREE.Vector3();
const _p2Chest = new THREE.Vector3();
const _rawF = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _chord = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class ArenaCamera {
  public readonly camera: THREE.PerspectiveCamera;
  public mode: 'LOCK_ON_1P' | 'BROADCAST' = 'BROADCAST';
  public readonly lookAtTarget = new THREE.Vector3(0, 1.2, 0);
  public readonly desiredPosition = new THREE.Vector3(0, 2.2, 5.5);
  public readonly forwardCam = new THREE.Vector3(1, 0, 0);
  public readonly rightCam = new THREE.Vector3(0, 0, 1);

  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
    this.camera.position.copy(this.desiredPosition);
    this.camera.lookAt(this.lookAtTarget);
  }

  /**
   * Deterministic 3D Arena Camera Framing & Anti-Flip Math (§6.2.1).
   */
  public updateFraming(p1: FighterController, p2: FighterController, dt = 1 / 60): void {
    p1.computeSocketOffsetWorld('chest', [0, 0.08, 0], p1.hurtboxScale, _p1Chest);
    p2.computeSocketOffsetWorld('chest', [0, 0.08, 0], p2.hurtboxScale, _p2Chest);

    const h1 = p1.config.model.heightMeters;
    const h2 = p2.config.model.heightMeters;
    const maxH = Math.max(h1, h2);

    // 1. Height-adaptive Look-At Target C_look*
    const wFocus = this.mode === 'LOCK_ON_1P' ? 0.45 : 0.50;
    this.lookAtTarget.lerpVectors(_p1Chest, _p2Chest, wFocus);
    this.lookAtTarget.y += 0.15 * maxH;

    // 2. Signed-angle anti-flip horizontal camera basis (F_cam, R_cam)
    const dx = p2.position.x - p1.position.x;
    const dz = p2.position.z - p1.position.z;
    const dXZ = Math.hypot(dx, dz);
    if (dXZ >= 1e-4) {
      _rawF.set(dx / dXZ, 0, dz / dXZ);
    } else {
      _rawF.copy(this.forwardCam);
    }

    const dot = clamp(this.forwardCam.dot(_rawF), -1.0, 1.0);
    _cross.crossVectors(this.forwardCam, _rawF);
    let delta = Math.atan2(_cross.dot(WORLD_UP), dot);

    // Exact reversal tie-break toward arena center (§6.2.1)
    if (Math.abs(dot + 1.0) < 1e-3) {
      const toCenterSign = _p1Chest.x * this.forwardCam.z - _p1Chest.z * this.forwardCam.x >= 0 ? 1 : -1;
      delta = toCenterSign * Math.PI;
    }

    const alphaRot = 1.0 - Math.exp(-10.0 * dt);
    const maxStepRad = (240.0 * Math.PI) / (180.0 * 60.0);
    const stepAngle = clamp(alphaRot * delta, -maxStepRad, maxStepRad);

    this.forwardCam.applyAxisAngle(WORLD_UP, stepAngle).normalize();
    this.rightCam.crossVectors(this.forwardCam, WORLD_UP).normalize();

    // 3. Mode A (1P Over-the-Shoulder) vs Mode B (Broadcast Sideline)
    const d3D = _p1Chest.distanceTo(_p2Chest);
    const tan25 = Math.tan((25.0 * Math.PI) / 180.0);
    const aspect = this.camera.aspect || 16 / 9;

    let dOts = 3.0;
    if (this.mode === 'LOCK_ON_1P') {
      dOts = clamp(2.8 + 0.22 * dXZ, 3.0, 6.5);
      this.desiredPosition
        .copy(_p1Chest)
        .addScaledVector(this.forwardCam, -dOts)
        .addScaledVector(this.rightCam, 1.15);
      this.desiredPosition.y += 0.65 * h1;
    } else {
      const dReq = Math.max(
        3.8,
        (0.65 * d3D) / (tan25 * aspect),
        (0.70 * (Math.abs(_p2Chest.y - _p1Chest.y) + maxH)) / tan25,
      );
      this.desiredPosition
        .copy(this.lookAtTarget)
        .addScaledVector(this.rightCam, -dReq);
      this.desiredPosition.y += 0.25 * dReq + 0.6;
    }

    // 4. Arena Wall & Floor Clamp (chord slide toward C_look* + minimum 1.5m chest clearance)
    const rCamXZ = Math.hypot(this.desiredPosition.x, this.desiredPosition.z);
    if (rCamXZ > 19.6) {
      _chord.subVectors(this.lookAtTarget, this.desiredPosition);
      // Slide along chord toward lookAtTarget until inside R <= 19.6m
      let lo = 0.0;
      let hi = 1.0;
      for (let iter = 0; iter < 12; iter++) {
        const mid = 0.5 * (lo + hi);
        const tx = this.desiredPosition.x + _chord.x * mid;
        const tz = this.desiredPosition.z + _chord.z * mid;
        if (Math.hypot(tx, tz) <= 19.6) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      this.desiredPosition.addScaledVector(_chord, hi);
    }

    if (this.mode === 'LOCK_ON_1P') {
      const dActual = this.desiredPosition.distanceTo(_p1Chest);
      if (dActual < 1.5) {
        this.desiredPosition.y += 0.4 * (dOts - dActual) + (1.5 - dActual);
      } else if (dActual < dOts) {
        this.desiredPosition.y += 0.4 * (dOts - dActual);
      }
    }

    if (this.desiredPosition.y < 0.60) {
      this.desiredPosition.y = 0.60;
    }

    const alphaPos = 1.0 - Math.exp(-14.0 * dt);
    this.camera.position.lerp(this.desiredPosition, alphaPos);
    this.camera.lookAt(this.lookAtTarget);
  }
}
