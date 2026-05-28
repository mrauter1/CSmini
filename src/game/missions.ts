import type {
  BombMissionDefinition,
  HostageMissionDefinition,
  MapDefinition,
  MissionType,
  TeamId,
} from "../types";
import { getTeamDefinition } from "./teams";

export interface ActiveMissionBrief {
  missionType: MissionType;
  missionLabel: string;
  objectiveLabel: string;
  summary: string;
  briefing: string;
  attackingTeam: TeamId;
  defendingTeam: TeamId;
  timeoutWinner: TeamId;
  focusId: string;
}

const MISSION_DISPLAY_NAMES: Record<MissionType, string> = {
  bomb: "Relay Charge",
  hostage: "Evac Escort",
};

export function missionDisplayName(missionType: MissionType): string {
  return MISSION_DISPLAY_NAMES[missionType];
}

export function missionBadges(map: MapDefinition): string[] {
  return map.supportedMissions.map((missionType) => missionDisplayName(missionType));
}

function resolveBombMission(
  definition: BombMissionDefinition,
  roundNumber: number,
): ActiveMissionBrief {
  const site = definition.sites[(roundNumber - 1) % definition.sites.length];
  const attackingTeam = definition.deliveryTeam;
  const defendingTeam = definition.holdTeam;

  return {
    missionType: "bomb",
    missionLabel: definition.label || missionDisplayName("bomb"),
    objectiveLabel: site.label,
    summary: `${getTeamDefinition(attackingTeam).shortName} drive the charge to ${site.label} while ${getTeamDefinition(defendingTeam).shortName} burn the clock.`,
    briefing: definition.briefing,
    attackingTeam,
    defendingTeam,
    timeoutWinner: defendingTeam,
    focusId: site.focusId,
  };
}

function resolveHostageMission(
  definition: HostageMissionDefinition,
  roundNumber: number,
): ActiveMissionBrief {
  const cluster =
    definition.hostageClusters[(roundNumber - 1) % definition.hostageClusters.length];
  const attackingTeam = definition.rescueTeam;
  const defendingTeam = definition.holdTeam;

  return {
    missionType: "hostage",
    missionLabel: definition.label || missionDisplayName("hostage"),
    objectiveLabel: `${cluster.label} to ${definition.extractionZone.label}`,
    summary: `${getTeamDefinition(attackingTeam).shortName} secure ${cluster.label} and extract through ${definition.extractionZone.label}.`,
    briefing: definition.briefing,
    attackingTeam,
    defendingTeam,
    timeoutWinner: defendingTeam,
    focusId: cluster.focusId,
  };
}

export function resolveActiveMission(
  map: MapDefinition,
  roundNumber: number,
): ActiveMissionBrief {
  const missionType = map.supportedMissions[(roundNumber - 1) % map.supportedMissions.length];

  if (missionType === "bomb") {
    if (!map.objectives.bomb) {
      throw new Error(`Map ${map.id} is missing bomb metadata.`);
    }

    return resolveBombMission(map.objectives.bomb, roundNumber);
  }

  if (!map.objectives.hostage) {
    throw new Error(`Map ${map.id} is missing hostage metadata.`);
  }

  return resolveHostageMission(map.objectives.hostage, roundNumber);
}
