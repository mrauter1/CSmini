import * as THREE from "three";

import type { Primitive } from "../types";

export function createPrimitiveMesh(primitive: Primitive): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: primitive.color,
    roughness: primitive.roughness ?? 1,
    metalness: primitive.metalness ?? 0.05,
    flatShading: true,
    transparent: primitive.opacity !== undefined && primitive.opacity < 1,
    opacity: primitive.opacity ?? 1,
  });

  const geometry =
    primitive.shape === "box"
      ? new THREE.BoxGeometry(...primitive.size)
      : new THREE.CylinderGeometry(
          primitive.radiusTop,
          primitive.radiusBottom,
          primitive.height,
          primitive.radialSegments ?? 8,
        );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...primitive.position);

  if (primitive.rotation) {
    mesh.rotation.set(...primitive.rotation);
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = primitive.name ?? "";

  return mesh;
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }

    node.geometry.dispose();

    if (Array.isArray(node.material)) {
      node.material.forEach((material) => material.dispose());
      return;
    }

    node.material.dispose();
  });
}
