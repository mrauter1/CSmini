import type { TeamId } from "../types";
import { currentBombProgress, type BombRuntimeState } from "./bombState";
import {
  currentHostageProgress,
  extractedHostageCount,
  type HostageRuntimeState,
} from "./hostageState";
import type { RoundState } from "./rounds";

export interface ObjectiveHudSnapshot {
  status: string;
  progress: number;
  progressLabel: string;
}

export interface ObjectiveHudEvidence extends ObjectiveHudSnapshot {
  missionLabel: string;
  objectiveLabel: string;
  missionType: RoundState["activeMission"]["missionType"];
  worldLabelExpected: string;
  actionPromptVisible: boolean;
}

export interface ObjectiveHudInput {
  now: number;
  roundState: RoundState;
  localCombatantId: string;
  localTeamId: TeamId;
  playerDead: boolean;
  bombState: BombRuntimeState | null;
  hostageState: HostageRuntimeState | null;
  distanceToBombSite: number;
  distanceToHostageCluster: number;
  distanceToExtractionZone: number;
  allHostagesAtExtraction: boolean;
}

const EMPTY_OBJECTIVE_HUD: ObjectiveHudSnapshot = {
  status: "",
  progress: 0,
  progressLabel: "",
};

export function buildObjectiveHudSnapshot(input: ObjectiveHudInput): ObjectiveHudSnapshot {
  if (input.roundState.activeMission.missionType === "hostage") {
    return buildHostageHudSnapshot(input);
  }

  return buildBombHudSnapshot(input);
}

export function buildObjectiveHudEvidence(
  input: ObjectiveHudInput,
  snapshot = buildObjectiveHudSnapshot(input),
): ObjectiveHudEvidence {
  return {
    ...snapshot,
    missionLabel: input.roundState.activeMission.missionLabel,
    objectiveLabel: input.roundState.activeMission.objectiveLabel,
    missionType: input.roundState.activeMission.missionType,
    worldLabelExpected: input.roundState.activeMission.objectiveLabel,
    actionPromptVisible: snapshot.progressLabel.startsWith("Hold E"),
  };
}

function buildBombHudSnapshot(input: ObjectiveHudInput): ObjectiveHudSnapshot {
  const state = input.bombState;
  if (!state || input.roundState.phase === "resolution") {
    return EMPTY_OBJECTIVE_HUD;
  }

  const { progress, secondsRemaining } = currentBombProgress(state, input.now);

  if (state.phase === "carried") {
    const localCarrier = state.carrierId === input.localCombatantId;
    const atSite = input.distanceToBombSite <= state.site.radius;
    return {
      status: state.carrierName
        ? `Charge with ${state.carrierName}.`
        : "Charge carrier pending.",
      progress: 0,
      progressLabel:
        localCarrier && atSite && input.roundState.phase === "active"
          ? `Hold E to arm ${state.site.label}`
          : "",
    };
  }

  if (state.phase === "planting") {
    return {
      status: `${state.actingCombatantName ?? "Operator"} arming ${state.site.label}.`,
      progress,
      progressLabel: `${secondsRemaining.toFixed(1)}s to arm`,
    };
  }

  if (state.phase === "planted") {
    const canDefuse =
      input.localTeamId === state.defendingTeam &&
      !input.playerDead &&
      input.roundState.phase === "active";
    return {
      status: `${state.site.label} is armed.`,
      progress,
      progressLabel:
        canDefuse && input.distanceToBombSite <= state.site.radius
          ? `Hold E to disarm · ${secondsRemaining.toFixed(1)}s to breach`
          : `${secondsRemaining.toFixed(1)}s to breach`,
    };
  }

  return {
    status: `${state.actingCombatantName ?? "Operator"} disarming ${state.site.label}.`,
    progress,
    progressLabel: `${secondsRemaining.toFixed(1)}s to disarm`,
  };
}

function buildHostageHudSnapshot(input: ObjectiveHudInput): ObjectiveHudSnapshot {
  const state = input.hostageState;
  if (!state || input.roundState.phase === "resolution") {
    return EMPTY_OBJECTIVE_HUD;
  }

  const { progress, secondsRemaining } = currentHostageProgress(state, input.now);
  const rescuedCount = extractedHostageCount(state);
  const totalCount = state.hostages.length;

  if (state.phase === "awaiting-rescue") {
    const canSecure =
      input.localTeamId === state.attackingTeam &&
      !input.playerDead &&
      input.distanceToHostageCluster <= state.cluster.radius;
    return {
      status: `${state.cluster.label} pinned near ${state.extraction.label}.`,
      progress: 0,
      progressLabel: canSecure ? `Hold E to secure ${state.cluster.label}` : "",
    };
  }

  if (state.phase === "securing") {
    return {
      status: `${state.actingCombatantName ?? "Operator"} securing ${state.cluster.label}.`,
      progress,
      progressLabel: `${secondsRemaining.toFixed(1)}s to link escort`,
    };
  }

  if (state.phase === "escorting") {
    const readyToExtract =
      state.rescuerId === input.localCombatantId &&
      input.allHostagesAtExtraction &&
      input.distanceToExtractionZone <= state.extraction.radius;
    return {
      status: `${state.rescuerName ?? "Cobalt Reach"} escorting ${state.cluster.label}.`,
      progress,
      progressLabel: readyToExtract
        ? `Extraction lane clear at ${state.extraction.label}`
        : `${rescuedCount}/${totalCount} through ${state.extraction.label}`,
    };
  }

  return {
    status: `${state.actingCombatantName ?? "Operator"} extracting ${state.cluster.label}.`,
    progress,
    progressLabel: `${secondsRemaining.toFixed(1)}s to clear ${state.extraction.label}`,
  };
}
