import * as THREE from "three";

import type {
  CombatantStatus,
  RoomShotClaim,
  ShotResultDecision,
  TeamAssignment,
  WeaponStateSnapshot,
} from "../net/protocol";
import type { CollisionWorld } from "./collision";

export const SHARED_WEAPON_ID = "room-rifle";

const DEFAULT_REWIND_WINDOW_MS = 1_200;
const DEFAULT_REWIND_DRIFT_MS = 180;

export interface SharedWeaponState extends WeaponStateSnapshot {
  nextReadyAt: number;
  lastShotAt: number;
  lastCompletedReloadAt: number;
  lastInputSequence: number;
}

export interface CombatantRewindState {
  id: string;
  name: string;
  team: TeamAssignment;
  status: CombatantStatus;
  health: number;
  position: THREE.Vector3;
  look: THREE.Vector3;
}

export interface RewindFrame extends CombatantRewindState {
  capturedAt: number;
}

export interface ShotValidationConfig {
  clipSize: number;
  damage: number;
  fireIntervalMs: number;
  maxLatencyMs: number;
  maxFutureSkewMs: number;
  maxInputSequenceLag: number;
  maxOriginDelta: number;
  maxAimAngleRad: number;
  maxRange: number;
  rewindDriftMs: number;
  targetRadius: number;
  targetHeight: number;
}

export interface ShotValidationContext {
  claim: RoomShotClaim;
  shooter: RewindFrame;
  targets: RewindFrame[];
  weaponState: SharedWeaponState;
  collisionWorld: CollisionWorld;
  nowMs: number;
  config: ShotValidationConfig;
}

export interface ShotResolution {
  claimId: number;
  shooterId: string;
  targetId?: string;
  decision: ShotResultDecision;
  damage: number;
  reason: string;
  shooterWeapon: WeaponStateSnapshot;
  targetHealth?: number;
  targetStatus?: CombatantStatus;
}

export class ShotRewindBuffer {
  private readonly histories = new Map<string, RewindFrame[]>();

  constructor(private readonly maxAgeMs = DEFAULT_REWIND_WINDOW_MS) {}

  record(capturedAt: number, states: CombatantRewindState[]): void {
    const minCapturedAt = capturedAt - this.maxAgeMs;
    const seenIds = new Set<string>();

    for (const state of states) {
      seenIds.add(state.id);
      const history = this.histories.get(state.id) ?? [];
      history.push(cloneFrame(state, capturedAt));

      while (history.length > 1 && history[0].capturedAt < minCapturedAt) {
        history.shift();
      }

      this.histories.set(state.id, history);
    }

    for (const [id, history] of this.histories) {
      if (!seenIds.has(id)) {
        while (history.length > 1 && history[0].capturedAt < minCapturedAt) {
          history.shift();
        }

        if (history.length === 0 || history[history.length - 1].capturedAt < minCapturedAt) {
          this.histories.delete(id);
        }
      }
    }
  }

  sample(id: string, capturedAt: number, maxDriftMs = DEFAULT_REWIND_DRIFT_MS): RewindFrame | undefined {
    const history = this.histories.get(id);
    if (!history || history.length === 0) {
      return undefined;
    }

    let best: RewindFrame | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const frame of history) {
      const delta = Math.abs(frame.capturedAt - capturedAt);
      if (delta > maxDriftMs) {
        continue;
      }

      if (delta < bestDelta) {
        best = frame;
        bestDelta = delta;
        continue;
      }

      if (delta === bestDelta && best && frame.capturedAt <= capturedAt && best.capturedAt > capturedAt) {
        best = frame;
      }
    }

    return best ? cloneFrame(best, best.capturedAt) : undefined;
  }

  latest(id: string): RewindFrame | undefined {
    const history = this.histories.get(id);
    const frame = history?.[history.length - 1];
    return frame ? cloneFrame(frame, frame.capturedAt) : undefined;
  }
}

export function createInitialWeaponState(
  ammoInClip: number,
  reserveAmmo: number,
): SharedWeaponState {
  return {
    ammoInClip,
    reserveAmmo,
    reloadSequence: 0,
    reloadEndsAt: 0,
    spreadIndex: 0,
    nextReadyAt: 0,
    lastShotAt: 0,
    lastCompletedReloadAt: 0,
    lastInputSequence: 0,
  };
}

export function syncWeaponState(
  state: SharedWeaponState,
  nowMs: number,
  clipSize: number,
): boolean {
  if (state.reloadEndsAt <= 0 || nowMs < state.reloadEndsAt) {
    return false;
  }

  const needed = Math.max(0, clipSize - state.ammoInClip);
  const refill = Math.min(needed, state.reserveAmmo);
  state.ammoInClip += refill;
  state.reserveAmmo -= refill;
  state.lastCompletedReloadAt = state.reloadEndsAt;
  state.reloadEndsAt = 0;
  return true;
}

