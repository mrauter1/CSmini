import type {
  ExtractionZoneDefinition,
  HostageClusterDefinition,
  HostageMissionDefinition,
  MapDefinition,
  TeamId,
  Vec3,
} from "../types";
import type { ActiveMissionBrief } from "./missions";

export type HostagePhase =
  | "awaiting-rescue"
  | "securing"
  | "escorting"
  | "extracting";

const HOSTAGE_PHASE_ORDER: Record<HostagePhase, number> = {
  "awaiting-rescue": 0,
  securing: 1,
  escorting: 2,
  extracting: 3,
};

const HOSTAGE_SECURE_SECONDS = 1.45;
const HOSTAGE_EXTRACT_SECONDS = 1.8;
const HOSTAGE_CLUSTER_RADIUS = 4.6;

export interface HostageRoutePointRuntime {
  focusId: string;
  label: string;
  position: Vec3;
}

export interface HostageClusterRuntime {
  id: string;
  label: string;
  description: string;
  focusId: string;
  radius: number;
  routeIds: string[];
  position: Vec3;
}

export interface ExtractionZoneRuntime {
  label: string;
  description: string;
  focusId: string;
  radius: number;
  routeIds: string[];
  position: Vec3;
}

export interface HostageUnitRuntime {
  id: string;
  slotIndex: number;
  position: Vec3;
  extracted: boolean;
  pathIndex: number;
}

export interface HostageRuntimeState {
  roundNumber: number;
  phase: HostagePhase;
  attackingTeam: TeamId;
  defendingTeam: TeamId;
  cluster: HostageClusterRuntime;
  extraction: ExtractionZoneRuntime;
  route: HostageRoutePointRuntime[];
  hostages: HostageUnitRuntime[];
  rescuerId: string | null;
  rescuerName: string | null;
  actingCombatantId: string | null;
  actingCombatantName: string | null;
  secureStartedAt: number | null;
  secureEndsAt: number | null;
  extractStartedAt: number | null;
  extractEndsAt: number | null;
  secureSeconds: number;
  extractSeconds: number;
  updatedAt: number;
}

export interface SerializedHostageUnitRuntime {
  id: string;
  slotIndex: number;
  x: number;
  y: number;
  z: number;
  extracted: boolean;
  pathIndex: number;
}

export interface SerializedHostageRuntimeState {
  roundNumber: number;
  phase: HostagePhase;
  clusterId: string;
  hostages: SerializedHostageUnitRuntime[];
  rescuerId: string | null;
  rescuerName: string | null;
  actingCombatantId: string | null;
  actingCombatantName: string | null;
  secureStartedAt: number | null;
  secureEndsAt: number | null;
  extractStartedAt: number | null;
  extractEndsAt: number | null;
  updatedAt: number;
}

function pointForFocus(map: MapDefinition, focusId: string): Vec3 {
  const focusPoint = map.scene.focusPoints.find((focus) => focus.id === focusId);
  if (!focusPoint) {
    return [0, 0, 0];
  }

  return [focusPoint.target[0], 0, focusPoint.target[2]];
}

function resolveHostageClusterRecord(
  definition: HostageMissionDefinition,
  mission: ActiveMissionBrief,
): HostageClusterDefinition | undefined {
  return definition.hostageClusters.find(
    (cluster) =>
      cluster.focusId === mission.focusId ||
      mission.objectiveLabel.startsWith(cluster.label),
  );
}

function buildEscortRoute(
  map: MapDefinition,
  cluster: HostageClusterDefinition,
  extraction: ExtractionZoneDefinition,
): HostageRoutePointRuntime[] {
  const routeLookup = new Map(map.tacticalRoutes.map((routeNote) => [routeNote.id, routeNote]));
  const visited = new Set<string>();
  const route: HostageRoutePointRuntime[] = [];

  const pushPoint = (focusId: string, label: string): void => {
    if (visited.has(focusId)) {
      return;
    }

    visited.add(focusId);
    route.push({
      focusId,
      label,
      position: pointForFocus(map, focusId),
    });
  };

  pushPoint(cluster.focusId, cluster.label);

  for (const routeId of cluster.routeIds) {
    const routeNote = routeLookup.get(routeId);
    if (!routeNote) {
      continue;
    }

    pushPoint(routeNote.focusId, routeNote.name);
  }

  for (const routeId of extraction.routeIds) {
    const routeNote = routeLookup.get(routeId);
    if (!routeNote) {
      continue;
    }

    pushPoint(routeNote.focusId, routeNote.name);
  }

  pushPoint(extraction.focusId, extraction.label);
  return route;
}

