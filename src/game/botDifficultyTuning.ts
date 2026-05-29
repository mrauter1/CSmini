import type { BotDifficulty } from "./botDifficulty";

export interface BotDifficultyTuning {
  reactionBiasSeconds: number;
  hitChanceBias: number;
  spreadMultiplier: number;
  fireIntervalMultiplier: number;
  pursuitSeconds: number;
  investigationSeconds: number;
  communicationDelaySeconds: number;
  communicationMemorySeconds: number;
  engageVisibilityThreshold: number;
  clearShotVisibilityThreshold: number;
  repositionMinimumScore: number;
  behaviorHoldSeconds: number;
  postContactRepositionSeconds: number;
  burstMinShots: number;
  burstMaxShots: number;
  burstCooldownSeconds: number;
  stuckSeconds: number;
  recoveryCommitSeconds: number;
  objectiveThreatDistance: number;
}

export const BOT_DIFFICULTY_TUNING: Record<BotDifficulty, BotDifficultyTuning> = {
  easy: {
    reactionBiasSeconds: 0.11,
    hitChanceBias: -0.13,
    spreadMultiplier: 1.18,
    fireIntervalMultiplier: 1.16,
    pursuitSeconds: 3.4,
    investigationSeconds: 2.9,
    communicationDelaySeconds: 1.05,
    communicationMemorySeconds: 2.4,
    engageVisibilityThreshold: 0.46,
    clearShotVisibilityThreshold: 0.74,
    repositionMinimumScore: 0.82,
    behaviorHoldSeconds: 0.82,
    postContactRepositionSeconds: 0.92,
    burstMinShots: 1,
    burstMaxShots: 2,
    burstCooldownSeconds: 1.08,
    stuckSeconds: 0.94,
    recoveryCommitSeconds: 1.2,
    objectiveThreatDistance: 8.8,
  },
  medium: {
    reactionBiasSeconds: 0,
    hitChanceBias: 0,
    spreadMultiplier: 1,
    fireIntervalMultiplier: 1,
    pursuitSeconds: 4.8,
    investigationSeconds: 3.8,
    communicationDelaySeconds: 0.62,
    communicationMemorySeconds: 3.2,
    engageVisibilityThreshold: 0.34,
    clearShotVisibilityThreshold: 0.72,
    repositionMinimumScore: 0.35,
    behaviorHoldSeconds: 0.72,
    postContactRepositionSeconds: 1.18,
    burstMinShots: 2,
    burstMaxShots: 3,
    burstCooldownSeconds: 0.76,
    stuckSeconds: 0.78,
    recoveryCommitSeconds: 1.45,
    objectiveThreatDistance: 7.2,
  },
  hard: {
    reactionBiasSeconds: -0.06,
    hitChanceBias: 0.08,
    spreadMultiplier: 0.9,
    fireIntervalMultiplier: 0.92,
    pursuitSeconds: 6.1,
    investigationSeconds: 4.7,
    communicationDelaySeconds: 0.32,
    communicationMemorySeconds: 4.1,
    engageVisibilityThreshold: 0.28,
    clearShotVisibilityThreshold: 0.66,
    repositionMinimumScore: 0.18,
    behaviorHoldSeconds: 0.58,
    postContactRepositionSeconds: 1.46,
    burstMinShots: 3,
    burstMaxShots: 4,
    burstCooldownSeconds: 0.54,
    stuckSeconds: 0.62,
    recoveryCommitSeconds: 1.7,
    objectiveThreatDistance: 6.1,
  },
};

export function botDifficultyTuning(difficulty: BotDifficulty): BotDifficultyTuning {
  return BOT_DIFFICULTY_TUNING[difficulty];
}