export function startWeaponReload(
  state: SharedWeaponState,
  nowMs: number,
  clipSize: number,
  reloadDurationMs: number,
): boolean {
  if (state.reloadEndsAt > nowMs || state.ammoInClip >= clipSize || state.reserveAmmo <= 0) {
    return false;
  }

  state.reloadSequence += 1;
  state.reloadEndsAt = nowMs + reloadDurationMs;
  return true;
}

export function noteInputSequence(state: SharedWeaponState, sequence: number): void {
  state.lastInputSequence = Math.max(state.lastInputSequence, sequence);
}

export function snapshotWeaponState(state: SharedWeaponState): WeaponStateSnapshot {
  return {
    ammoInClip: state.ammoInClip,
    reserveAmmo: state.reserveAmmo,
    reloadSequence: state.reloadSequence,
    reloadEndsAt: state.reloadEndsAt,
    spreadIndex: state.spreadIndex,
  };
}

export function validateShotClaim(context: ShotValidationContext): ShotResolution {
  const { claim, shooter, weaponState, nowMs, config } = context;

  if (claim.shooterId !== shooter.id) {
    return buildRejectedResolution(claim, weaponState, "shooter-mismatch");
  }

  if (claim.weaponId !== SHARED_WEAPON_ID) {
    return buildRejectedResolution(claim, weaponState, "weapon-mismatch");
  }

  if (shooter.status !== "alive") {
    return buildRejectedResolution(claim, weaponState, "shooter-unavailable");
  }

  const latencyMs = nowMs - claim.tick;
  if (latencyMs > config.maxLatencyMs || latencyMs < -config.maxFutureSkewMs) {
    return buildRejectedResolution(claim, weaponState, "latency-window");
  }

  if (
    claim.inputSequence > weaponState.lastInputSequence ||
    weaponState.lastInputSequence - claim.inputSequence > config.maxInputSequenceLag
  ) {
    return buildRejectedResolution(claim, weaponState, "input-sequence");
  }

  const reloadingAtClaim =
    (weaponState.reloadEndsAt > 0 && claim.tick < weaponState.reloadEndsAt) ||
    claim.tick < weaponState.lastCompletedReloadAt;
  if (reloadingAtClaim || claim.reloadSequence !== weaponState.reloadSequence) {
    return buildRejectedResolution(claim, weaponState, "reload-state");
  }

  if (claim.tick < weaponState.nextReadyAt) {
    return buildRejectedResolution(claim, weaponState, "fire-rate");
  }

  if (
    claim.ammoInClip !== weaponState.ammoInClip ||
    claim.reserveAmmo !== weaponState.reserveAmmo
  ) {
    return buildRejectedResolution(claim, weaponState, "ammo-state");
  }

  if (claim.spreadIndex !== weaponState.spreadIndex) {
    return buildRejectedResolution(claim, weaponState, "spread-sequence");
  }

  const direction = vectorFromClaim(claim.direction);
  if (direction.lengthSq() <= 0.001) {
    return buildRejectedResolution(claim, weaponState, "direction-invalid");
  }
  direction.normalize();

  const shooterLook = shooter.look.clone();
  if (shooterLook.lengthSq() <= 0.001) {
    shooterLook.set(0, 0, -1);
  } else {
    shooterLook.normalize();
  }

  if (shooterLook.angleTo(direction) > config.maxAimAngleRad) {
    return buildRejectedResolution(claim, weaponState, "aim-delta");
  }

  const origin = vectorFromClaim(claim.origin);
  if (origin.distanceTo(shooter.position) > config.maxOriginDelta) {
    return buildRejectedResolution(claim, weaponState, "origin-drift");
  }

  consumeShot(weaponState, claim.tick, config.fireIntervalMs);

  const hit = findShotTarget(context.collisionWorld, origin, direction, context.targets, config);
  if (!hit.target) {
    return buildResolution(claim, weaponState, "rejected", "blocked-by-cover", 0);
  }

  if (hit.target.team === shooter.team || hit.target.status !== "alive") {
    return buildResolution(claim, weaponState, "rejected", "target-invalid", 0);
  }

  const damage = Math.min(config.damage, Math.max(0, hit.target.health));
  if (damage <= 0) {
    return buildResolution(claim, weaponState, "adjusted", "target-already-empty", 0, hit.target);
  }

  const targetHealth = Math.max(0, hit.target.health - damage);
  const targetStatus = targetHealth <= 0 ? "respawning" : "alive";
  const decision = damage < config.damage ? "adjusted" : "accepted";

  return buildResolution(
    claim,
    weaponState,
    decision,
    decision === "accepted" ? "hit-confirmed" : "damage-clamped",
    damage,
    hit.target,
    targetHealth,
    targetStatus,
  );
}

