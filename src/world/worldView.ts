import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FocusPoint, MapDefinition } from "../types";
import { createPrimitiveMesh, disposeObject } from "./primitives";

const CAMERA_LERP = 0.08;
const TARGET_LERP = 0.12;

export class WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly targetCameraPosition = new THREE.Vector3(22, 18, 28);
  private readonly targetLookAt = new THREE.Vector3(0, 0, 0);
  private readonly focusPoints = new Map<string, FocusPoint>();

  private scene?: THREE.Scene;
  private frameHandle = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 220);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 90;
    this.controls.minPolarAngle = Math.PI / 5;
    this.controls.maxPolarAngle = Math.PI / 2.1;

    this.host.replaceChildren(this.renderer.domElement);
    this.handleResize();
    window.addEventListener("resize", this.handleResize);
    this.animate();
  }

  loadMap(map: MapDefinition): void {
    this.disposeScene();
    this.focusPoints.clear();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(map.scene.environment.background);
    scene.fog = new THREE.Fog(map.scene.environment.fog, 34, 112);

    const ambient = new THREE.HemisphereLight(
      map.scene.environment.fill,
      "#2B241D",
      1.15,
    );
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(map.scene.environment.sun, 1.65);
    sun.position.set(22, 36, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
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
      root.add(createPrimitiveMesh(primitive));
    }
    scene.add(root);

    for (const focusPoint of map.scene.focusPoints) {
      this.focusPoints.set(focusPoint.id, focusPoint);
    }

    this.scene = scene;
    this.focus(map.scene.defaultFocusId, true);
  }

  focus(focusId: string, immediate = false): void {
    const focusPoint = this.focusPoints.get(focusId);

    if (!focusPoint) {
      return;
    }

    this.targetCameraPosition.set(...focusPoint.cameraPosition);
    this.targetLookAt.set(...focusPoint.target);

    if (immediate) {
      this.camera.position.copy(this.targetCameraPosition);
      this.controls.target.copy(this.targetLookAt);
    }
  }

  dispose(): void {
    window.removeEventListener("resize", this.handleResize);
    cancelAnimationFrame(this.frameHandle);
    this.controls.dispose();
    this.disposeScene();
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private readonly handleResize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private readonly animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);

    this.camera.position.lerp(this.targetCameraPosition, CAMERA_LERP);
    this.controls.target.lerp(this.targetLookAt, TARGET_LERP);
    this.controls.update();

    if (this.scene) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  private disposeScene(): void {
    if (!this.scene) {
      return;
    }

    disposeObject(this.scene);
    this.scene.clear();
    this.scene = undefined;
  }
}
