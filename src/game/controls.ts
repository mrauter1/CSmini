export const CROUCH_KEY_CODES = ["KeyZ"] as const;
export const CLASSIC_CROUCH_KEY_CODES = ["ControlLeft", "ControlRight"] as const;
export const SPRINT_KEY_CODES = ["ShiftLeft", "ShiftRight"] as const;

export const CROUCH_CONTROL_LABEL = "Z";
export const CLASSIC_CROUCH_CONTROL_LABEL = "Z / Ctrl";
export const CLASSIC_CROUCH_STORAGE_KEY = "dustline.classicCrouchAlias";

export function hasAnyKey(keys: ReadonlySet<string>, codes: readonly string[]): boolean {
  return codes.some((code) => keys.has(code));
}

export function crouchControlLabel(classicCrouchAlias: boolean): string {
  return classicCrouchAlias ? CLASSIC_CROUCH_CONTROL_LABEL : CROUCH_CONTROL_LABEL;
}

