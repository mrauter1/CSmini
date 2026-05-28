import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import type { MapDefinition } from "../types";
import { createPrimitiveMesh, disposeObject } from "../world/primitives";
import {
  buildRoomId,
  createRoomIdentity,
  detectSharedRoomSupport,
  type CombatantStatus,
  type MatchMode,
  type OutboundRoomPresence,
  type RoomHitEvent,
  type RoomIdentity,
  type RoomPresenceSnapshot,
  SharedRoomSession,
} from "./multiplayerRoom";
import {
  createCombatantAvatar,
  createWeaponRig,
  type CombatantAvatar,
  type WeaponRig,
} from "./avatar";
import { RetroAudio } from "./audio";
import {
  buildCollisionWorld,
  findOpenGroundPosition,
  hasLineOfSight,
  resolveHorizontalMovement,
  type CollisionWorld,
} from "./collision";

const PLAYER_EYE_HEIGHT = 1.62;
const PLAYER_BODY_HEIGHT = 1.72;
const PLAYER_RADIUS = 0.62;
const PLAYER_SPEED = 8.6;
const PLAYER_SPRINT_MULTIPLIER = 1.12;
const FIRE_INTERVAL = 0.18;
const RELOAD_DURATION = 1.05;
const CLIP_SIZE = 24;
const RESERVE_AMMO = 120;
const PLAYER_DAMAGE = 34;
const ENEMY_DAMAGE = 14;
const ENEMY_SPEED = 2.35;
const ENEMY_FIRE_INTERVAL = 0.82;
const PLAYER_RESPAWN_DELAY = 3.2;
const ENEMY_RESPAWN_DELAY = 4.2;
const ENEMY_ENGAGE_DISTANCE = 19;
const HIT_INDICATOR_DURATION = 0.16;
const DAMAGE_FLASH_DURATION = 0.2;
const MUZZLE_FLASH_DURATION = 0.06;
const REMOTE_LERP_SPEED = 12;

const ENEMY_NAMES = ["Copper-2", "Vale-3", "Rook-4"];
const ENEMY_ACCENTS = ["#6F8FAA", "#819B58", "#B86E4E"];

export interface MatchRosterEntry {
  id: string;
  name: string;
  health: number;
  eliminations: number;
  deaths: number;
  local: boolean;
  status: CombatantStatus;
}

export interface LocalMatchSnapshot {
  mapName: string;
  health: number;
  ammoInClip: number;
  reserveAmmo: number;
  firingStatus: string;
  modeNotice: string;
  pointerLocked: boolean;
  prompt: string;
  statusLine: string;
  deathLine: string;
  hitActive: boolean;
  damageActive: boolean;
  playerCount: number;
  roster: MatchRosterEntry[];
}

interface LocalMatchOptions {
  mode: MatchMode;
  onActionRequest?: (action: "catalog" | "menu") => void;
  onSnapshot: (snapshot: LocalMatchSnapshot) => void;
}

interface EnemyActor {
  id: string;
  name: string;
  avatar: CombatantAvatar;
  health: number;
  alive: boolean;
  eliminations: number;
  deaths: number;
  nextFireAt: number;
  respawnAt: number;
  waypointIndex: number;
  waypoints: THREE.Vector3[];
  recoil: number;
  moveBlend: number;
  hitFlashUntil: number;
  spawnPoint: THREE.Vector3;
}

interface RemoteActor {
  id: string;
  name: string;
  accentColor: string;
  avatar: CombatantAvatar;
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  targetPosition: THREE.Vector3;
  displayPosition: THREE.Vector3;
  forward: THREE.Vector3;
  moveBlend: number;
  hitFlashUntil: number;
  lastSeenAt: number;
}

interface FeedMessage {
  text: string;
  expiresAt: number;
}

export class LocalMatch {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: PointerLockControls;
  private readonly clock = new THREE.Clock();
  private readonly collisionWorld: CollisionWorld;
  private readonly audio = new RetroAudio();
  private readonly environmentRaycastMeshes: THREE.Object3D[] = [];
  private readonly enemyRaycastMeshes: THREE.Object3D[] = [];
  private readonly remoteRaycastMeshes: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly movementKeys = new Set<string>();
  private readonly enemies: EnemyActor[] = [];
  private readonly remoteActors = new Map<string, RemoteActor>();
  private readonly weaponRig: WeaponRig;
  private readonly spawnCandidates: THREE.Vector3[];
  private readonly attackDirection = new THREE.Vector3();
  private readonly tempForward = new THREE.Vector3();
  private readonly tempRight = new THREE.Vector3();
  private readonly tempDelta = new THREE.Vector3();
  private readonly tempLook = new THREE.Vector3();
  private readonly tempHitPoint = new THREE.Vector3();
  private readonly shotRay = new THREE.Ray();
  private readonly remoteHitBox = new THREE.Box3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly playerIdentity: RoomIdentity;
  private readonly roomId: string;