function hostageSpawnOffset(slotIndex: number): Vec3 {
  const offsets: Vec3[] = [
    [-0.7, 0, -0.2],
    [0.7, 0, -0.2],
    [-0.7, 0, 0.7],
    [0.7, 0, 0.7],
  ];

  return offsets[slotIndex % offsets.length] ?? [0, 0, 0];
}

function extractionProgressScore(state: HostageRuntimeState): number {
  return state.hostages.reduce((score, hostage) => {
    const extractedWeight = hostage.extracted ? 1000 : 0;
    return score + extractedWeight + hostage.pathIndex;
  }, 0);
}

export function createHostageRuntimeState(
  map: MapDefinition,
  mission: ActiveMissionBrief,
  roundNumber: number,
  now: number,
): HostageRuntimeState | null {
  if (mission.missionType !== "hostage" || !map.objectives.hostage) {
    return null;
  }

  const cluster = resolveHostageClusterRecord(map.objectives.hostage, mission);
  if (!cluster) {
    return null;
  }

  const extraction = map.objectives.hostage.extractionZone;
  const route = buildEscortRoute(map, cluster, extraction);
  const clusterPosition = pointForFocus(map, cluster.focusId);
  const initialPathIndex = Math.min(1, Math.max(0, route.length - 1));

  return {
    roundNumber,
    phase: "awaiting-rescue",
    attackingTeam: mission.attackingTeam,
    defendingTeam: mission.defendingTeam,
    cluster: {
      id: cluster.id,
      label: cluster.label,
      description: cluster.description,
      focusId: cluster.focusId,
      radius: HOSTAGE_CLUSTER_RADIUS,
      routeIds: [...cluster.routeIds],
      position: clusterPosition,
    },
    extraction: {
      label: extraction.label,
      description: extraction.description,
      focusId: extraction.focusId,
      radius: extraction.radius,
      routeIds: [...extraction.routeIds],
      position: pointForFocus(map, extraction.focusId),
    },
    route,
    hostages: Array.from({ length: cluster.hostages }, (_, slotIndex) => {
      const offset = hostageSpawnOffset(slotIndex);
      return {
        id: `${cluster.id}-hostage-${slotIndex + 1}`,
        slotIndex,
        position: [
          clusterPosition[0] + offset[0],
          clusterPosition[1] + offset[1],
          clusterPosition[2] + offset[2],
        ] as Vec3,
        extracted: false,
        pathIndex: initialPathIndex,
      };
    }),
    rescuerId: null,
    rescuerName: null,
    actingCombatantId: null,
    actingCombatantName: null,
    secureStartedAt: null,
    secureEndsAt: null,
    extractStartedAt: null,
    extractEndsAt: null,
    secureSeconds: HOSTAGE_SECURE_SECONDS,
    extractSeconds: HOSTAGE_EXTRACT_SECONDS,
    updatedAt: now,
  };
}

export function serializeHostageRuntimeState(
  state: HostageRuntimeState | null,
): SerializedHostageRuntimeState | null {
  if (!state) {
    return null;
  }

  return {
    roundNumber: state.roundNumber,
    phase: state.phase,
    clusterId: state.cluster.id,
    hostages: state.hostages.map((hostage) => ({
      id: hostage.id,
      slotIndex: hostage.slotIndex,
      x: hostage.position[0],
      y: hostage.position[1],
      z: hostage.position[2],
      extracted: hostage.extracted,
      pathIndex: hostage.pathIndex,
    })),
    rescuerId: state.rescuerId,
    rescuerName: state.rescuerName,
    actingCombatantId: state.actingCombatantId,
    actingCombatantName: state.actingCombatantName,
    secureStartedAt: state.secureStartedAt,
    secureEndsAt: state.secureEndsAt,
    extractStartedAt: state.extractStartedAt,
    extractEndsAt: state.extractEndsAt,
    updatedAt: state.updatedAt,
  };
}

