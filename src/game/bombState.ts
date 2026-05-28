import type {
  BombMissionDefinition,
  BombSiteDefinition,
  MapDefinition,
  TeamId,
  Vec3,
} from "../types";
import type { ActiveMissionBrief } from "./missions";

export type BombPhase = "carried" | "planting" | "planted" | "defusing";

const BOMB_PHASE_ORDER: Record<BombPhase, number> = {
  carried: 0,
  planting: 1,
  planted: 2,
  defusing: 3,
};

export interface BombCombatantSnapshot {
  id: string;
  name: string;
  teamId: TeamId;
  alive: boolean;
  local: boolean;
}

export interface BombSiteRuntime {
  id: string;
  label: string;
  description: string;
  focusId: string;
  radius: number;
  position: Vec3;
}

export interface BombRuntimeState {
  roundNumber: number;
  phase: BombPhase;
  attackingTeam: TeamId;
  defendingTeam: TeamId;
  site: BombSiteRuntime;
  carrierId: string | null;
  carrierName: string | null;
  plantedById: string | null;
  plantedByName: string | null;
  actingCombatantId: string | null;
  actingCombatantName: string | null;
  plantStartedAt: number | null;
  plantEndsAt: number | null;
  defuseStartedAt: number | null;
  defuseEndsAt: number | null;
  detonatesAt: number | null;
  plantSeconds: number;
  defuseSeconds: number;
  fuseSeconds: number;
  updatedAt: number;
}

export interface SerializedBombRuntimeState {
  roundNumber: number;
  phase: BombPhase;
  siteId: string;
  carrierId: string | null;
  carrierName: string | null;
  plantedById: string | null;
  plantedByName: string | null;
  actingCombatantId: string | null;
  actingCombatantName: string | null;
  plantStartedAt: number | null;
  plantEndsAt: number | null;
  defuseStartedAt: number | null;
  defuseEndsAt: number | null;
  detonatesAt: number | null;
  updatedAt: number;
}

function resolveBombSiteRecord(
  definition: BombMissionDefinition,
  mission: ActiveMissionBrief,
): BombSiteDefinition | undefined {
  return definition.sites.find(
    (site) => site.focusId === mission.focusId || site.label === mission.objectiveLabel,
  );
}

function resolveBombSiteRuntime(
  map: MapDefinition,
  definition: BombMissionDefinition,
  mission: ActiveMissionBrief,
): BombSiteRuntime | null {
  const site = resolveBombSiteRecord(definition, mission);
  if (!site) {
    return null;
  }

  const focusPoint = map.scene.focusPoints.find((focus) => focus.id === site.focusId);
  const position: Vec3 = focusPoint
    ? [focusPoint.target[0], 0, focusPoint.target[2]]
    : [0, 0, 0];

  return {
    id: site.id,
    label: site.label,
    description: site.description,
    focusId: site.focusId,
    radius: site.radius,
    position,
  };
}

