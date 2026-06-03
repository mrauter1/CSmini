import type { Vec3 } from "../types";
import { currentBombProgress, type BombRuntimeState } from "./bombState";
import {
  currentHostageProgress,
  extractedHostageCount,
  type HostageRuntimeState,
} from "./hostageState";

export interface ObjectiveDebugDistances {
  localDistanceToSite: number;
  localDistanceToCluster: number;
  localDistanceToExtraction: number;
}

export interface ObjectiveDebugLocalState {
  localCombatantId: string;
  localTeamId: string;
  playerDead: boolean;
  allHostagesAtExtraction: boolean;
}

function point(position: Vec3): { x: number; y: number; z: number } {
  return {
    x: Number(position[0].toFixed(2)),
    y: Number(position[1].toFixed(2)),
    z: Number(position[2].toFixed(2)),
  };
}

export function buildBombDebugSnapshot(input: {
  state: BombRuntimeState | null;
  now: number;
  local: ObjectiveDebugLocalState;
  distances: Pick<ObjectiveDebugDistances, "localDistanceToSite">;
}): Record<string, unknown> | null {
  const state = input.state;
  if (!state) {
    return null;
  }

  const { progress, secondsRemaining } = currentBombProgress(state, input.now);
  const siteDistance = input.distances.localDistanceToSite;

  return {
    phase: state.phase,
    siteId: state.site.id,
    siteLabel: state.site.label,
    siteRadius: state.site.radius,
    sitePosition: point(state.site.position),
    carrierId: state.carrierId,
    carrierName: state.carrierName,
    plantedById: state.plantedById,
    plantedByName: state.plantedByName,
    actingCombatantId: state.actingCombatantId,
    actingCombatantName: state.actingCombatantName,
    progress: Number(progress.toFixed(3)),
    secondsRemaining: Number(secondsRemaining.toFixed(2)),
    plantSeconds: Number(state.plantSeconds.toFixed(1)),
    defuseSeconds: Number(state.defuseSeconds.toFixed(1)),
    fuseSeconds: Number(state.fuseSeconds.toFixed(1)),
    localDistanceToSite: Number(siteDistance.toFixed(2)),
    localCanPlant:
      state.phase === "carried" &&
      state.carrierId === input.local.localCombatantId &&
      input.local.localTeamId === state.attackingTeam &&
      !input.local.playerDead &&
      siteDistance <= state.site.radius,
    localCanDefuse:
      state.phase === "planted" &&
      input.local.localTeamId === state.defendingTeam &&
      !input.local.playerDead &&
      siteDistance <= state.site.radius,
  };
}

export function buildHostageDebugSnapshot(input: {
  state: HostageRuntimeState | null;
  now: number;
  local: ObjectiveDebugLocalState;
  distances: Pick<ObjectiveDebugDistances, "localDistanceToCluster" | "localDistanceToExtraction">;
}): Record<string, unknown> | null {
  const state = input.state;
  if (!state) {
    return null;
  }

  const { progress, secondsRemaining } = currentHostageProgress(state, input.now);
  const clusterDistance = input.distances.localDistanceToCluster;
  const extractionDistance = input.distances.localDistanceToExtraction;

  return {
    phase: state.phase,
    clusterId: state.cluster.id,
    clusterLabel: state.cluster.label,
    clusterRadius: state.cluster.radius,
    clusterPosition: point(state.cluster.position),
    extractionLabel: state.extraction.label,
    extractionRadius: state.extraction.radius,
    extractionPosition: point(state.extraction.position),
    route: state.route.map((routePoint) => ({
      focusId: routePoint.focusId,
      label: routePoint.label,
      position: point(routePoint.position),
    })),
    rescuerId: state.rescuerId,
    rescuerName: state.rescuerName,
    actingCombatantId: state.actingCombatantId,
    actingCombatantName: state.actingCombatantName,
    progress: Number(progress.toFixed(3)),
    secondsRemaining: Number(secondsRemaining.toFixed(2)),
    secureSeconds: Number(state.secureSeconds.toFixed(2)),
    extractSeconds: Number(state.extractSeconds.toFixed(2)),
    extractedCount: extractedHostageCount(state),
    localDistanceToCluster: Number(clusterDistance.toFixed(2)),
    localDistanceToExtraction: Number(extractionDistance.toFixed(2)),
    localCanSecure:
      state.phase === "awaiting-rescue" &&
      input.local.localTeamId === state.attackingTeam &&
      !input.local.playerDead &&
      clusterDistance <= state.cluster.radius,
    localCanExtract:
      state.phase === "escorting" &&
      state.rescuerId === input.local.localCombatantId &&
      !input.local.playerDead &&
      input.local.allHostagesAtExtraction &&
      extractionDistance <= state.extraction.radius,
    hostages: state.hostages.map((hostage) => ({
      id: hostage.id,
      slotIndex: hostage.slotIndex,
      extracted: hostage.extracted,
      pathIndex: hostage.pathIndex,
      position: point(hostage.position),
    })),
  };
}
