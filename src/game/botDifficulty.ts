export const BOT_DIFFICULTIES = ["easy", "medium", "hard"] as const;

export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "medium";
export const BOT_DIFFICULTY_STORAGE_KEY = "dustline.soloBotDifficulty";

export function isBotDifficulty(value: string | null | undefined): value is BotDifficulty {
  return BOT_DIFFICULTIES.some((difficulty) => difficulty === value);
}

export function botDifficultyLabel(difficulty: BotDifficulty): string {
  return difficulty[0].toUpperCase() + difficulty.slice(1);
}

export function readStoredBotDifficulty(): BotDifficulty {
  try {
    const storedValue = localStorage.getItem(BOT_DIFFICULTY_STORAGE_KEY);
    return isBotDifficulty(storedValue) ? storedValue : DEFAULT_BOT_DIFFICULTY;
  } catch {
    return DEFAULT_BOT_DIFFICULTY;
  }
}

export function writeStoredBotDifficulty(difficulty: BotDifficulty): void {
  try {
    localStorage.setItem(BOT_DIFFICULTY_STORAGE_KEY, difficulty);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}