export function hydrateHostageRuntimeState(
  map: MapDefinition,
  mission: ActiveMissionBrief,
  serialized: SerializedHostageRuntimeState | null | undefined,
): HostageRuntimeState | null {
  if (!serialized || mission.missionType !== "hostage" || !map.objectives.hostage) {
    return null;
  }

  const cluster = map.objectives.hostage.hostageClusters.find(
    (entry) => entry.id === serialized.clusterId,
  );
  if (!cluster) {
    return null;
  }

  const extraction = map.objectives.hostage.extractionZone;
  const route = buildEscortRoute(map, cluster, extraction);

  return {
    roundNumber: serialized.roundNumber,
    phase: serialized.phase,
    attackingTeam: mission.attackingTeam,
    defendingTeam: mission.defendingTeam,
    cluster: {
      id: cluster.id,
      label: cluster.label,
      description: cluster.description,
      focusId: cluster.focusId,
      radius: HOSTAGE_CLUSTER_RADIUS,
      routeIds: [...cluster.routeIds],
      position: pointForFocus(map, cluster.focusId),
    },
    extraction: {
      label: extraction.label,
      description: extraction.description,
      focusId: extraction.focusId,
      radius: extraction.radius,
      routeIds: [...extraction.routeIds],
      position: pointForFocus(map, extraction.focusId),
    },
    route,
    hostages: serialized.hostages.map((hostage) => ({
      id: hostage.id,
      slotIndex: hostage.slotIndex,
      position: [hostage.x, hostage.y, hostage.z],
      extracted: hostage.extracted,
      pathIndex: hostage.pathIndex,
    })),
    rescuerId: serialized.rescuerId,
    rescuerName: serialized.rescuerName,
    actingCombatantId: serialized.actingCombatantId,
    actingCombatantName: serialized.actingCombatantName,
    secureStartedAt: serialized.secureStartedAt,
    secureEndsAt: serialized.secureEndsAt,
    extractStartedAt: serialized.extractStartedAt,
    extractEndsAt: serialized.extractEndsAt,
    secureSeconds: HOSTAGE_SECURE_SECONDS,
    extractSeconds: HOSTAGE_EXTRACT_SECONDS,
    updatedAt: serialized.updatedAt,
  };
}

export function shouldAdoptHostageRuntimeState(
  localState: HostageRuntimeState | null,
  remoteState: HostageRuntimeState | null,
): boolean {
  if (!remoteState) {
    return false;
  }

  if (!localState) {
    return true;
  }

  if (remoteState.roundNumber !== localState.roundNumber) {
    return remoteState.roundNumber > localState.roundNumber;
  }

  if (remoteState.phase !== localState.phase) {
    return HOSTAGE_PHASE_ORDER[remoteState.phase] > HOSTAGE_PHASE_ORDER[localState.phase];
  }

  const remoteScore = extractionProgressScore(remoteState);
  const localScore = extractionProgressScore(localState);
  if (remoteScore !== localScore) {
    return remoteScore > localScore;
  }

  return remoteState.updatedAt > localState.updatedAt + 0.05;
}

export function currentHostageProgress(
  state: HostageRuntimeState | null,
  now: number,
): { progress: number; secondsRemaining: number } {
  if (!state) {
    return { progress: 0, secondsRemaining: 0 };
  }

  if (
    state.phase === "securing" &&
    state.secureStartedAt !== null &&
    state.secureEndsAt !== null
  ) {
    const total = Math.max(0.001, state.secureEndsAt - state.secureStartedAt);
    const remaining = Math.max(0, state.secureEndsAt - now);
    return {
      progress: 1 - remaining / total,
      secondsRemaining: remaining,
    };
  }

  if (
    state.phase === "extracting" &&
    state.extractStartedAt !== null &&
    state.extractEndsAt !== null
  ) {
    const total = Math.max(0.001, state.extractEndsAt - state.extractStartedAt);
    const remaining = Math.max(0, state.extractEndsAt - now);
    return {
      progress: 1 - remaining / total,
      secondsRemaining: remaining,
    };
  }

  if (state.phase === "escorting") {
    const finalIndex = Math.max(1, state.route.length - 1);
    const progress =
      state.hostages.reduce((sum, hostage) => {
        if (hostage.extracted) {
          return sum + 1;
        }

        return sum + Math.min(1, hostage.pathIndex / finalIndex);
      }, 0) / Math.max(1, state.hostages.length);

    return {
      progress,
      secondsRemaining: 0,
    };
  }

  return {
    progress:
      state.hostages.filter((hostage) => hostage.extracted).length /
      Math.max(1, state.hostages.length),
    secondsRemaining: 0,
  };
}

export function extractedHostageCount(state: HostageRuntimeState | null): number {
  if (!state) {
    return 0;
  }

  return state.hostages.filter((hostage) => hostage.extracted).length;
}

export function allHostagesExtracted(state: HostageRuntimeState | null): boolean {
  return Boolean(state && state.hostages.every((hostage) => hostage.extracted));
}
