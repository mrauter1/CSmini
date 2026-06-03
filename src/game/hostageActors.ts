import * as THREE from "three";

import { disposeObject } from "../world/primitives";
import { createHostageAvatar, type HostageAvatar } from "./avatar";
import type { HostageRuntimeState } from "./hostageState";

export interface HostageActor {
  id: string;
  avatar: HostageAvatar;
  moveBlend: number;
  lastPosition: THREE.Vector3;
}

export function syncHostageActors(
  scene: THREE.Scene,
  actors: Map<string, HostageActor>,
  hostageState: HostageRuntimeState | null,
): void {
  const activeIds = new Set(hostageState?.hostages.map((hostage) => hostage.id) ?? []);

  for (const [hostageId, actor] of actors) {
    if (activeIds.has(hostageId)) {
      continue;
    }

    scene.remove(actor.avatar.group);
    disposeObject(actor.avatar.group);
    actors.delete(hostageId);
  }

  if (!hostageState) {
    return;
  }

  for (const hostage of hostageState.hostages) {
    const existing = actors.get(hostage.id);
    const point = new THREE.Vector3(hostage.position[0], hostage.position[1], hostage.position[2]);

    if (existing) {
      existing.avatar.group.position.copy(point);
      existing.lastPosition.copy(point);
      continue;
    }

    const avatar = createHostageAvatar();
    avatar.group.position.copy(point);
    scene.add(avatar.group);
    actors.set(hostage.id, {
      id: hostage.id,
      avatar,
      moveBlend: 0,
      lastPosition: point.clone(),
    });
  }
}

export function updateHostageActors(
  actors: Map<string, HostageActor>,
  hostageState: HostageRuntimeState | null,
  delta: number,
  now: number,
): void {
  if (!hostageState) {
    return;
  }

  for (const hostage of hostageState.hostages) {
    const actor = actors.get(hostage.id);
    if (!actor) {
      continue;
    }

    const nextPosition = new THREE.Vector3(
      hostage.position[0],
      hostage.position[1],
      hostage.position[2],
    );
    const movement = nextPosition.clone().sub(actor.lastPosition);
    const moveAmount = movement.length();

    actor.avatar.group.position.copy(nextPosition);
    actor.moveBlend = THREE.MathUtils.damp(
      actor.moveBlend,
      moveAmount > 0.03 ? 1 : 0,
      8,
      delta,
    );

    if (moveAmount > 0.01) {
      actor.avatar.group.lookAt(
        nextPosition.x + movement.x,
        1.2,
        nextPosition.z + movement.z,
      );
    }

    actor.avatar.update(now, actor.moveBlend, hostageState.phase !== "awaiting-rescue");
    actor.avatar.setVisible(!hostage.extracted);
    actor.lastPosition.copy(nextPosition);
  }
}

export function disposeHostageActors(
  scene: THREE.Scene,
  actors: Map<string, HostageActor>,
): void {
  for (const actor of actors.values()) {
    scene.remove(actor.avatar.group);
    disposeObject(actor.avatar.group);
  }

  actors.clear();
}
