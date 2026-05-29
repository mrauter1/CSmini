import * as THREE from "three";

import type { MapDefinition, TeamId } from "../types";
import type { BombRuntimeState } from "./bombState";
import type { CollisionWorld } from "./collision";
import { findOpenGroundPosition, visibilityFraction } from "./collision";
import type { HostageRuntimeState } from "./hostageState";
import type { ActiveMissionBrief } from "./missions";

export type EnemyBehavior =
  | "objective"
  | "patrol"
  | "investigate"
  | "pursue"
  | "reposition"
  | "engage";

export type EnemyStance = "standing" | "crouched";

export interface TacticalAnchor {
  id: string;
  focusId: string;
  label: string;
  kind: "spawn" | "route" | "focus" | "objective";
  position: THREE.Vector3;
}

export interface TacticalProfile {
  anchors: TacticalAnchor[];
  routeAnchors: TacticalAnchor[];
  focusAnchors: TacticalAnchor[];
  spawnAnchors: Record<TeamId, TacticalAnchor>;
}

export interface EnemyShotProfile {
  distance: number;
  visibility: number;
  shooterSpeed: number;
  targetSpeed: number;
  targetCrouching: boolean;
  shooterCrouching: boolean;
  reactionSeconds: number;
  spreadDegrees: number;
  hitChance: number;
  missChance: number;
}

export interface EnemyShotRoll {
  hit: boolean;
  missChance: number;
  roll: number;
  offsetYawDegrees: number;
  offsetPitchDegrees: number;
}

export interface EnemyShotTuning {
  reactionBiasSeconds?: number;
  hitChanceBias?: number;
  spreadMultiplier?: number;
}

export interface RepositionChoice {
  anchor: TacticalAnchor;
  reason: "cover" | "angle";
  visibility: number;
}

export interface RepositionTuning {
  coverWeight?: number;
  angleWeight?: number;
  pressureWeight?: number;
  travelPenaltyWeight?: number;
  minimumScore?: number;
}

export interface RecoveryChoice {
  anchor: TacticalAnchor;
  visibility: number;
}