function buildRejectedResolution(
  claim: RoomShotClaim,
  weaponState: SharedWeaponState,
  reason: string,
): ShotResolution {
  return buildResolution(claim, weaponState, "rejected", reason, 0);
}

function buildResolution(
  claim: RoomShotClaim,
  weaponState: SharedWeaponState,
  decision: ShotResultDecision,
  reason: string,
  damage: number,
  target?: RewindFrame,
  targetHealth?: number,
  targetStatus?: CombatantStatus,
): ShotResolution {
  return {
    claimId: claim.claimId,
    shooterId: claim.shooterId,
    targetId: target?.id,
    decision,
    damage,
    reason,
    shooterWeapon: snapshotWeaponState(weaponState),
    targetHealth,
    targetStatus,
  };
}

function consumeShot(state: SharedWeaponState, claimTick: number, fireIntervalMs: number): void {
  state.ammoInClip = Math.max(0, state.ammoInClip - 1);
  state.lastShotAt = claimTick;
  state.nextReadyAt = claimTick + fireIntervalMs;
  state.spreadIndex += 1;
}

function cloneFrame(state: CombatantRewindState, capturedAt: number): RewindFrame {
  return {
    id: state.id,
    name: state.name,
    team: state.team,
    status: state.status,
    health: state.health,
    capturedAt,
    position: state.position.clone(),
    look: state.look.clone(),
  };
}

function vectorFromClaim(value: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function findShotTarget(
  collisionWorld: CollisionWorld,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  targets: RewindFrame[],
  config: ShotValidationConfig,
): {
  target?: RewindFrame;
} {
  const blockerDistance = findWorldHitDistance(collisionWorld, origin, direction, config.maxRange);

  let closestTarget: RewindFrame | undefined;
  let closestDistance = blockerDistance ?? config.maxRange;

  for (const target of targets) {
    const distance = intersectTargetDistance(origin, direction, target, config);
    if (distance === null || distance > closestDistance) {
      continue;
    }

    closestDistance = distance;
    closestTarget = target;
  }

  return {
    target: closestTarget,
  };
}

function intersectTargetDistance(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  target: RewindFrame,
  config: ShotValidationConfig,
): number | null {
  const min = new THREE.Vector3(
    target.position.x - config.targetRadius,
    0.35,
    target.position.z - config.targetRadius,
  );
  const max = new THREE.Vector3(
    target.position.x + config.targetRadius,
    config.targetHeight,
    target.position.z + config.targetRadius,
  );

  return intersectBoxDistance(origin, direction, min, max, config.maxRange);
}

function findWorldHitDistance(
  collisionWorld: CollisionWorld,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): number | undefined {
  let closest: number | undefined;

  for (const collider of collisionWorld.colliders) {
    const distance = intersectBoxDistance(
      origin,
      direction,
      new THREE.Vector3(collider.minX, collider.minY, collider.minZ),
      new THREE.Vector3(collider.maxX, collider.maxY, collider.maxZ),
      maxDistance,
    );
    if (distance === null) {
      continue;
    }

    if (typeof closest === "undefined" || distance < closest) {
      closest = distance;
    }
  }

  return closest;
}

function intersectBoxDistance(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  min: THREE.Vector3,
  max: THREE.Vector3,
  maxDistance: number,
): number | null {
  let tMin = 0;
  let tMax = maxDistance;

  const testAxis = (
    originValue: number,
    directionValue: number,
    minValue: number,
    maxValue: number,
  ): boolean => {
    if (Math.abs(directionValue) < 1e-6) {
      return originValue >= minValue && originValue <= maxValue;
    }

    const inverse = 1 / directionValue;
    let near = (minValue - originValue) * inverse;
    let far = (maxValue - originValue) * inverse;

    if (near > far) {
      [near, far] = [far, near];
    }

    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    return tMin <= tMax;
  };

  if (
    !testAxis(origin.x, direction.x, min.x, max.x) ||
    !testAxis(origin.y, direction.y, min.y, max.y) ||
    !testAxis(origin.z, direction.z, min.z, max.z)
  ) {
    return null;
  }

  if (tMax < 0 || tMin > maxDistance) {
    return null;
  }

  return Math.max(0, tMin);
}
