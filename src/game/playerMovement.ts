import * as THREE from "three";

import { resolveHorizontalMovement, type CollisionWorld } from "./collision";

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export const PLAYER_RADIUS = 0.62;
export const STANDING_EYE_HEIGHT = 1.62;
export const CROUCH_EYE_HEIGHT = 1.08;
export const STANDING_BODY_HEIGHT = 1.72;
export const CROUCH_BODY_HEIGHT = 1.18;
export const PLAYER_WALK_SPEED = 8.6;
export const PLAYER_CROUCH_MULTIPLIER = 0.56;
export const PLAYER_AIR_CONTROL = 0.78;
export const PLAYER_GRAVITY = 13.6;
export const PLAYER_JUMP_VELOCITY = 5.25;

export interface MovementState {
  verticalVelocity: number;
  heightOffset: number;
  grounded: boolean;
  crouchBlend: number;
  spectatorUntil: number;
}

export type PlayerMovementState = MovementState;

export interface MovementInputState {
  enabled: boolean;
  moveX: number;
  moveZ: number;
  crouching: boolean;
  jumpRequested: boolean;
}

export type MovementVerticalReference = "eye" | "feet";

export interface MovementUpdateResult {
  crouching: boolean;
  grounded: boolean;
  airborne: boolean;
  eyeHeight: number;
  bodyHeight: number;
  moveBlend: number;
  landed: boolean;
  jumped: boolean;
}

export function createMovementState(): MovementState {
  return {
    verticalVelocity: 0,
    heightOffset: 0,
    grounded: true,
    crouchBlend: 0,
    spectatorUntil: 0,
  };
}

export function createPlayerMovementState(): PlayerMovementState {
  return createMovementState();
}

export function currentEyeHeight(state: MovementState): number {
  return THREE.MathUtils.lerp(STANDING_EYE_HEIGHT, CROUCH_EYE_HEIGHT, state.crouchBlend);
}

export function currentBodyHeight(state: MovementState): number {
  return THREE.MathUtils.lerp(STANDING_BODY_HEIGHT, CROUCH_BODY_HEIGHT, state.crouchBlend);
}

export function holdDebugCamera(
  state: MovementState,
  now: number,
  seconds = 0.4,
): void {
  state.spectatorUntil = Math.max(state.spectatorUntil, now + seconds);
}

export function setDebugCameraPose(
  state: MovementState,
  camera: THREE.PerspectiveCamera,
  now: number,
  x: number,
  y: number,
  z: number,
  holdSeconds = 0.4,
): void {
  camera.position.set(x, y, z);
  state.heightOffset = Math.max(0, y - currentEyeHeight(state));
  state.verticalVelocity = 0;
  state.grounded = state.heightOffset <= 0.01;
  holdDebugCamera(state, now, holdSeconds);
}

function movementReferenceY(
  eyeHeight: number,
  verticalReference: MovementVerticalReference,
): number {
  return verticalReference === "eye" ? eyeHeight : 0;
}

export function updateSharedMovement(
  state: MovementState,
  position: THREE.Vector3,
  orientation: THREE.Quaternion,
  verticalReference: MovementVerticalReference,
  collisionWorld: CollisionWorld,
  delta: number,
  now: number,
  input: MovementInputState,
  tempForward: THREE.Vector3,
  tempRight: THREE.Vector3,
  tempDelta: THREE.Vector3,
  radius = PLAYER_RADIUS,
): MovementUpdateResult {
  state.crouchBlend = THREE.MathUtils.damp(
    state.crouchBlend,
    input.crouching ? 1 : 0,
    14,
    delta,
  );

  const eyeHeight = currentEyeHeight(state);
  const bodyHeight = currentBodyHeight(state);
  const spectatorHold = state.spectatorUntil > now;
  let landed = false;
  let jumped = false;

  if (!spectatorHold && input.jumpRequested && state.grounded && input.enabled) {
    state.verticalVelocity = PLAYER_JUMP_VELOCITY;
    state.grounded = false;
    jumped = true;
  }

  if (!spectatorHold && !state.grounded) {
    state.verticalVelocity -= PLAYER_GRAVITY * delta;
    state.heightOffset = Math.max(0, state.heightOffset + state.verticalVelocity * delta);

    if (state.heightOffset <= 0.0001) {
      state.heightOffset = 0;
      state.verticalVelocity = 0;
      state.grounded = true;
      landed = true;
    }
  }

  const referenceY = movementReferenceY(eyeHeight, verticalReference);
  if (spectatorHold) {
    state.heightOffset = Math.max(0, position.y - referenceY);
    state.grounded = state.heightOffset <= 0.01;
  } else {
    position.y = referenceY + state.heightOffset;
  }

  const moving = Math.hypot(input.moveX, input.moveZ) > 0.001;

  if (!spectatorHold && input.enabled && moving) {
    tempForward.set(0, 0, -1).applyQuaternion(orientation);
    tempForward.y = 0;
    tempForward.normalize();
    tempRight.crossVectors(tempForward, WORLD_UP).normalize();

    const movementScale = state.grounded ? 1 : PLAYER_AIR_CONTROL;
    const crouchScale = THREE.MathUtils.lerp(1, PLAYER_CROUCH_MULTIPLIER, state.crouchBlend);
    const length = Math.hypot(input.moveX, input.moveZ);
    const speed = PLAYER_WALK_SPEED * crouchScale * movementScale;

    tempDelta
      .copy(tempForward)
      .multiplyScalar((input.moveZ / length) * speed * delta)
      .addScaledVector(tempRight, (input.moveX / length) * speed * delta);

    const next = resolveHorizontalMovement(
      collisionWorld,
      position,
      tempDelta,
      radius,
      bodyHeight,
    );
    position.x = next.x;
    position.z = next.z;
  }

  return {
    crouching: state.crouchBlend > 0.5,
    grounded: state.grounded,
    airborne: !state.grounded,
    eyeHeight,
    bodyHeight,
    moveBlend: input.enabled && moving ? THREE.MathUtils.lerp(1, 0.72, state.crouchBlend) : 0,
    landed,
    jumped,
  };
}

export function updatePlayerMovement(
  state: PlayerMovementState,
  camera: THREE.PerspectiveCamera,
  collisionWorld: CollisionWorld,
  delta: number,
  now: number,
  input: MovementInputState,
  tempForward: THREE.Vector3,
  tempRight: THREE.Vector3,
  tempDelta: THREE.Vector3,
): MovementUpdateResult {
  return updateSharedMovement(
    state,
    camera.position,
    camera.quaternion,
    "eye",
    collisionWorld,
    delta,
    now,
    input,
    tempForward,
    tempRight,
    tempDelta,
    PLAYER_RADIUS,
  );
}