const TARGET_HEAD_OFFSET = 0.04;
const TARGET_CHEST_OFFSET = 0.36;
const TARGET_WAIST_OFFSET = 0.76;

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function dedupeAnchors(anchors: TacticalAnchor[]): TacticalAnchor[] {
  const seen = new Set<string>();
  const deduped: TacticalAnchor[] = [];

  for (const anchor of anchors) {
    const key = `${anchor.focusId}:${anchor.kind}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(anchor);
  }

  return deduped;
}

function sortByDistance(origin: THREE.Vector3, anchors: TacticalAnchor[]): TacticalAnchor[] {
  return [...anchors].sort(
    (left, right) =>
      left.position.distanceToSquared(origin) - right.position.distanceToSquared(origin),
  );
}

export function buildVisibilityPoints(
  position: THREE.Vector3,
  eyeHeight: number,
  crouching: boolean,
): THREE.Vector3[] {
  const top = position.y + eyeHeight;
  const stanceLowering = crouching ? 0.18 : 0;

  return [
    new THREE.Vector3(position.x, top - TARGET_HEAD_OFFSET - stanceLowering, position.z),
    new THREE.Vector3(position.x, top - TARGET_CHEST_OFFSET - stanceLowering, position.z),
    new THREE.Vector3(position.x, top - TARGET_WAIST_OFFSET - stanceLowering, position.z),
  ];
}

export function evaluateVisibility(
  world: CollisionWorld,
  origin: THREE.Vector3,
  targets: THREE.Vector3[],
): number {
  return visibilityFraction(world, origin, targets);
}

export function nextDeterministicRandom(state: number): {
  state: number;
  value: number;
} {
  const next = (state * 1664525 + 1013904223) >>> 0;
  return {
    state: next,
    value: next / 0x100000000,
  };
}

export function evaluateEnemyShotProfile(input: {
  distance: number;
  visibility: number;
  shooterSpeed: number;
  targetSpeed: number;
  targetCrouching: boolean;
  shooterCrouching: boolean;
}, tuning: EnemyShotTuning = {}): EnemyShotProfile {
  const distanceFactor = clamp01(input.distance / 22);
  const shooterMoveFactor = clamp01(input.shooterSpeed / 2.8);
  const targetMoveFactor = clamp01(input.targetSpeed / 4.6);
  const partialVisibility = 1 - clamp01(input.visibility);

  const hitChance = THREE.MathUtils.clamp(
    0.8 -
      distanceFactor * 0.26 -
      shooterMoveFactor * 0.17 -
      targetMoveFactor * 0.16 -
      partialVisibility * 0.22 -
      (input.targetCrouching ? 0.08 : 0) +
      (input.shooterCrouching ? 0.05 : 0) +
      (tuning.hitChanceBias ?? 0),
    0.14,
    0.88,
  );
  const missChance = clamp01(1 - hitChance);
  const spreadDegrees = THREE.MathUtils.clamp(
    (2.1 +
      distanceFactor * 4.8 +
      shooterMoveFactor * 2.4 +
      targetMoveFactor * 1.6 +
      partialVisibility * 2.8 -
      (input.shooterCrouching ? 0.6 : 0)) * (tuning.spreadMultiplier ?? 1),
    1.7,
    12.5,
  );
  const reactionSeconds = THREE.MathUtils.clamp(
    0.22 +
      distanceFactor * 0.18 +
      partialVisibility * 0.25 +
      (tuning.reactionBiasSeconds ?? 0),
    0.14,
    0.9,
  );

  return {
    distance: Number(input.distance.toFixed(2)),
    visibility: Number(clamp01(input.visibility).toFixed(3)),
    shooterSpeed: Number(input.shooterSpeed.toFixed(2)),
    targetSpeed: Number(input.targetSpeed.toFixed(2)),
    targetCrouching: input.targetCrouching,
    shooterCrouching: input.shooterCrouching,
    reactionSeconds: Number(reactionSeconds.toFixed(3)),
    spreadDegrees: Number(spreadDegrees.toFixed(3)),
    hitChance: Number(hitChance.toFixed(3)),
    missChance: Number(missChance.toFixed(3)),
  };
}

export function rollEnemyShot(
  state: number,
  profile: EnemyShotProfile,
): {
  state: number;
  result: EnemyShotRoll;
} {
  const first = nextDeterministicRandom(state);
  const second = nextDeterministicRandom(first.state);
  const third = nextDeterministicRandom(second.state);
  const halfSpread = profile.spreadDegrees * 0.5;

  return {
    state: third.state,
    result: {
      hit: first.value <= profile.hitChance,
      missChance: profile.missChance,
      roll: Number(first.value.toFixed(4)),
      offsetYawDegrees: Number(((second.value - 0.5) * 2 * halfSpread).toFixed(3)),
      offsetPitchDegrees: Number(((third.value - 0.5) * 2 * halfSpread).toFixed(3)),
    },
  };
}

function anchorForFocusId(
  profile: TacticalProfile,
  focusId: string,
  preferredKinds: TacticalAnchor["kind"][] = ["objective", "route", "focus", "spawn"],
): TacticalAnchor | undefined {
  for (const kind of preferredKinds) {
    const anchor = profile.anchors.find((entry) => entry.focusId === focusId && entry.kind === kind);
    if (anchor) {
      return anchor;
    }
  }

  return profile.anchors.find((entry) => entry.focusId === focusId);
}

export function resolveObjectiveAnchor(
  profile: TacticalProfile,
  map: MapDefinition,
  mission: ActiveMissionBrief,
  bombState: BombRuntimeState | null,
  hostageState: HostageRuntimeState | null,
  enemyTeamId: TeamId,
): TacticalAnchor {
  let focusId = mission.focusId;
  let label = mission.objectiveLabel;

  if (mission.missionType === "bomb" && bombState) {
    focusId = bombState.site.focusId;
    label = bombState.site.label;
  }

  if (mission.missionType === "hostage" && hostageState) {
    if (
      enemyTeamId === hostageState.attackingTeam &&
      (hostageState.phase === "escorting" || hostageState.phase === "extracting")
    ) {
      focusId = hostageState.extraction.focusId;
      label = hostageState.extraction.label;
    } else {
      focusId = hostageState.cluster.focusId;
      label = hostageState.cluster.label;
    }
  }

  const existing = anchorForFocusId(profile, focusId);
  if (existing) {
    return {
      ...existing,
      label,
      kind: "objective",
    };
  }

  const focusPoint = map.scene.focusPoints.find((focus) => focus.id === focusId);
  return {
    id: `objective:${focusId}`,
    focusId,
    label,
    kind: "objective",
    position: focusPoint
      ? new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2])
      : new THREE.Vector3(),
  };
}

export function buildPatrolRoute(
  profile: TacticalProfile,
  objectiveAnchor: TacticalAnchor,
  spawnPoint: THREE.Vector3,
  index: number,
): TacticalAnchor[] {
  const nearbyRoutes = sortByDistance(objectiveAnchor.position, profile.routeAnchors).filter(
    (anchor) => anchor.focusId !== objectiveAnchor.focusId,
  );
  const nearbyFocuses = sortByDistance(objectiveAnchor.position, profile.focusAnchors).filter(
    (anchor) => anchor.focusId !== objectiveAnchor.focusId,
  );
  const nearestSpawnAnchor =
    sortByDistance(spawnPoint, Object.values(profile.spawnAnchors))[0] ??
    profile.spawnAnchors.amber;

  const anchors = [
    nearestSpawnAnchor,
    nearbyRoutes[index % Math.max(nearbyRoutes.length, 1)] ?? objectiveAnchor,
    objectiveAnchor,
    nearbyFocuses[(index + 1) % Math.max(nearbyFocuses.length, 1)] ?? objectiveAnchor,
  ];

  return dedupeAnchors(anchors);
}

export function chooseRepositionAnchor(input: {
  profile: TacticalProfile;
  world: CollisionWorld;
  bodyHeight: number;
  enemyPosition: THREE.Vector3;
  enemyEyeHeight: number;
  playerPosition: THREE.Vector3;
  playerVisibilityPoints: THREE.Vector3[];
  objectiveAnchor: TacticalAnchor;
  tuning?: RepositionTuning;
}): RepositionChoice | null {
  let bestChoice: RepositionChoice | null = null;
  let bestScore = -Infinity;
  const coverWeight = input.tuning?.coverWeight ?? 1;
  const angleWeight = input.tuning?.angleWeight ?? 1;
  const pressureWeight = input.tuning?.pressureWeight ?? 1;
  const travelPenaltyWeight = input.tuning?.travelPenaltyWeight ?? 1;

  for (const anchor of input.profile.anchors) {
    const travelDistance = anchor.position.distanceTo(input.enemyPosition);
    const playerDistance = anchor.position.distanceTo(input.playerPosition);

    if (travelDistance < 1.8 || travelDistance > 14 || playerDistance < 2.8) {
      continue;
    }

    const eye = anchor.position.clone().setY(input.enemyEyeHeight);
    const visibility = evaluateVisibility(input.world, eye, input.playerVisibilityPoints);
    const breaksSight = visibility <= 0.05;
    const objectiveDistance = anchor.position.distanceTo(input.objectiveAnchor.position);
    const candidateDirection = anchor.position.clone().sub(input.playerPosition).normalize();
    const objectiveDirection = input.objectiveAnchor.position
      .clone()
      .sub(input.playerPosition)
      .normalize();
    const angleBonus = (1 - candidateDirection.dot(objectiveDirection)) * 0.8 * angleWeight;
    const coverBonus =
      (breaksSight ? 2.8 : Math.max(0, 0.9 - visibility) * 1.6) * coverWeight;
    const pressureBonus = (Math.max(0, 8 - objectiveDistance) / 8) * pressureWeight;
    const travelPenalty = (travelDistance / 12) * travelPenaltyWeight;
    const score = coverBonus + angleBonus + pressureBonus - travelPenalty;

    if (score <= bestScore) {
      continue;
    }

    bestScore = score;
    bestChoice = {
      anchor,
      reason: breaksSight ? "cover" : "angle",
      visibility: Number(visibility.toFixed(3)),
    };
  }

  return bestChoice && bestScore > (input.tuning?.minimumScore ?? 0.35) ? bestChoice : null;
}

export function chooseRecoveryAnchor(input: {
  profile: TacticalProfile;
  world: CollisionWorld;
  enemyPosition: THREE.Vector3;
  enemyEyeHeight: number;
  blockedTargetPosition: THREE.Vector3;
  blockedTargetVisibilityPoints: THREE.Vector3[];
  objectiveAnchor: TacticalAnchor;
  excludeAnchorIds?: string[];
}): RecoveryChoice | null {
  let bestChoice: RecoveryChoice | null = null;
  let bestScore = -Infinity;
  const excluded = new Set(input.excludeAnchorIds ?? []);

  for (const anchor of input.profile.anchors) {
    if (excluded.has(anchor.id)) {
      continue;
    }

    const travelDistance = anchor.position.distanceTo(input.enemyPosition);
    const targetDistance = anchor.position.distanceTo(input.blockedTargetPosition);
    if (travelDistance < 1.6 || travelDistance > 18 || targetDistance > 16) {
      continue;
    }

    const eye = anchor.position.clone().setY(input.enemyEyeHeight);
    const visibility = evaluateVisibility(input.world, eye, input.blockedTargetVisibilityPoints);
    const objectiveDistance = anchor.position.distanceTo(input.objectiveAnchor.position);
    const score =
      visibility * 2.6 +
      Math.max(0, 10 - targetDistance) / 10 +
      Math.max(0, 8 - objectiveDistance) / 16 -
      travelDistance / 14;

    if (score <= bestScore) {
      continue;
    }

    bestScore = score;
    bestChoice = {
      anchor,
      visibility: Number(visibility.toFixed(3)),
    };
  }

  return bestChoice && bestScore > 0.4 ? bestChoice : null;
}

export function buildTacticalProfile(
  map: MapDefinition,
  collisionWorld: CollisionWorld,
  bodyHeight: number,
): TacticalProfile {
  const focusLookup = new Map(map.scene.focusPoints.map((focus) => [focus.id, focus]));
  const createAnchor = (
    id: string,
    focusId: string,
    label: string,
    kind: TacticalAnchor["kind"],
  ): TacticalAnchor | null => {
    const focus = focusLookup.get(focusId);
    if (!focus) {
      return null;
    }

    return {
      id,
      focusId,
      label,
      kind,
      position: findOpenGroundPosition(
        collisionWorld,
        new THREE.Vector3(focus.target[0], 0, focus.target[2]),
        0.6,
        bodyHeight,
      ),
    };
  };

  const spawnAnchors = {
    amber:
      createAnchor(
        "spawn:amber",
        map.teamSpawns.amber.focusId,
        map.teamSpawns.amber.label,
        "spawn",
      ) ??
      {
        id: "spawn:amber",
        focusId: map.teamSpawns.amber.focusId,
        label: map.teamSpawns.amber.label,
        kind: "spawn" as const,
        position: new THREE.Vector3(),
      },
    cobalt:
      createAnchor(
        "spawn:cobalt",
        map.teamSpawns.cobalt.focusId,
        map.teamSpawns.cobalt.label,
        "spawn",
      ) ??
      {
        id: "spawn:cobalt",
        focusId: map.teamSpawns.cobalt.focusId,
        label: map.teamSpawns.cobalt.label,
        kind: "spawn" as const,
        position: new THREE.Vector3(),
      },
  };

  const routeAnchors = map.tacticalRoutes
    .map((routeNote) =>
      createAnchor(`route:${routeNote.id}`, routeNote.focusId, routeNote.name, "route"),
    )
    .filter((anchor): anchor is TacticalAnchor => Boolean(anchor));
  const focusAnchors = map.scene.focusPoints
    .map((focusPoint) => createAnchor(`focus:${focusPoint.id}`, focusPoint.id, focusPoint.label, "focus"))
    .filter((anchor): anchor is TacticalAnchor => Boolean(anchor));
  const anchors = dedupeAnchors([
    ...Object.values(spawnAnchors),
    ...routeAnchors,
    ...focusAnchors,
  ]);

  return {
    anchors,
    routeAnchors,
    focusAnchors,
    spawnAnchors,
  };
}
