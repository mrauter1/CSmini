import type { MapDefinition, TeamId } from "../types";
import { resolveActiveMission, type ActiveMissionBrief } from "./missions";
import { TEAM_ORDER, getTeamDefinition } from "./teams";

export type RoundPhase = "briefing" | "active" | "resolution";

export interface TeamRoundCount {
  total: number;
  alive: number;
}

export type TeamRoundCounts = Record<TeamId, TeamRoundCount>;

const ROUND_PHASE_ORDER: Record<RoundPhase, number> = {
  briefing: 0,
  active: 1,
  resolution: 2,
};

export interface RoundState {
  roundNumber: number;
  phase: RoundPhase;
  phaseStartedAt: number;
  phaseEndsAt: number;
  winnerTeamId: TeamId | null;
  resolutionLabel: string;
  activeMission: ActiveMissionBrief;
}

export interface SerializedRoundState {
  roundNumber: number;
  phase: RoundPhase;
  phaseStartedAt: number;
  phaseEndsAt: number;
  winnerTeamId: TeamId | null;
  resolutionLabel: string;
}

export const ROUND_DURATIONS = {
  briefing: 4.5,
  active: 72,
  resolution: 5.5,
} as const;

function createBriefingRound(
  map: MapDefinition,
  roundNumber: number,
  now: number,
): RoundState {
  return {
    roundNumber,
    phase: "briefing",
    phaseStartedAt: now,
    phaseEndsAt: now + ROUND_DURATIONS.briefing,
    winnerTeamId: null,
    resolutionLabel: "",
    activeMission: resolveActiveMission(map, roundNumber),
  };
}

export function createBriefingRoundState(
  map: MapDefinition,
  roundNumber: number,
  now: number,
): RoundState {
  return createBriefingRound(map, roundNumber, now);
}

function resolveRound(
  current: RoundState,
  winnerTeamId: TeamId | null,
  resolutionLabel: string,
  now: number,
): RoundState {
  return {
    ...current,
    phase: "resolution",
    phaseStartedAt: now,
    phaseEndsAt: now + ROUND_DURATIONS.resolution,
    winnerTeamId,
    resolutionLabel,
  };
}

export function resolveRoundState(
  current: RoundState,
  winnerTeamId: TeamId | null,
  resolutionLabel: string,
  now: number,
): RoundState {
  return resolveRound(current, winnerTeamId, resolutionLabel, now);
}

function contestedRound(counts: TeamRoundCounts): boolean {
  return TEAM_ORDER.every((teamId) => counts[teamId].total > 0);
}

function eliminationWinner(counts: TeamRoundCounts): {
  winnerTeamId: TeamId | null;
  resolutionLabel: string;
} | null {
  if (!contestedRound(counts)) {
    return null;
  }

  if (counts.amber.alive === 0 && counts.cobalt.alive === 0) {
    return {
      winnerTeamId: null,
      resolutionLabel: "Both teams were wiped before the round could settle.",
    };
  }

  if (counts.amber.alive === 0) {
    return {
      winnerTeamId: "cobalt",
      resolutionLabel: `${getTeamDefinition("cobalt").name} cleared the roster.`,
    };
  }

  if (counts.cobalt.alive === 0) {
    return {
      winnerTeamId: "amber",
      resolutionLabel: `${getTeamDefinition("amber").name} cleared the roster.`,
    };
  }

  return null;
}

export function createInitialRoundState(map: MapDefinition, now: number): RoundState {
  return createBriefingRound(map, 1, now);
}

export function serializeRoundState(roundState: RoundState): SerializedRoundState {
  return {
    roundNumber: roundState.roundNumber,
    phase: roundState.phase,
    phaseStartedAt: roundState.phaseStartedAt,
    phaseEndsAt: roundState.phaseEndsAt,
    winnerTeamId: roundState.winnerTeamId,
    resolutionLabel: roundState.resolutionLabel,
  };
}

export function hydrateRoundState(
  map: MapDefinition,
  serialized: SerializedRoundState | null | undefined,
): RoundState | null {
  if (!serialized) {
    return null;
  }

  if (
    typeof serialized.roundNumber !== "number" ||
    (serialized.phase !== "briefing" &&
      serialized.phase !== "active" &&
      serialized.phase !== "resolution") ||
    typeof serialized.phaseStartedAt !== "number" ||
    typeof serialized.phaseEndsAt !== "number"
  ) {
    return null;
  }

  return {
    roundNumber: serialized.roundNumber,
    phase: serialized.phase,
    phaseStartedAt: serialized.phaseStartedAt,
    phaseEndsAt: serialized.phaseEndsAt,
    winnerTeamId: serialized.winnerTeamId,
    resolutionLabel: serialized.resolutionLabel,
    activeMission: resolveActiveMission(map, serialized.roundNumber),
  };
}

export function shouldAdoptRoundState(
  localState: RoundState,
  remoteState: RoundState,
): boolean {
  if (remoteState.roundNumber !== localState.roundNumber) {
    return remoteState.roundNumber > localState.roundNumber;
  }

  if (remoteState.phase !== localState.phase) {
    return ROUND_PHASE_ORDER[remoteState.phase] > ROUND_PHASE_ORDER[localState.phase];
  }

  return Math.abs(remoteState.phaseEndsAt - localState.phaseEndsAt) > 0.2;
}

export function forceRoundActive(roundState: RoundState, now: number): RoundState {
  return {
    ...roundState,
    phase: "active",
    phaseStartedAt: now,
    phaseEndsAt: now + ROUND_DURATIONS.active,
    winnerTeamId: null,
    resolutionLabel: "",
  };
}

export function tickRoundState(
  map: MapDefinition,
  roundState: RoundState,
  now: number,
  counts: TeamRoundCounts,
): RoundState {
  if (roundState.phase === "briefing" && now >= roundState.phaseEndsAt) {
    return {
      ...roundState,
      phase: "active",
      phaseStartedAt: now,
      phaseEndsAt: now + ROUND_DURATIONS.active,
      winnerTeamId: null,
      resolutionLabel: "",
    };
  }

  if (roundState.phase === "active") {
    const winner = eliminationWinner(counts);
    if (winner) {
      return resolveRound(roundState, winner.winnerTeamId, winner.resolutionLabel, now);
    }

    if (now >= roundState.phaseEndsAt) {
      const timeoutWinner = roundState.activeMission.timeoutWinner;
      return resolveRound(
        roundState,
        timeoutWinner,
        `${getTeamDefinition(timeoutWinner).name} held ${roundState.activeMission.objectiveLabel}.`,
        now,
      );
    }
  }

  if (roundState.phase === "resolution" && now >= roundState.phaseEndsAt) {
    return createBriefingRound(map, roundState.roundNumber + 1, now);
  }

  return roundState;
}

export function roundTimeRemaining(roundState: RoundState, now: number): number {
  return Math.max(0, roundState.phaseEndsAt - now);
}

export function roundPhaseLabel(phase: RoundPhase): string {
  if (phase === "briefing") {
    return "Briefing";
  }

  if (phase === "active") {
    return "Round Live";
  }

  return "Round Reset";
}

export function emptyTeamCounts(): TeamRoundCounts {
  return {
    amber: { total: 0, alive: 0 },
    cobalt: { total: 0, alive: 0 },
  };
}
