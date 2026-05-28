import type { TeamId, TeamPreference } from "../types";

export interface TeamDefinition {
  id: TeamId;
  name: string;
  shortName: string;
  banner: string;
  accentColor: string;
  surfaceColor: string;
  summary: string;
}

export const TEAM_ORDER: TeamId[] = ["amber", "cobalt"];

export const TEAM_DEFINITIONS: Record<TeamId, TeamDefinition> = {
  amber: {
    id: "amber",
    name: "Amber Vanguard",
    shortName: "Vanguard",
    banner: "AMBER VANGUARD",
    accentColor: "#D6A067",
    surfaceColor: "#7B4D2C",
    summary: "Fast entry team built around pressure, short routes, and direct contact.",
  },
  cobalt: {
    id: "cobalt",
    name: "Cobalt Reach",
    shortName: "Reach",
    banner: "COBALT REACH",
    accentColor: "#6F8FAA",
    surfaceColor: "#29485E",
    summary: "Anchor team built around measured holds, backline cover, and clean resets.",
  },
};

export function isTeamId(value: string | undefined): value is TeamId {
  return value === "amber" || value === "cobalt";
}

export function getTeamDefinition(teamId: TeamId): TeamDefinition {
  return TEAM_DEFINITIONS[teamId];
}

export function opposingTeam(teamId: TeamId): TeamId {
  return teamId === "amber" ? "cobalt" : "amber";
}

export function resolveTeamPreference(
  preference: TeamPreference,
  observedTeams: TeamId[],
): TeamId {
  if (preference !== "auto") {
    return preference;
  }

  const counts = {
    amber: 0,
    cobalt: 0,
  };

  for (const teamId of observedTeams) {
    counts[teamId] += 1;
  }

  return counts.amber <= counts.cobalt ? "amber" : "cobalt";
}

export function teamPreferenceLabel(preference: TeamPreference): string {
  if (preference === "auto") {
    return "Auto Assign";
  }

  return getTeamDefinition(preference).name;
}
