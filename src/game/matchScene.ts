import * as THREE from "three";

import type { MapDefinition } from "../types";
import { createPrimitiveMesh } from "../world/primitives";

export interface BuiltMatchScene {
  environmentRaycastMeshes: THREE.Object3D[];
}

export function buildMatchScene(scene: THREE.Scene, map: MapDefinition): BuiltMatchScene {
  const environmentRaycastMeshes: THREE.Object3D[] = [];

  const ambient = new THREE.HemisphereLight(
    map.scene.environment.sun,
    map.scene.environment.fill,
    1.25,
  );
  ambient.position.set(0, 30, 0);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(map.scene.environment.sun, 1.7);
  sun.position.set(18, 28, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(map.scene.groundSize[0], map.scene.groundSize[1]),
    new THREE.MeshStandardMaterial({
      color: map.scene.environment.ground,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const root = new THREE.Group();

  for (const primitive of map.scene.primitives) {
    const mesh = createPrimitiveMesh(primitive);
    root.add(mesh);

    if (!primitive.name?.toLowerCase().includes("spawn beacon")) {
      environmentRaycastMeshes.push(mesh);
    }
  }

  scene.add(root);

  return { environmentRaycastMeshes };
}