  private sharedRoom?: SharedRoomSession;
  private activeMode: MatchMode = "local";
  private sharedRoomFallbackReason = "";
  private animationHandle = 0;
  private playerHealth = 100;
  private ammoInClip = CLIP_SIZE;
  private reserveAmmo = RESERVE_AMMO;
  private playerEliminations = 0;
  private playerDeaths = 0;
  private primaryFireHeld = false;
  private nextShotAt = 0;
  private reloadEndsAt = 0;
  private playerRespawnsAt = 0;
  private playerDead = false;
  private recoil = 0;
  private muzzleFlashUntil = 0;
  private hitIndicatorUntil = 0;
  private damageFlashUntil = 0;
  private spawnIndex = 0;
  private feedMessage?: FeedMessage;
  private fallbackLookEnabled = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: MapDefinition,
    private readonly options: LocalMatchOptions,
  ) {
    this.playerIdentity = createRoomIdentity();
    this.roomId = buildRoomId(map.id);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(map.scene.environment.background);
    this.scene.fog = new THREE.Fog(map.scene.environment.fog, 16, 96);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 180);
    this.camera.position.y = PLAYER_EYE_HEIGHT;
    this.scene.add(this.camera);

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    this.controls.minPolarAngle = Math.PI * 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.82;
    this.controls.pointerSpeed = 0.88;
    this.controls.addEventListener("lock", this.handlePointerLock);
    this.controls.addEventListener("unlock", this.handlePointerLock);

    this.weaponRig = createWeaponRig();
    this.camera.add(this.weaponRig.group);

    this.collisionWorld = buildCollisionWorld(map);
    this.spawnCandidates = this.collectSpawnCandidates();
    this.spawnIndex = this.initialSpawnIndex();
    this.sharedRoom = this.initializeSharedRoom();

    this.host.replaceChildren(this.renderer.domElement);
    this.buildScene();
    this.spawnPlayer(true);

    if (this.activeMode === "local") {
      this.spawnEnemies();
    }

    this.handleResize();
    this.attachEvents();
    this.animate();
    this.emitSnapshot();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationHandle);
    this.detachEvents();

    if (this.controls.isLocked) {
      this.controls.unlock();
    }

    this.sharedRoom?.dispose();
    this.sharedRoom = undefined;
    this.controls.dispose();
    this.audio.dispose();
    disposeObject(this.scene);
    this.scene.clear();
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  requestPointerLock(): void {
    if (this.playerDead) {
      return;
    }

    this.audio.prime();
    this.fallbackLookEnabled = true;
    this.emitSnapshot();

    if (navigator.webdriver) {
      return;
    }

    try {
      const lockResult = this.renderer.domElement.requestPointerLock();
      if (lockResult instanceof Promise) {
        void lockResult.catch(() => undefined);
      }
    } catch {
      // Fallback mouse-look remains active when pointer lock is unavailable.
    }
  }

  debugSnapshot(): Record<string, unknown> {
    return {
      mapId: this.map.id,
      mapName: this.map.name,
      requestedMode: this.options.mode,
      activeMode: this.activeMode,
      roomId: this.activeMode === "shared" ? this.roomId : null,
      localPlayer: {
        id: this.playerIdentity.id,
        name: this.playerIdentity.name,
        health: this.playerHealth,
        dead: this.playerDead,
        position: {
          x: Number(this.camera.position.x.toFixed(2)),
          y: Number(this.camera.position.y.toFixed(2)),
          z: Number(this.camera.position.z.toFixed(2)),
        },
      },
      roster: this.rosterSnapshot(),
      remotePlayers: [...this.remoteActors.values()].map((actor) => ({
        id: actor.id,
        name: actor.name,
        status: actor.status,
        health: actor.health,
        position: {
          x: Number(actor.displayPosition.x.toFixed(2)),
          y: Number(actor.displayPosition.y.toFixed(2)),
          z: Number(actor.displayPosition.z.toFixed(2)),
        },
      })),
    };
  }

  debugSetPose(x: number, z: number, yaw: number, pitch = 0): void {
    this.debugSetCameraPose(x, PLAYER_EYE_HEIGHT, z, yaw, pitch);
  }

  debugSetCameraPose(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    this.camera.position.set(x, y, z);
    this.lookEuler.set(pitch, yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.lookEuler);
    this.publishRoomState(true);
    this.emitSnapshot();
  }

  debugSetView(
    x: number,
    y: number,
    z: number,
    targetX: number,
    targetY: number,
    targetZ: number,
  ): void {
    this.camera.position.set(x, y, z);
    this.camera.lookAt(targetX, targetY, targetZ);
    this.publishRoomState(true);
    this.emitSnapshot();
  }

  debugStageSharedDuel(slot: 0 | 1):
    | {
        self: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }
    | null {
    const pair = this.findDebugDuelPair();
    if (!pair) {
      return null;
    }

    const self = pair[slot];
    const target = pair[slot === 0 ? 1 : 0];
    this.debugSetView(self.x, PLAYER_EYE_HEIGHT, self.z, target.x, PLAYER_EYE_HEIGHT, target.z);

    return {
      self: {
        x: Number(self.x.toFixed(2)),
        y: PLAYER_EYE_HEIGHT,
        z: Number(self.z.toFixed(2)),
      },
      target: {
        x: Number(target.x.toFixed(2)),
        y: PLAYER_EYE_HEIGHT,
        z: Number(target.z.toFixed(2)),
      },
    };
  }

  debugFire(): void {
    this.fire(performance.now() / 1000);
    this.emitSnapshot();
  }

  debugForcePlayerDeath(attacker = "QA Rig"): void {
    this.applyPlayerDamage(Math.max(this.playerHealth, 100), attacker, performance.now() / 1000);
    this.emitSnapshot();
  }

  debugAimAt(combatantId: string): boolean {
    const remote = this.remoteActors.get(combatantId);
    const enemy = this.enemies.find((entry) => entry.id === combatantId);
    const targetPosition = remote
      ? remote.displayPosition.clone().setY(1.45)
      : enemy
        ? enemy.avatar.group.position.clone().setY(1.45)
        : undefined;

    if (!targetPosition) {
      return false;
    }

    this.camera.lookAt(targetPosition.x, targetPosition.y, targetPosition.z);
    this.publishRoomState(true);
    this.emitSnapshot();
    return true;
  }

  debugProbeShot(): {
    direction: { x: number; y: number; z: number };
    hits: Array<{ combatantId: string | null; objectName: string; distance: number }>;
  } {
    this.scene.updateMatrixWorld(true);
    this.attackDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.raycaster.set(this.camera.position, this.attackDirection);

    const combatantMeshes =
      this.activeMode === "shared" ? this.remoteRaycastMeshes : this.enemyRaycastMeshes;
    const hits = this.raycaster
      .intersectObjects([...combatantMeshes, ...this.environmentRaycastMeshes], false)
      .slice(0, 6)
      .map((hit) => ({
        combatantId: (hit.object.userData.combatantId as string | undefined) ?? null,
        objectName: hit.object.name,
        distance: Number(hit.distance.toFixed(3)),
      }));

    return {
      direction: {
        x: Number(this.attackDirection.x.toFixed(4)),
        y: Number(this.attackDirection.y.toFixed(4)),
        z: Number(this.attackDirection.z.toFixed(4)),
      },
      hits,
    };
  }

  debugSharedTarget(): string | null {
    this.scene.updateMatrixWorld(true);
    this.attackDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.raycaster.set(this.camera.position, this.attackDirection);

    const environmentIntersections = this.raycaster.intersectObjects(
      this.environmentRaycastMeshes,
      false,
    );
    const environmentDistance = environmentIntersections[0]?.distance ?? Number.POSITIVE_INFINITY;

    return this.findRemoteShotTarget(environmentDistance)?.id ?? null;
  }

  private initializeSharedRoom(): SharedRoomSession | undefined {
    if (this.options.mode !== "shared") {
      this.activeMode = "local";
      return undefined;
    }

    const support = detectSharedRoomSupport();
    if (!support.supported) {
      this.activeMode = "local";
      this.sharedRoomFallbackReason = support.reason;
      return undefined;
    }

    try {
      this.activeMode = "shared";
      return new SharedRoomSession(this.roomId, this.playerIdentity, {
        onPresence: (presence, event) => {
          this.upsertRemoteActor(presence);
          if (event === "joined") {
            this.pushFeed(`${presence.name} linked into ${this.map.name}.`, 1.6);
          }
        },
        onLeave: (peerId, reason) => {
          const actor = this.remoteActors.get(peerId);
          this.removeRemoteActor(peerId);
          if (actor) {
            this.pushFeed(
              reason === "stale"
                ? `${actor.name} connection timed out.`
                : `${actor.name} left the room.`,
              1.4,
            );
          }
        },
        onHit: (event) => {
          this.handleRoomHit(event);
        },
        onElimination: (event) => {
          this.handleRoomElimination(event);
        },
      });
    } catch (error) {
      this.activeMode = "local";
      this.sharedRoomFallbackReason =
        error instanceof Error
          ? `shared-room sync failed to start (${error.message}).`
          : "shared-room sync failed to start.";
      return undefined;
    }
  }

  private initialSpawnIndex(): number {
    if (this.options.mode !== "shared") {
      return 0;
    }

    let hash = 0;
    for (const character of this.playerIdentity.id) {
      hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
    }

    return hash % Math.max(this.spawnCandidates.length, 1);
  }

  private readonly handlePointerLock = (): void => {
    if (!this.controls.isLocked) {
      this.fallbackLookEnabled = false;
    }

    this.emitSnapshot();
  };

  private buildScene(): void {
    const ambient = new THREE.HemisphereLight(this.map.scene.environment.fill, "#241E16", 1.16);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(this.map.scene.environment.sun, 1.65);
    sun.position.set(22, 36, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(this.map.scene.groundSize[0], this.map.scene.groundSize[1]),
      new THREE.MeshStandardMaterial({
        color: this.map.scene.environment.ground,
        roughness: 1,
        metalness: 0,
        flatShading: true,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const root = new THREE.Group();

    for (const primitive of this.map.scene.primitives) {
      const mesh = createPrimitiveMesh(primitive);
      root.add(mesh);

      if (!primitive.name?.toLowerCase().includes("spawn beacon")) {
        this.environmentRaycastMeshes.push(mesh);
      }
    }

    this.scene.add(root);
  }

  private collectSpawnCandidates(): THREE.Vector3[] {
    const focusLookup = new Map(
      this.map.scene.focusPoints.map((focusPoint) => [focusPoint.id, focusPoint]),
    );

    const spawns = this.map.spawnNotes
      .map((note) => focusLookup.get(note.focusId))
      .filter((focusPoint): focusPoint is NonNullable<typeof focusPoint> => Boolean(focusPoint))
      .map((focusPoint) =>
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]),
          PLAYER_RADIUS,
          PLAYER_BODY_HEIGHT,
        ),
      );

    if (spawns.length > 0) {
      return spawns;
    }

    return [
      findOpenGroundPosition(
        this.collisionWorld,
        new THREE.Vector3(0, 0, this.map.scene.groundSize[1] / 4),
        PLAYER_RADIUS,
        PLAYER_BODY_HEIGHT,
      ),
    ];
  }

  private spawnPlayer(initial = false): void {
    const spawn = this.spawnCandidates[this.spawnIndex % this.spawnCandidates.length];
    this.spawnIndex += 1;

    const resolvedSpawn = findOpenGroundPosition(
      this.collisionWorld,
      spawn.clone(),
      PLAYER_RADIUS,
      PLAYER_BODY_HEIGHT,
    );

    this.camera.position.set(resolvedSpawn.x, PLAYER_EYE_HEIGHT, resolvedSpawn.z);

    const anchorFocus =
      this.map.routes[0]?.focusId ??
      this.map.scene.focusPoints[0]?.id ??
      this.map.spawnNotes[0]?.focusId;
    const focusPoint = this.map.scene.focusPoints.find((entry) => entry.id === anchorFocus);

    if (focusPoint) {
      this.camera.lookAt(focusPoint.target[0], PLAYER_EYE_HEIGHT, focusPoint.target[2]);
    }

    if (!initial) {
      this.audio.respawn();
      this.pushFeed(
        this.activeMode === "shared" ? "Reinserted. Shared room live." : "Reinserted. Solo drill live.",
        1.6,
      );
    }

    this.playerHealth = 100;
    this.playerDead = false;
    this.playerRespawnsAt = 0;
    this.reloadEndsAt = 0;
    this.ammoInClip = CLIP_SIZE;
    this.reserveAmmo = RESERVE_AMMO;
    this.recoil = 0;
    this.weaponRig.setVisible(true);
    this.publishRoomState(true);
  }

  private spawnEnemies(): void {
    const focusLookup = new Map(
      this.map.scene.focusPoints.map((focusPoint) => [focusPoint.id, focusPoint]),
    );
    const routeTargets = this.map.routes
      .map((routeNote) => focusLookup.get(routeNote.focusId))
      .filter((focusPoint): focusPoint is NonNullable<typeof focusPoint> => Boolean(focusPoint))
      .map((focusPoint) => new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]));

    const landmarkTargets = this.map.landmarks
      .map((landmark) => focusLookup.get(landmark.focusId))
      .filter((focusPoint): focusPoint is NonNullable<typeof focusPoint> => Boolean(focusPoint))
      .map((focusPoint) => new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]));

    for (let index = 0; index < 3; index += 1) {
      const baseSpawn =
        this.spawnCandidates[(index + 1) % this.spawnCandidates.length] ??
        new THREE.Vector3(0, 0, -8 + index * 6);
      const safeSpawn = findOpenGroundPosition(
        this.collisionWorld,
        baseSpawn,
        PLAYER_RADIUS,
        PLAYER_BODY_HEIGHT,
      );
      const routeA = routeTargets[index % Math.max(routeTargets.length, 1)] ?? safeSpawn.clone();
      const routeB =
        routeTargets[(index + 1) % Math.max(routeTargets.length, 1)] ??
        landmarkTargets[index % Math.max(landmarkTargets.length, 1)] ??
        this.spawnCandidates[0].clone();

      const avatar = createCombatantAvatar(ENEMY_ACCENTS[index % ENEMY_ACCENTS.length]);
      avatar.group.position.copy(safeSpawn);
      this.scene.add(avatar.group);

      for (const mesh of avatar.hitMeshes) {
        mesh.userData.combatantId = `enemy-${index}`;
        this.enemyRaycastMeshes.push(mesh);
      }

      this.enemies.push({
        id: `enemy-${index}`,
        name: ENEMY_NAMES[index % ENEMY_NAMES.length],
        avatar,
        health: 100,
        alive: true,
        eliminations: 0,
        deaths: 0,
        nextFireAt: 0,
        respawnAt: 0,
        waypointIndex: 0,
        waypoints: [
          safeSpawn.clone(),
          findOpenGroundPosition(this.collisionWorld, routeA, PLAYER_RADIUS, PLAYER_BODY_HEIGHT),
          findOpenGroundPosition(this.collisionWorld, routeB, PLAYER_RADIUS, PLAYER_BODY_HEIGHT),
        ],
        recoil: 0,
        moveBlend: 0,
        hitFlashUntil: 0,
        spawnPoint: safeSpawn.clone(),
      });
    }
  }

  private upsertRemoteActor(presence: RoomPresenceSnapshot): void {
    const existing = this.remoteActors.get(presence.id);
    if (existing) {
      existing.name = presence.name;
      existing.accentColor = presence.accentColor;
      existing.health = presence.health;
      existing.eliminations = presence.eliminations;
      existing.deaths = presence.deaths;
      existing.status = presence.status;
      existing.targetPosition.set(presence.position[0], 0, presence.position[2]);
      existing.forward.set(presence.look[0], 0, presence.look[2]).normalize();
      existing.lastSeenAt = presence.updatedAt;
      return;
    }

    const avatar = createCombatantAvatar(presence.accentColor);
    const spawnPosition = new THREE.Vector3(presence.position[0], 0, presence.position[2]);
    avatar.group.position.copy(spawnPosition);
    this.scene.add(avatar.group);

    for (const mesh of avatar.hitMeshes) {
      mesh.userData.combatantId = presence.id;
      this.remoteRaycastMeshes.push(mesh);
    }

    this.remoteActors.set(presence.id, {
      id: presence.id,
      name: presence.name,
      accentColor: presence.accentColor,
      avatar,
      health: presence.health,
      eliminations: presence.eliminations,
      deaths: presence.deaths,
      status: presence.status,
      targetPosition: spawnPosition.clone(),
      displayPosition: spawnPosition.clone(),
      forward: new THREE.Vector3(presence.look[0], 0, presence.look[2]).normalize(),
      moveBlend: 0,
      hitFlashUntil: 0,
      lastSeenAt: presence.updatedAt,
    });
  }

  private removeRemoteActor(peerId: string): void {
    const actor = this.remoteActors.get(peerId);
    if (!actor) {
      return;
    }

    this.remoteActors.delete(peerId);
    this.scene.remove(actor.avatar.group);
    disposeObject(actor.avatar.group);

    for (let index = this.remoteRaycastMeshes.length - 1; index >= 0; index -= 1) {
      if (this.remoteRaycastMeshes[index].userData.combatantId === peerId) {
        this.remoteRaycastMeshes.splice(index, 1);
      }
    }
  }

  private attachEvents(): void {
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("blur", this.handleBlur);
  }

  private detachEvents(): void {
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("blur", this.handleBlur);
    this.controls.removeEventListener("lock", this.handlePointerLock);
    this.controls.removeEventListener("unlock", this.handlePointerLock);
  }

  private readonly handleResize = (): void => {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      return;
    }

    if (event.code === "Escape") {
      this.fallbackLookEnabled = false;
      if (this.controls.isLocked) {
        this.controls.unlock();
      }
      this.emitSnapshot();
      return;
    }

    if (event.code === "KeyR") {
      this.tryReload();
      return;
    }

    if (event.code === "Space") {
      if (this.inputCaptured() && !this.playerDead) {
        this.fire(performance.now() / 1000);
      }
      return;
    }

    if (event.code === "KeyM") {
      this.options.onActionRequest?.("catalog");
      return;
    }

    if (event.code === "KeyB") {
      this.options.onActionRequest?.("menu");
      return;
    }

    this.movementKeys.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.movementKeys.delete(event.code);
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }

    if (!this.controls.isLocked) {
      const bounds = this.host.getBoundingClientRect();
      const withinHost =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;

      if (!withinHost) {
        return;
      }
    }

    this.primaryFireHeld = true;
    this.audio.prime();
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }

    this.primaryFireHeld = false;
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.fallbackLookEnabled || this.controls.isLocked || this.playerDead) {
      return;
    }

    this.lookEuler.setFromQuaternion(this.camera.quaternion);
    this.lookEuler.y -= event.movementX * 0.002 * this.controls.pointerSpeed;
    this.lookEuler.x -= event.movementY * 0.002 * this.controls.pointerSpeed;

    const minPitch = Math.PI / 2 - this.controls.maxPolarAngle;
    const maxPitch = Math.PI / 2 - this.controls.minPolarAngle;
    this.lookEuler.x = THREE.MathUtils.clamp(this.lookEuler.x, minPitch, maxPitch);
    this.camera.quaternion.setFromEuler(this.lookEuler);
  };

  private readonly handleBlur = (): void => {
    this.primaryFireHeld = false;
    this.movementKeys.clear();
    this.fallbackLookEnabled = false;
    this.emitSnapshot();
  };

  private readonly animate = (): void => {
    this.animationHandle = requestAnimationFrame(this.animate);

    const delta = Math.min(0.04, this.clock.getDelta());
    const now = performance.now() / 1000;

    this.updatePlayer(delta, now);
    if (this.activeMode === "shared") {
      this.updateRemoteActors(delta, now);
    } else {
      this.updateEnemies(delta, now);
    }
    this.updateRespawns(now);
    this.publishRoomState();

    this.weaponRig.update(
      now,
      this.currentMoveBlend(),
      this.recoil,
      this.muzzleFlashUntil > now,
    );
    this.weaponRig.setVisible(!this.playerDead);
    this.recoil = THREE.MathUtils.damp(this.recoil, 0, 14, delta);

    this.renderer.render(this.scene, this.camera);
    this.emitSnapshot();
  };

  private currentMoveBlend(): number {
    const moving =
      this.movementKeys.has("KeyW") ||
      this.movementKeys.has("KeyA") ||
      this.movementKeys.has("KeyS") ||
      this.movementKeys.has("KeyD");

    return moving && this.inputCaptured() && !this.playerDead ? 1 : 0;
  }

  private updatePlayer(delta: number, now: number): void {
    if (this.reloadEndsAt > 0 && now >= this.reloadEndsAt) {
      const needed = CLIP_SIZE - this.ammoInClip;
      const refill = Math.min(needed, this.reserveAmmo);
      this.ammoInClip += refill;
      this.reserveAmmo -= refill;
      this.reloadEndsAt = 0;
      this.pushFeed("Magazine seated.", 1.2);
    }

    if (!this.inputCaptured() || this.playerDead) {
      return;
    }

    let moveX = 0;
    let moveZ = 0;

    if (this.movementKeys.has("KeyW")) moveZ += 1;
    if (this.movementKeys.has("KeyS")) moveZ -= 1;
    if (this.movementKeys.has("KeyD")) moveX += 1;
    if (this.movementKeys.has("KeyA")) moveX -= 1;

    if (moveX !== 0 || moveZ !== 0) {
      this.tempForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.tempForward.y = 0;
      this.tempForward.normalize();
      this.tempRight.crossVectors(this.tempForward, new THREE.Vector3(0, 1, 0)).normalize();

      const sprinting = this.movementKeys.has("ShiftLeft") || this.movementKeys.has("ShiftRight");
      const speed = PLAYER_SPEED * (sprinting ? PLAYER_SPRINT_MULTIPLIER : 1);
      const length = Math.hypot(moveX, moveZ);

      this.tempDelta
        .copy(this.tempForward)
        .multiplyScalar((moveZ / length) * speed * delta)
        .addScaledVector(this.tempRight, (moveX / length) * speed * delta);

      const next = resolveHorizontalMovement(
        this.collisionWorld,
        this.camera.position,
        this.tempDelta,
        PLAYER_RADIUS,
        PLAYER_BODY_HEIGHT,
      );
      this.camera.position.x = next.x;
      this.camera.position.z = next.z;
    }

    if (this.primaryFireHeld && now >= this.nextShotAt) {
      this.fire(now);
    }
  }

  private fire(now: number): void {
    if (this.reloadEndsAt > 0) {
      return;
    }

    if (this.ammoInClip <= 0) {
      this.tryReload();
      return;
    }

    this.nextShotAt = now + FIRE_INTERVAL;
    this.ammoInClip -= 1;
    this.recoil = Math.min(1, this.recoil + 0.8);
    this.muzzleFlashUntil = now + MUZZLE_FLASH_DURATION;
    this.audio.fire();

    this.scene.updateMatrixWorld(true);
    this.attackDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.raycaster.set(this.camera.position, this.attackDirection);

    const combatantMeshes =
      this.activeMode === "shared" ? this.remoteRaycastMeshes : this.enemyRaycastMeshes;
    const environmentIntersections = this.raycaster.intersectObjects(
      this.environmentRaycastMeshes,
      false,
    );
    const environmentDistance = environmentIntersections[0]?.distance ?? Number.POSITIVE_INFINITY;

    if (this.activeMode === "shared") {
      const remoteTarget = this.findRemoteShotTarget(environmentDistance);
      if (!remoteTarget) {
        return;
      }

      if (!this.sharedRoom?.sendHit(remoteTarget.id, PLAYER_DAMAGE)) {
        return;
      }

      remoteTarget.hitFlashUntil = now + 0.12;
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();
      this.pushFeed(`${remoteTarget.name} tagged.`, 0.8);
      return;
    }

    const intersections = this.raycaster.intersectObjects(combatantMeshes, false);

    for (const hit of intersections) {
      const combatantId = hit.object.userData.combatantId;

      if (!combatantId) {
        break;
      }

      const enemy = this.enemies.find((entry) => entry.id === combatantId);

      if (!enemy || !enemy.alive) {
        continue;
      }

      enemy.health = Math.max(0, enemy.health - PLAYER_DAMAGE);
      enemy.hitFlashUntil = now + 0.12;
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();

      if (enemy.health <= 0) {
        enemy.alive = false;
        enemy.deaths += 1;
        enemy.respawnAt = now + ENEMY_RESPAWN_DELAY;
        this.playerEliminations += 1;
        this.pushFeed(`${enemy.name} dropped.`, 1.7);
      } else {
        this.pushFeed(`${enemy.name} tagged for ${PLAYER_DAMAGE}.`, 0.8);
      }

      return;
    }
  }

  private findRemoteShotTarget(maxDistance: number): RemoteActor | undefined {
    this.shotRay.set(this.camera.position, this.attackDirection);

    let closestDistance = maxDistance;
    let target: RemoteActor | undefined;

    for (const actor of this.remoteActors.values()) {
      if (actor.status !== "alive") {
        continue;
      }

      this.remoteHitBox.min.set(
        actor.displayPosition.x - 0.55,
        0.35,
        actor.displayPosition.z - 0.55,
      );
      this.remoteHitBox.max.set(
        actor.displayPosition.x + 0.55,
        2.15,
        actor.displayPosition.z + 0.55,
      );

      const hitPoint = this.shotRay.intersectBox(this.remoteHitBox, this.tempHitPoint);
      if (!hitPoint) {
        continue;
      }

      const distance = hitPoint.distanceTo(this.camera.position);
      if (distance >= closestDistance) {
        continue;
      }

      closestDistance = distance;
      target = actor;
    }

    return target;
  }

  private tryReload(): void {
    if (this.playerDead || this.reloadEndsAt > 0) {
      return;
    }

    if (this.ammoInClip >= CLIP_SIZE || this.reserveAmmo <= 0) {
      return;
    }

    this.reloadEndsAt = performance.now() / 1000 + RELOAD_DURATION;
    this.pushFeed("Reloading...", RELOAD_DURATION);
  }

  private updateRemoteActors(delta: number, now: number): void {
    for (const actor of this.remoteActors.values()) {
      actor.displayPosition.lerp(actor.targetPosition, 1 - Math.exp(-REMOTE_LERP_SPEED * delta));
      actor.avatar.group.position.x = actor.displayPosition.x;
      actor.avatar.group.position.z = actor.displayPosition.z;

      const facing = actor.forward.lengthSq() > 0.01 ? actor.forward : new THREE.Vector3(0, 0, 1);
      actor.avatar.group.lookAt(
        actor.displayPosition.x + facing.x,
        0.9,
        actor.displayPosition.z + facing.z,
      );

      const moving = actor.displayPosition.distanceTo(actor.targetPosition) > 0.06 ? 1 : 0;
      actor.moveBlend = THREE.MathUtils.damp(actor.moveBlend, moving, 9, delta);
      actor.avatar.update(
        now,
        actor.moveBlend,
        actor.status === "alive",
        0,
        actor.hitFlashUntil > now ? 1 : 0,
      );
    }
  }

  private updateEnemies(delta: number, now: number): void {
    for (const enemy of this.enemies) {
      enemy.recoil = THREE.MathUtils.damp(enemy.recoil, 0, 12, delta);

      if (!enemy.alive) {
        enemy.avatar.update(now, 0, false, 0, enemy.hitFlashUntil > now ? 1 : 0);
        continue;
      }

      const playerFeet = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
      const toPlayer = playerFeet.clone().sub(enemy.avatar.group.position);
      const playerDistance = toPlayer.length();
      const canEngage =
        !this.playerDead &&
        playerDistance <= ENEMY_ENGAGE_DISTANCE &&
        hasLineOfSight(
          this.collisionWorld,
          enemy.avatar.group.position.clone().setY(1.45),
          this.camera.position.clone(),
        );

      if (canEngage) {
        enemy.avatar.group.lookAt(playerFeet.x, 0.9, playerFeet.z);

        if (now >= enemy.nextFireAt) {
          enemy.nextFireAt = now + ENEMY_FIRE_INTERVAL + Math.random() * 0.18;
          enemy.recoil = 0.8;
          this.applyPlayerDamage(ENEMY_DAMAGE, enemy.name, now);
        }

        enemy.moveBlend = THREE.MathUtils.damp(enemy.moveBlend, 0.18, 8, delta);
        enemy.avatar.update(
          now,
          enemy.moveBlend,
          true,
          enemy.recoil,
          enemy.hitFlashUntil > now ? 1 : 0,
        );
        continue;
      }

      const target = enemy.waypoints[enemy.waypointIndex];
      const toWaypoint = target.clone().sub(enemy.avatar.group.position);
      const distance = toWaypoint.length();

      if (distance < 0.9) {
        enemy.waypointIndex = (enemy.waypointIndex + 1) % enemy.waypoints.length;
      } else {
        toWaypoint.normalize();
        const deltaMove = new THREE.Vector3(
          toWaypoint.x * ENEMY_SPEED * delta,
          0,
          toWaypoint.z * ENEMY_SPEED * delta,
        );
        const next = resolveHorizontalMovement(
          this.collisionWorld,
          enemy.avatar.group.position,
          deltaMove,
          PLAYER_RADIUS * 0.9,
          PLAYER_BODY_HEIGHT,
        );
        enemy.avatar.group.position.x = next.x;
        enemy.avatar.group.position.z = next.z;
        enemy.avatar.group.lookAt(target.x, 0.9, target.z);
      }

      enemy.moveBlend = THREE.MathUtils.damp(enemy.moveBlend, 1, 8, delta);
      enemy.avatar.update(
        now,
        enemy.moveBlend,
        true,
        enemy.recoil,
        enemy.hitFlashUntil > now ? 1 : 0,
      );
    }
  }

  private handleRoomHit(event: RoomHitEvent): void {
    const now = performance.now() / 1000;
    this.applyPlayerDamage(event.damage, event.attackerName, now, event.attackerId);
  }

  private handleRoomElimination(event: {
    attackerId: string;
    attackerName: string;
    targetId: string;
    targetName: string;
  }): void {
    if (event.attackerId === this.playerIdentity.id) {
      this.playerEliminations += 1;
      this.pushFeed(`${event.targetName} dropped.`, 1.7);
    }

    const attacker = this.remoteActors.get(event.attackerId);
    if (attacker) {
      attacker.eliminations += 1;
    }

    const target = this.remoteActors.get(event.targetId);
    if (target) {
      target.deaths += 1;
      target.health = 0;
      target.status = "respawning";
      target.hitFlashUntil = performance.now() / 1000 + 0.16;
    }
  }

  private applyPlayerDamage(
    amount: number,
    attacker: string,
    now: number,
    attackerId?: string,
  ): void {
    if (this.playerDead) {
      return;
    }

    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.damageFlashUntil = now + DAMAGE_FLASH_DURATION;
    this.audio.playerHit();
    this.publishRoomState(true);

    if (this.playerHealth <= 0) {
      this.playerDead = true;
      this.playerDeaths += 1;
      this.playerRespawnsAt = now + PLAYER_RESPAWN_DELAY;

      if (this.activeMode === "shared" && attackerId) {
        this.sharedRoom?.sendElimination(
          attackerId,
          attacker,
          this.playerIdentity.id,
          this.playerIdentity.name,
        );
      } else {
        const killer = this.enemies.find((enemy) => enemy.name === attacker);
        if (killer) {
          killer.eliminations += 1;
        }
      }

      this.audio.death();
      this.pushFeed(`${attacker} dropped you.`, PLAYER_RESPAWN_DELAY);
      this.publishRoomState(true);
      return;
    }

    this.pushFeed(`${attacker} hit you for ${amount}.`, 0.9);
  }

  private updateRespawns(now: number): void {
    if (this.playerDead && this.playerRespawnsAt > 0 && now >= this.playerRespawnsAt) {
      this.spawnPlayer();
    }

    for (const enemy of this.enemies) {
      if (!enemy.alive && enemy.respawnAt > 0 && now >= enemy.respawnAt) {
        enemy.alive = true;
        enemy.health = 100;
        enemy.respawnAt = 0;
        enemy.nextFireAt = now + 0.75;
        enemy.avatar.group.position.copy(enemy.spawnPoint);
        enemy.waypointIndex = 0;
        enemy.hitFlashUntil = 0;
      }
    }
  }

  private pushFeed(text: string, seconds: number): void {
    this.feedMessage = {
      text,
      expiresAt: performance.now() / 1000 + seconds,
    };
  }

  private rosterSnapshot(): MatchRosterEntry[] {
    const localEntry: MatchRosterEntry = {
      id: this.playerIdentity.id,
      name: this.playerIdentity.name,
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      local: true,
      status: this.playerDead ? "respawning" : "alive",
    };

    if (this.activeMode === "shared") {
      const remotes = [...this.remoteActors.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map<MatchRosterEntry>((actor) => ({
          id: actor.id,
          name: actor.name,
          health: actor.health,
          eliminations: actor.eliminations,
          deaths: actor.deaths,
          local: false,
          status: actor.status,
        }));

      return [localEntry, ...remotes];
    }

    return [
      localEntry,
      ...this.enemies.map<MatchRosterEntry>((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        health: enemy.health,
        eliminations: enemy.eliminations,
        deaths: enemy.deaths,
        local: false,
        status: enemy.alive ? "alive" : enemy.respawnAt > 0 ? "respawning" : "down",
      })),
    ];
  }

  private emitSnapshot(): void {
    const now = performance.now() / 1000;
    if (this.feedMessage && this.feedMessage.expiresAt <= now) {
      this.feedMessage = undefined;
    }

    const deathLine =
      this.playerDead && this.playerRespawnsAt > now
        ? `Respawn in ${(this.playerRespawnsAt - now).toFixed(1)}s. Press M to reopen map select.`
        : "";

    const statusLine =
      this.playerDead
        ? "Operator down."
        : this.reloadEndsAt > now
          ? `Reloading ${(this.reloadEndsAt - now).toFixed(1)}s`
          : this.feedMessage?.text ?? this.defaultStatusLine();

    const firingStatus =
      this.playerDead
        ? "Down"
        : this.reloadEndsAt > now
          ? "Reloading"
          : this.ammoInClip === 0
            ? "Dry"
            : "Ready";

    const prompt = this.inputCaptured() ? "" : this.promptText();

    this.options.onSnapshot({
      mapName: this.map.name,
      health: this.playerHealth,
      ammoInClip: this.ammoInClip,
      reserveAmmo: this.reserveAmmo,
      firingStatus,
      modeNotice: this.modeNotice(),
      pointerLocked: this.inputCaptured(),
      prompt,
      statusLine,
      deathLine,
      hitActive: this.hitIndicatorUntil > now,
      damageActive: this.damageFlashUntil > now,
      playerCount: this.rosterSnapshot().length,
      roster: this.rosterSnapshot(),
    });
  }

  private defaultStatusLine(): string {
    if (this.activeMode === "shared") {
      return this.remoteActors.size > 0
        ? `${this.remoteActors.size + 1} operators live in the shared room.`
        : "Shared room armed. Awaiting another operator on this map.";
    }

    return "Solo skirmish active.";
  }

  private modeNotice(): string {
    if (this.activeMode === "shared") {
      return this.remoteActors.size > 0
        ? `Shared room live on ${this.map.name}: ${this.remoteActors.size + 1} operators synced in this map session.`
        : `Shared room live on ${this.map.name}. Open the same map in a second tab or window to link another operator.`;
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return `Shared room requested, but ${this.sharedRoomFallbackReason} Solo drill armed instead.`;
    }

    return "Local fallback mode: solo skirmish with procedural audio and lightweight hostile operators.";
  }

  private promptText(): string {
    if (this.activeMode === "shared") {
      return "Click the viewport to engage controls. This map is broadcasting on a shared browser room; open the same map in a second tab or window to establish contact. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.";
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return "Click the viewport to engage controls. Shared-room sync could not start here, so the app stayed in the solo drill without crashing. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.";
    }

    return "Click the viewport to engage controls. Pointer lock is used when available; fallback mouse-look stays browser-safe. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.";
  }

  private publishRoomState(force = false): void {
    if (this.activeMode !== "shared" || !this.sharedRoom) {
      return;
    }

    this.sharedRoom.publish(this.roomPresence(), force);
    this.sharedRoom.pruneStalePeers();
  }

  private roomPresence(): OutboundRoomPresence {
    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    return {
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      status: this.playerDead ? "respawning" : "alive",
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z] as [
        number,
        number,
        number,
      ],
      look: [this.tempLook.x, this.tempLook.y, this.tempLook.z] as [number, number, number],
    };
  }

  private inputCaptured(): boolean {
    return this.controls.isLocked || this.fallbackLookEnabled;
  }

  private findDebugDuelPair(): [THREE.Vector3, THREE.Vector3] | null {
    const candidates = [
      ...this.spawnCandidates.map((candidate) => candidate.clone()),
      ...this.map.scene.focusPoints.map((focusPoint) =>
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]),
          PLAYER_RADIUS,
          PLAYER_BODY_HEIGHT,
        ),
      ),
    ];

    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        const start = candidates[left];
        const end = candidates[right];
        const distance = start.distanceTo(end);

        if (distance < 6 || distance > 20) {
          continue;
        }

        if (
          !hasLineOfSight(
            this.collisionWorld,
            start.clone().setY(PLAYER_EYE_HEIGHT),
            end.clone().setY(PLAYER_EYE_HEIGHT),
          )
        ) {
          continue;
        }

        if (
          !this.hasDebugSightline(
            start.clone().setY(PLAYER_EYE_HEIGHT),
            end.clone().setY(PLAYER_EYE_HEIGHT),
          )
        ) {
          continue;
        }

        return [start, end];
      }
    }

    return this.spawnCandidates.length >= 2
      ? [this.spawnCandidates[0].clone(), this.spawnCandidates[1].clone()]
      : null;
  }

  private hasDebugSightline(start: THREE.Vector3, end: THREE.Vector3): boolean {
    const direction = end.clone().sub(start);
    const distance = direction.length();

    if (distance < 0.01) {
      return false;
    }

    direction.normalize();
    this.scene.updateMatrixWorld(true);
    this.raycaster.set(start, direction);

    const hit = this.raycaster.intersectObjects(this.environmentRaycastMeshes, false)[0];
    return !hit || hit.distance >= distance - 0.8;
  }
}