function sortBombCombatants(
  combatants: BombCombatantSnapshot[],
  attackingTeam: TeamId,
): BombCombatantSnapshot[] {
  return combatants
    .filter((combatant) => combatant.teamId === attackingTeam && combatant.alive)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function nextCarrier(
  combatants: BombCombatantSnapshot[],
  attackingTeam: TeamId,
): BombCombatantSnapshot | null {
  return sortBombCombatants(combatants, attackingTeam)[0] ?? null;
}

export function createBombRuntimeState(
  map: MapDefinition,
  mission: ActiveMissionBrief,
  roundNumber: number,
  combatants: BombCombatantSnapshot[],
  now: number,
): BombRuntimeState | null {
  if (mission.missionType !== "bomb" || !map.objectives.bomb) {
    return null;
  }

  const site = resolveBombSiteRuntime(map, map.objectives.bomb, mission);
  if (!site) {
    return null;
  }

  const carrier = nextCarrier(combatants, mission.attackingTeam);

  return {
    roundNumber,
    phase: "carried",
    attackingTeam: mission.attackingTeam,
    defendingTeam: mission.defendingTeam,
    site,
    carrierId: carrier?.id ?? null,
    carrierName: carrier?.name ?? null,
    plantedById: null,
    plantedByName: null,
    actingCombatantId: null,
    actingCombatantName: null,
    plantStartedAt: null,
    plantEndsAt: null,
    defuseStartedAt: null,
    defuseEndsAt: null,
    detonatesAt: null,
    plantSeconds: map.objectives.bomb.plantSeconds,
    defuseSeconds: map.objectives.bomb.defuseSeconds,
    fuseSeconds: map.objectives.bomb.fuseSeconds,
    updatedAt: now,
  };
}

export function serializeBombRuntimeState(
  state: BombRuntimeState | null,
): SerializedBombRuntimeState | null {
  if (!state) {
    return null;
  }

  return {
    roundNumber: state.roundNumber,
    phase: state.phase,
    siteId: state.site.id,
    carrierId: state.carrierId,
    carrierName: state.carrierName,
    plantedById: state.plantedById,
    plantedByName: state.plantedByName,
    actingCombatantId: state.actingCombatantId,
    actingCombatantName: state.actingCombatantName,
    plantStartedAt: state.plantStartedAt,
    plantEndsAt: state.plantEndsAt,
    defuseStartedAt: state.defuseStartedAt,
    defuseEndsAt: state.defuseEndsAt,
    detonatesAt: state.detonatesAt,
    updatedAt: state.updatedAt,
  };
}

export function hydrateBombRuntimeState(
  map: MapDefinition,
  mission: ActiveMissionBrief,
  serialized: SerializedBombRuntimeState | null | undefined,
): BombRuntimeState | null {
  if (!serialized || mission.missionType !== "bomb" || !map.objectives.bomb) {
    return null;
  }

  const siteRecord = map.objectives.bomb.sites.find((site) => site.id === serialized.siteId);
  if (!siteRecord) {
    return null;
  }

  const focusPoint = map.scene.focusPoints.find((focus) => focus.id === siteRecord.focusId);
  const position: Vec3 = focusPoint
    ? [focusPoint.target[0], 0, focusPoint.target[2]]
    : [0, 0, 0];

  return {
    roundNumber: serialized.roundNumber,
    phase: serialized.phase,
    attackingTeam: mission.attackingTeam,
    defendingTeam: mission.defendingTeam,
    site: {
      id: siteRecord.id,
      label: siteRecord.label,
      description: siteRecord.description,
      focusId: siteRecord.focusId,
      radius: siteRecord.radius,
      position,
    },
    carrierId: serialized.carrierId,
    carrierName: serialized.carrierName,
    plantedById: serialized.plantedById,
    plantedByName: serialized.plantedByName,
    actingCombatantId: serialized.actingCombatantId,
    actingCombatantName: serialized.actingCombatantName,
    plantStartedAt: serialized.plantStartedAt,
    plantEndsAt: serialized.plantEndsAt,
    defuseStartedAt: serialized.defuseStartedAt,
    defuseEndsAt: serialized.defuseEndsAt,
    detonatesAt: serialized.detonatesAt,
    plantSeconds: map.objectives.bomb.plantSeconds,
    defuseSeconds: map.objectives.bomb.defuseSeconds,
    fuseSeconds: map.objectives.bomb.fuseSeconds,
    updatedAt: serialized.updatedAt,
  };
}

export function shouldAdoptBombRuntimeState(
  localState: BombRuntimeState | null,
  remoteState: BombRuntimeState | null,
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
    return BOMB_PHASE_ORDER[remoteState.phase] > BOMB_PHASE_ORDER[localState.phase];
  }

  if (
    remoteState.phase === "carried" &&
    localState.carrierId &&
    !remoteState.carrierId
  ) {
    return false;
  }

  if (
    remoteState.phase === "carried" &&
    remoteState.carrierId &&
    !localState.carrierId
  ) {
    return true;
  }

  return remoteState.updatedAt > localState.updatedAt + 0.05;
}

export function synchronizeBombCarrier(
  state: BombRuntimeState | null,
  combatants: BombCombatantSnapshot[],
  now: number,
): BombRuntimeState | null {
  if (!state) {
    return null;
  }

  const activeCarrier = state.carrierId
    ? combatants.find(
        (combatant) =>
          combatant.id === state.carrierId &&
          combatant.teamId === state.attackingTeam &&
          combatant.alive,
      ) ?? null
    : null;

  if (state.phase === "planted" || state.phase === "defusing") {
    return state;
  }

  if (state.phase === "planting" && state.actingCombatantId) {
    const planter = combatants.find(
      (combatant) =>
        combatant.id === state.actingCombatantId &&
        combatant.teamId === state.attackingTeam &&
        combatant.alive,
    );

    if (planter) {
      return state;
    }
  }

  const carrier = activeCarrier ?? nextCarrier(combatants, state.attackingTeam);
  const phase = state.phase === "planting" ? "carried" : state.phase;

  if (
    carrier?.id === state.carrierId &&
    carrier?.name === state.carrierName &&
    phase === state.phase
  ) {
    return state;
  }

  return {
    ...state,
    phase,
    carrierId: carrier?.id ?? null,
    carrierName: carrier?.name ?? null,
    actingCombatantId: null,
    actingCombatantName: null,
    plantStartedAt: null,
    plantEndsAt: null,
    updatedAt: now,
  };
}

export function currentBombProgress(
  state: BombRuntimeState | null,
  now: number,
): { progress: number; secondsRemaining: number } {
  if (!state) {
    return { progress: 0, secondsRemaining: 0 };
  }

  if (state.phase === "planting" && state.plantStartedAt !== null && state.plantEndsAt !== null) {
    const total = Math.max(0.001, state.plantEndsAt - state.plantStartedAt);
    const remaining = Math.max(0, state.plantEndsAt - now);
    return {
      progress: 1 - remaining / total,
      secondsRemaining: remaining,
    };
  }

  if (
    state.phase === "defusing" &&
    state.defuseStartedAt !== null &&
    state.defuseEndsAt !== null
  ) {
    const total = Math.max(0.001, state.defuseEndsAt - state.defuseStartedAt);
    const remaining = Math.max(0, state.defuseEndsAt - now);
    return {
      progress: 1 - remaining / total,
      secondsRemaining: remaining,
    };
  }

  if (state.phase === "planted" && state.detonatesAt !== null) {
    const total = Math.max(0.001, state.fuseSeconds);
    const remaining = Math.max(0, state.detonatesAt - now);
    return {
      progress: 1 - remaining / total,
      secondsRemaining: remaining,
    };
  }

  return { progress: 0, secondsRemaining: 0 };
}
