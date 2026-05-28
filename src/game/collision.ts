import * as THREE from "three";

import type { MapDefinition, Primitive } from "../types";

const WALKABLE_HEIGHT_THRESHOLD = 1.2;
const GROUND_CLEARANCE = 0.15;

export interface ArenaCollider {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface CollisionWorld {
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  colliders: ArenaCollider[];
}

function toCollider(primitive: Primitive): ArenaCollider | null {
  if (primitive.shape === "box") {
    const [width, height, depth] = primitive.size;

    if (height <= WALKABLE_HEIGHT_THRESHOLD && primitive.position[1] <= height + GROUND_CLEARANCE) {
      return null;
    }

    return {
      minX: primitive.position[0] - width / 2,
      maxX: primitive.position[0] + width / 2,
      minY: primitive.position[1] - height / 2,
      maxY: primitive.position[1] + height / 2,
      minZ: primitive.position[2] - depth / 2,
      maxZ: primitive.position[2] + depth / 2,
    };
  }

  if (
    primitive.height <= WALKABLE_HEIGHT_THRESHOLD &&
    primitive.position[1] <= primitive.height + GROUND_CLEARANCE
  ) {
    return null;
  }

  const radius = Math.max(primitive.radiusTop, primitive.radiusBottom);

  return {
    minX: primitive.position[0] - radius,
    maxX: primitive.position[0] + radius,
    minY: primitive.position[1] - primitive.height / 2,
    maxY: primitive.position[1] + primitive.height / 2,
    minZ: primitive.position[2] - radius,
    maxZ: primitive.position[2] + radius,
  };
}

function overlapsCollider(
  collider: ArenaCollider,
  x: number,
  z: number,
  radius: number,
  bodyHeight: number,
): boolean {
  const bodyMinY = 0;
  const bodyMaxY = bodyHeight;

  if (bodyMaxY < collider.minY || bodyMinY > collider.maxY) {
    return false;
  }

  const nearestX = Math.max(collider.minX, Math.min(x, collider.maxX));
  const nearestZ = Math.max(collider.minZ, Math.min(z, collider.maxZ));
  const dx = x - nearestX;
  const dz = z - nearestZ;

  return dx * dx + dz * dz < radius * radius;
}

export function buildCollisionWorld(map: MapDefinition): CollisionWorld {
  const colliders = map.scene.primitives
    .map(toCollider)
    .filter((collider): collider is ArenaCollider => collider !== null);

  return {
    bounds: {
      minX: -map.scene.groundSize[0] / 2 + 1.2,
      maxX: map.scene.groundSize[0] / 2 - 1.2,
      minZ: -map.scene.groundSize[1] / 2 + 1.2,
      maxZ: map.scene.groundSize[1] / 2 - 1.2,
    },
    colliders,
  };
}

export function isBlocked(
  world: CollisionWorld,
  x: number,
  z: number,
  radius: number,
  bodyHeight: number,
): boolean {
  if (
    x - radius < world.bounds.minX ||
    x + radius > world.bounds.maxX ||
    z - radius < world.bounds.minZ ||
    z + radius > world.bounds.maxZ
  ) {
    return true;
  }

  return world.colliders.some((collider) =>
    overlapsCollider(collider, x, z, radius, bodyHeight),
  );
}

export function resolveHorizontalMovement(
  world: CollisionWorld,
  current: THREE.Vector3,
  delta: THREE.Vector3,
  radius: number,
  bodyHeight: number,
): THREE.Vector3 {
  const next = current.clone();
  const targetX = THREE.MathUtils.clamp(
    current.x + delta.x,
    world.bounds.minX + radius,
    world.bounds.maxX - radius,
  );

  if (!isBlocked(world, targetX, next.z, radius, bodyHeight)) {
    next.x = targetX;
  }

  const targetZ = THREE.MathUtils.clamp(
    current.z + delta.z,
    world.bounds.minZ + radius,
    world.bounds.maxZ - radius,
  );

  if (!isBlocked(world, next.x, targetZ, radius, bodyHeight)) {
    next.z = targetZ;
  }

  return next;
}

export function findOpenGroundPosition(
  world: CollisionWorld,
  preferred: THREE.Vector3,
  radius: number,
  bodyHeight: number,
): THREE.Vector3 {
  const base = preferred.clone();
  base.y = 0;

  const resolved = new THREE.Vector3(base.x, 0, base.z);
  const samplesPerRing = 10;

  for (let ring = 0; ring < 7; ring += 1) {
    const searchRadius = ring * 1.45;
    const attempts = ring === 0 ? 1 : samplesPerRing;

    for (let step = 0; step < attempts; step += 1) {
      const angle = (Math.PI * 2 * step) / attempts;
      const x = base.x + Math.cos(angle) * searchRadius;
      const z = base.z + Math.sin(angle) * searchRadius;

      if (!isBlocked(world, x, z, radius, bodyHeight)) {
        resolved.x = x;
        resolved.z = z;
        return resolved;
      }
    }
  }

  resolved.x = THREE.MathUtils.clamp(base.x, world.bounds.minX + radius, world.bounds.maxX - radius);
  resolved.z = THREE.MathUtils.clamp(base.z, world.bounds.minZ + radius, world.bounds.maxZ - radius);
  return resolved;
}

function rayIntersectsCollider(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  collider: ArenaCollider,
  maxDistance: number,
): boolean {
  let tMin = 0;
  let tMax = maxDistance;

  const testAxis = (
    originValue: number,
    directionValue: number,
    minValue: number,
    maxValue: number,
  ): boolean => {
    if (Math.abs(directionValue) < 1e-6) {
      return originValue >= minValue && originValue <= maxValue;
    }

    const inv = 1 / directionValue;
    let near = (minValue - originValue) * inv;
    let far = (maxValue - originValue) * inv;

    if (near > far) {
      [near, far] = [far, near];
    }

    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    return tMin <= tMax;
  };

  return (
    testAxis(origin.x, direction.x, collider.minX, collider.maxX) &&
    testAxis(origin.y, direction.y, collider.minY, collider.maxY) &&
    testAxis(origin.z, direction.z, collider.minZ, collider.maxZ)
  );
}

export function hasLineOfSight(
  world: CollisionWorld,
  origin: THREE.Vector3,
  target: THREE.Vector3,
): boolean {
  const direction = target.clone().sub(origin);
  const distance = direction.length();

  if (distance <= 0.001) {
    return true;
  }

  direction.normalize();

  return !world.colliders.some((collider) =>
    rayIntersectsCollider(origin, direction, collider, distance - 0.2),
  );
}
