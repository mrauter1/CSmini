import type { TeamId } from "../types";
import type {
  EnemyBehavior,
  EnemySquadRole,
  EnemyStance,
  EnemyStrategy,
} from "./tacticalAi";
import type { RouteCompletionEvidence } from "./mapReachability";

export interface ObjectiveBotGoalInput {
  id: string;
  name: string;
  teamId: TeamId;
  alive: boolean;
  role: EnemySquadRole;
  strategy: EnemyStrategy;
  strategyReason: string;
  objectiveIntent: string;
  behavior: EnemyBehavior;
  stance: EnemyStance;
  targetLabel: string;
  objectiveLabel: string;
  route: RouteCompletionEvidence | null;
  recoveryAction: string;
  stuckClassification: string;
}

export interface ObjectiveBotGoalEvidence {
  id: string;
  name: string;
  teamId: TeamId;
  alive: boolean;
  role: EnemySquadRole;
  strategy: EnemyStrategy;
  strategyReason: string;
  objectiveIntent: string;
  behavior: EnemyBehavior;
  stance: EnemyStance;
  targetLabel: string;
  objectiveLabel: string;
  route: RouteCompletionEvidence | null;
  recoveryAction: string;
  stuckClassification: string;
  committingToObjective: boolean;
}

export function buildObjectiveBotGoalEvidence(
  input: ObjectiveBotGoalInput,
): ObjectiveBotGoalEvidence {
  return {
    ...input,
    committingToObjective:
      input.objectiveIntent.includes("commit") ||
      input.objectiveIntent.includes("defuse") ||
      input.objectiveIntent.includes("escort") ||
      input.objectiveIntent.includes("secure") ||
      input.behavior === "objective",
  };
}
