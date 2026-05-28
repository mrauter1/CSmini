import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import type { MapDefinition } from "../types";
import { createPrimitiveMesh, disposeObject } from "../world/primitives";
import {
  buildRoomId,
  createRoomIdentity,
  type CombatantStatus,
  type HostRoomSnapshot,
  type MatchRoomConnection,
  type MatchMode,
  type MatchRoomRole,
  type ParticipantRecord,
  type RoomInputEvent,
  type RoomIdentity,
  type RoomShotClaimEvent,
  type RoomShotResultEvent,
  type TeamAssignment,
} from "../net/matchRoomConnection";
import type { RoomShotClaim, WeaponStateSnapshot } from "../net/protocol";
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
import {
  type CombatantRewindState,
  createInitialWeaponState,
  noteInputSequence,
  SHARED_WEAPON_ID,
  type SharedWeaponState,
  ShotRewindBuffer,
  snapshotWeaponState,
  startWeaponReload,
  syncWeaponState,
  validateShotClaim,
} from "./sharedShotValidation";

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
const FIRE_INTERVAL_MS = FIRE_INTERVAL * 1000;
const RELOAD_DURATION_MS = RELOAD_DURATION * 1000;
const SHOT_MAX_LATENCY_MS = 700;
const SHOT_MAX_FUTURE_SKEW_MS = 180;
const SHOT_MAX_INPUT_SEQUENCE_LAG = 18;
const SHOT_MAX_ORIGIN_DELTA = 1.75;
const SHOT_MAX_AIM_ANGLE_RAD = Math.PI * 0.18;
const SHOT_MAX_RANGE = 72;
const SHOT_REWIND_DRIFT_MS = 180;

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
  sharedRoom?: MatchRoomConnection;
  sharedRoomFallbackReason?: string;
  onActionRequest?: (action: "catalog" | "menu") => void;
  onRoomEnded?: (reason: string) => void;
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
  team: TeamAssignment;
  joinedAt: number;
  avatar: CombatantAvatar;
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  respawnAt: number;
  targetPosition: THREE.Vector3;
  displayPosition: THREE.Vector3;
  forward: THREE.Vector3;
  moveBlend: number;
  hitFlashUntil: number;
  lastSeenAt: number;
  lastInputSequence: number;
  inputMovement: THREE.Vector2;
  inputSprint: boolean;
}

interface FeedMessage {
  text: string;
  expiresAt: number;
}

interface DebugInputState {
  movementX: number;
  movementZ: number;
  sprint: boolean;
}

interface PendingShotClaim {
  claimId: number;
  submittedAt: number;
  targetId?: string;
}

interface DebugShotClaimOverride {
  tick?: number;
  ammoInClip?: number;
  reserveAmmo?: number;
  reloadSequence?: number;
  spreadIndex?: number;
  inputSequence?: number;
  weaponId?: string;
  origin?: { x: number; y: number; z: number };
  direction?: { x: number; y: number; z: number };
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
  private readonly rewindBuffer = new ShotRewindBuffer();
  private readonly remoteWeaponStates = new Map<string, SharedWeaponState>();
  private readonly pendingShotClaims = new Map<number, PendingShotClaim>();
  private readonly recentShotResults: RoomShotResultEvent[] = [];

  private sharedRoom?: MatchRoomConnection;
  private activeMode: MatchMode = "local";
  private sharedRole?: MatchRoomRole;
  private sharedTeam: TeamAssignment = "alpha";
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
  private debugInputState?: DebugInputState;
  private lastInputSentAt = 0;
  private nextInputSequence = 1;
  private lastInputSignature = "";
  private reloadSequence = 0;
  private spreadIndex = 0;
  private nextShotClaimId = 1;
  private nextHostSnapshotId = 1;
  private lastHostSnapshotId = 0;
  private authoritativePosition?: THREE.Vector3;
  private authoritativeRespawnAtMs = 0;
  private lastShotClaim?: RoomShotClaim;
  private lastShotResult?: RoomShotResultEvent;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: MapDefinition,
    private readonly options: LocalMatchOptions,
  ) {
    this.playerIdentity = options.sharedRoom?.identity ?? createRoomIdentity();
    this.roomId = options.sharedRoom?.roomId ?? buildRoomId(map.id);

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
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.recordSharedCombatFrame(Date.now());
    }
    this.emitSnapshot();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationHandle);
    this.detachEvents();

    if (this.controls.isLocked) {
      this.controls.unlock();
    }

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
      sharedRole: this.sharedRole ?? null,
      sharedTeam: this.sharedTeam,
      lastHostSnapshotId: this.lastHostSnapshotId,
      localPlayer: {
        id: this.playerIdentity.id,
        name: this.playerIdentity.name,
        health: this.playerHealth,
        dead: this.playerDead,
        ammoInClip: this.ammoInClip,
        reserveAmmo: this.reserveAmmo,
        reloadSequence: this.reloadSequence,
        spreadIndex: this.spreadIndex,
        position: {
          x: Number(this.camera.position.x.toFixed(2)),
          y: Number(this.camera.position.y.toFixed(2)),
          z: Number(this.camera.position.z.toFixed(2)),
        },
      },
      roster: this.rosterSnapshot(),
      roomConnection: this.sharedRoom?.debugSnapshot() ?? null,
      remotePlayers: [...this.remoteActors.values()].map((actor) => ({
        id: actor.id,
        name: actor.name,
        team: actor.team,
        status: actor.status,
        health: actor.health,
        position: {
          x: Number(actor.displayPosition.x.toFixed(2)),
          y: Number(actor.displayPosition.y.toFixed(2)),
          z: Number(actor.displayPosition.z.toFixed(2)),
        },
      })),
      sharedCombat:
        this.activeMode !== "shared"
          ? null
          : {
              pendingShotClaimIds: [...this.pendingShotClaims.keys()],
              lastShotClaim: this.lastShotClaim ?? null,
              lastShotResult: this.lastShotResult ?? null,
              recentShotResults: this.recentShotResults,
              remoteWeaponStates: [...this.remoteWeaponStates.entries()].map(([id, state]) => ({
                id,
                ...snapshotWeaponState(state),
                nextReadyAt: state.nextReadyAt,
                lastInputSequence: state.lastInputSequence,
              })),
            },
    };
  }

  debugSetPose(x: number, z: number, yaw: number, pitch = 0): void {
    this.debugSetCameraPose(x, PLAYER_EYE_HEIGHT, z, yaw, pitch);
  }

  debugSetCameraPose(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    this.camera.position.set(x, y, z);
    this.lookEuler.set(pitch, yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.lookEuler);
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.publishHostSnapshot(true);
    }
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
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.publishHostSnapshot(true);
    }
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

  debugStageBlockedSharedShot(slot: 0 | 1):
    | {
        self: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }
    | null {
    const pair = this.findDebugPair(false);
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

  debugStageAuthoritativeSharedPair(
    kind: "clear" | "blocked",
  ):
    | {
        host: { x: number; y: number; z: number };
        guest: { x: number; y: number; z: number };
        guestId: string;
      }
    | null {
    if (this.activeMode !== "shared" || this.sharedRole !== "host") {
      return null;
    }

    const guestActor = [...this.remoteActors.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )[0];
    if (!guestActor) {
      return null;
    }

    const pair = this.findDebugPair(kind === "clear");
    if (!pair) {
      return null;
    }

    const hostPosition = pair[0];
    const guestPosition = pair[1];
    this.camera.position.set(hostPosition.x, PLAYER_EYE_HEIGHT, hostPosition.z);
    this.camera.lookAt(guestPosition.x, PLAYER_EYE_HEIGHT, guestPosition.z);
    guestActor.targetPosition.copy(guestPosition);
    guestActor.displayPosition.copy(guestPosition);
    guestActor.forward.copy(hostPosition.clone().sub(guestPosition).setY(0).normalize());
    guestActor.lastSeenAt = Date.now();
    this.recordSharedCombatFrame(Date.now());
    this.publishHostSnapshot(true);
    this.emitSnapshot();

    return {
      host: {
        x: Number(hostPosition.x.toFixed(2)),
        y: PLAYER_EYE_HEIGHT,
        z: Number(hostPosition.z.toFixed(2)),
      },
      guest: {
        x: Number(guestPosition.x.toFixed(2)),
        y: PLAYER_EYE_HEIGHT,
        z: Number(guestPosition.z.toFixed(2)),
      },
      guestId: guestActor.id,
    };
  }

  debugFire(): void {
    this.fire(performance.now() / 1000);
    this.emitSnapshot();
  }

  debugSubmitShotClaim(overrides: DebugShotClaimOverride = {}): boolean {
    if (this.activeMode !== "shared" || this.sharedRole !== "guest" || !this.sharedRoom) {
      return false;
    }

    const claim = this.buildShotClaim(Date.now(), overrides);
    if (!claim) {
      return false;
    }

    this.lastShotClaim = claim;
    return this.sharedRoom.sendShotClaim(claim);
  }

  debugStartReload(): void {
    this.tryReload();
    this.emitSnapshot();
  }

  debugForcePlayerDeath(attacker = "QA Rig"): void {
    if (this.activeMode === "shared" && this.sharedRole === "guest") {
      return;
    }
    this.applyPlayerDamage(Math.max(this.playerHealth, 100), attacker, performance.now() / 1000);
    this.emitSnapshot();
  }

  debugSetInputState(movementX: number, movementZ: number, sprint = false): void {
    this.debugInputState = {
      movementX,
      movementZ,
      sprint,
    };
  }

  debugClearInputState(): void {
    this.debugInputState = undefined;
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
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.publishHostSnapshot(true);
    }
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

  private initializeSharedRoom(): MatchRoomConnection | undefined {
    if (this.options.mode !== "shared") {
      this.activeMode = "local";
      return undefined;
    }

    if (!this.options.sharedRoom) {
      this.activeMode = "local";
      this.sharedRoomFallbackReason =
        this.options.sharedRoomFallbackReason ?? "no multiplayer room connection was configured.";
      return undefined;
    }

    this.options.sharedRoom.setHandlers({
      onParticipant: (participant, event) => {
        if (participant.id === this.playerIdentity.id || this.sharedRole !== "host") {
          return;
        }

        this.ensureRemoteActorFromParticipant(participant);
        if (event === "joined") {
          this.pushFeed(`${participant.name} linked into ${this.map.name}.`, 1.6);
          this.publishHostSnapshot(true);
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
        if (this.sharedRole === "host") {
          this.publishHostSnapshot(true);
        }
      },
      onInput: (event) => {
        if (this.sharedRole === "host") {
          this.handleSharedRoomInput(event);
        }
      },
      onShotClaim: (event) => {
        if (this.sharedRole === "host") {
          this.handleSharedShotClaim(event);
        }
      },
      onShotResult: (event) => {
        if (this.sharedRole === "guest") {
          this.handleSharedShotResult(event);
        }
      },
      onSnapshot: (snapshot) => {
        if (this.sharedRole === "guest") {
          this.applyHostSnapshot(snapshot);
        }
      },
      onRoomClosed: (reason) => {
        this.options.onRoomEnded?.(reason);
      },
    });
    this.sharedRole = this.options.sharedRoom.role;
    this.sharedTeam = this.sharedRole === "host" ? "alpha" : "bravo";
    this.activeMode = "shared";

    if (this.sharedRole === "host") {
      for (const participant of this.options.sharedRoom.participantsSnapshot) {
        if (participant.id !== this.playerIdentity.id) {
          this.ensureRemoteActorFromParticipant(participant);
        }
      }
    } else if (this.options.sharedRoom.latestSnapshot) {
      this.applyHostSnapshot(this.options.sharedRoom.latestSnapshot);
    }

    return this.options.sharedRoom;
  }

  private initialSpawnIndex(identityId = this.playerIdentity.id): number {
    if (this.options.mode !== "shared" && identityId === this.playerIdentity.id) {
      return 0;
    }

    let hash = 0;
    for (const character of identityId) {
      hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
    }

    return hash % Math.max(this.spawnCandidates.length, 1);
  }

  private sharedSpawnPoint(identityId: string, deaths = 0): THREE.Vector3 {
    const index =
      (this.initialSpawnIndex(identityId) + Math.max(0, deaths)) %
      Math.max(this.spawnCandidates.length, 1);
    const spawn = this.spawnCandidates[index] ?? this.spawnCandidates[0] ?? new THREE.Vector3();
    return findOpenGroundPosition(
      this.collisionWorld,
      spawn.clone(),
      PLAYER_RADIUS,
      PLAYER_BODY_HEIGHT,
    );
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
    this.authoritativeRespawnAtMs = 0;
    this.reloadEndsAt = 0;
    this.ammoInClip = CLIP_SIZE;
    this.reserveAmmo = RESERVE_AMMO;
    this.reloadSequence = 0;
    this.spreadIndex = 0;
    this.recoil = 0;
    this.weaponRig.setVisible(true);
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.publishHostSnapshot(true);
    }
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

  private ensureRemoteActorFromParticipant(participant: ParticipantRecord): RemoteActor {
    const spawnPosition = this.sharedSpawnPoint(participant.id);
    const existing = this.remoteActors.get(participant.id);

    if (this.sharedRole === "host" && !this.remoteWeaponStates.has(participant.id)) {
      this.remoteWeaponStates.set(participant.id, createInitialWeaponState(CLIP_SIZE, RESERVE_AMMO));
    }

    if (existing) {
      existing.name = participant.name;
      existing.accentColor = participant.accentColor;
      existing.team = participant.team;
      existing.joinedAt = participant.joinedAt;
      return existing;
    }

    const avatar = createCombatantAvatar(participant.accentColor);
    avatar.group.position.copy(spawnPosition);
    this.scene.add(avatar.group);

    for (const mesh of avatar.hitMeshes) {
      mesh.userData.combatantId = participant.id;
      this.remoteRaycastMeshes.push(mesh);
    }

    const actor: RemoteActor = {
      id: participant.id,
      name: participant.name,
      accentColor: participant.accentColor,
      team: participant.team,
      joinedAt: participant.joinedAt,
      avatar,
      health: 100,
      eliminations: 0,
      deaths: 0,
      status: "alive",
      respawnAt: 0,
      targetPosition: spawnPosition.clone(),
      displayPosition: spawnPosition.clone(),
      forward: new THREE.Vector3(0, 0, -1),
      moveBlend: 0,
      hitFlashUntil: 0,
      lastSeenAt: Date.now(),
      lastInputSequence: 0,
      inputMovement: new THREE.Vector2(),
      inputSprint: false,
    };
    this.remoteActors.set(participant.id, actor);
    return actor;
  }

  private upsertRemoteActorFromSnapshot(
    presence: HostRoomSnapshot["roster"][number],
  ): void {
    const existing = this.remoteActors.get(presence.id);
    if (existing) {
      existing.name = presence.name;
      existing.accentColor = presence.accentColor;
      existing.team = presence.team;
      existing.joinedAt = presence.joinedAt;
      existing.health = presence.health;
      existing.eliminations = presence.eliminations;
      existing.deaths = presence.deaths;
      existing.status = presence.status;
      existing.respawnAt = presence.respawnAt;
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
      team: presence.team,
      joinedAt: presence.joinedAt,
      avatar,
      health: presence.health,
      eliminations: presence.eliminations,
      deaths: presence.deaths,
      status: presence.status,
      respawnAt: presence.respawnAt,
      targetPosition: spawnPosition.clone(),
      displayPosition: spawnPosition.clone(),
      forward: new THREE.Vector3(presence.look[0], 0, presence.look[2]).normalize(),
      moveBlend: 0,
      hitFlashUntil: 0,
      lastSeenAt: presence.updatedAt,
      lastInputSequence: 0,
      inputMovement: new THREE.Vector2(),
      inputSprint: false,
    });
  }

  private removeRemoteActor(peerId: string): void {
    const actor = this.remoteActors.get(peerId);
    if (!actor) {
      return;
    }

    this.remoteActors.delete(peerId);
    this.remoteWeaponStates.delete(peerId);
    this.scene.remove(actor.avatar.group);
    disposeObject(actor.avatar.group);

    for (let index = this.remoteRaycastMeshes.length - 1; index >= 0; index -= 1) {
      if (this.remoteRaycastMeshes[index].userData.combatantId === peerId) {
        this.remoteRaycastMeshes.splice(index, 1);
      }
    }
  }

  private handleSharedRoomInput(event: RoomInputEvent): void {
    const participant = this.sharedRoom?.participantsSnapshot.find((entry) => entry.id === event.peerId);
    if (!participant) {
      return;
    }

    const actor = this.ensureRemoteActorFromParticipant(participant);
    if (event.sequence <= actor.lastInputSequence) {
      return;
    }

    const movementLength = Math.hypot(event.movement[0], event.movement[1]);
    if (movementLength > 1.25) {
      return;
    }

    actor.lastInputSequence = event.sequence;
    actor.inputMovement.set(event.movement[0], event.movement[1]);
    actor.inputSprint = event.actions.includes("sprint");
    actor.lastSeenAt = event.sentAt;

    const weaponState = this.remoteWeaponStates.get(event.peerId);
    if (weaponState) {
      noteInputSequence(weaponState, event.sequence);
      syncWeaponState(weaponState, Date.now(), CLIP_SIZE);
      if (event.actions.includes("reload")) {
        startWeaponReload(weaponState, event.tick, CLIP_SIZE, RELOAD_DURATION_MS);
      }
    }

    const lookLength = Math.hypot(event.look[0], event.look[2]);
    if (lookLength > 0.01) {
      actor.forward.set(event.look[0], 0, event.look[2]).normalize();
    }
  }

  private applyHostSnapshot(snapshot: HostRoomSnapshot): void {
    if (snapshot.snapshotId <= this.lastHostSnapshotId) {
      return;
    }

    this.lastHostSnapshotId = snapshot.snapshotId;
    const remoteIds = new Set<string>();

    for (const presence of snapshot.roster) {
      if (presence.id === this.playerIdentity.id) {
        this.applyAuthoritativeLocalState(presence);
        continue;
      }

      remoteIds.add(presence.id);
      this.upsertRemoteActorFromSnapshot(presence);
    }

    for (const peerId of [...this.remoteActors.keys()]) {
      if (!remoteIds.has(peerId)) {
        this.removeRemoteActor(peerId);
      }
    }
  }

  private applyAuthoritativeLocalState(
    presence: HostRoomSnapshot["roster"][number],
  ): void {
    const previousHealth = this.playerHealth;
    const wasDead = this.playerDead;
    const now = performance.now() / 1000;
    const nowMs = Date.now();

    this.sharedTeam = presence.team;
    this.playerHealth = presence.health;
    this.playerEliminations = presence.eliminations;
    this.playerDeaths = presence.deaths;
    this.playerDead = presence.status !== "alive";
    this.authoritativeRespawnAtMs = presence.respawnAt;
    this.playerRespawnsAt =
      presence.respawnAt > 0 ? now + Math.max(0, presence.respawnAt - nowMs) / 1000 : 0;

    if (!this.authoritativePosition) {
      this.authoritativePosition = new THREE.Vector3();
    }
    this.authoritativePosition.set(presence.position[0], PLAYER_EYE_HEIGHT, presence.position[2]);

    if (presence.health < previousHealth && !this.playerDead) {
      this.damageFlashUntil = now + DAMAGE_FLASH_DURATION;
      this.audio.playerHit();
    }

    if (!wasDead && this.playerDead) {
      this.audio.death();
      this.weaponRig.setVisible(false);
    } else if (wasDead && !this.playerDead) {
      this.audio.respawn();
      this.reloadEndsAt = 0;
      this.ammoInClip = CLIP_SIZE;
      this.reserveAmmo = RESERVE_AMMO;
      this.reloadSequence = 0;
      this.spreadIndex = 0;
      this.pendingShotClaims.clear();
      this.weaponRig.setVisible(true);
      this.camera.position.x = presence.position[0];
      this.camera.position.z = presence.position[2];
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
    this.debugInputState = undefined;
    this.fallbackLookEnabled = false;
    this.emitSnapshot();
  };

  private readonly animate = (): void => {
    this.animationHandle = requestAnimationFrame(this.animate);

    const delta = Math.min(0.04, this.clock.getDelta());
    const now = performance.now() / 1000;

    this.updatePlayer(delta, now);
    if (this.activeMode === "shared") {
      if (this.sharedRole === "host") {
        this.updateAuthoritativeRemoteActors(delta);
      } else {
        this.sendLocalInputTick(now);
      }
      this.updateRemoteActors(delta, now);
      if (this.sharedRole === "guest") {
        this.reconcileAuthoritativePosition(delta);
      }
    } else {
      this.updateEnemies(delta, now);
    }
    this.updateRespawns(now);
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.syncRemoteWeaponStates(Date.now());
      this.recordSharedCombatFrame(Date.now());
      this.publishHostSnapshot();
    }
    this.sharedRoom?.tick();

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
    const movement = this.currentMovementState();
    return movement.active && !this.playerDead ? 1 : 0;
  }

  private currentMovementState(): {
    moveX: number;
    moveZ: number;
    sprint: boolean;
    active: boolean;
  } {
    if (this.debugInputState) {
      const length = Math.hypot(this.debugInputState.movementX, this.debugInputState.movementZ);
      return {
        moveX: this.debugInputState.movementX,
        moveZ: this.debugInputState.movementZ,
        sprint: this.debugInputState.sprint,
        active: length > 0.01,
      };
    }

    if (!this.inputCaptured() || this.playerDead) {
      return {
        moveX: 0,
        moveZ: 0,
        sprint: false,
        active: false,
      };
    }

    let moveX = 0;
    let moveZ = 0;

    if (this.movementKeys.has("KeyW")) moveZ += 1;
    if (this.movementKeys.has("KeyS")) moveZ -= 1;
    if (this.movementKeys.has("KeyD")) moveX += 1;
    if (this.movementKeys.has("KeyA")) moveX -= 1;

    return {
      moveX,
      moveZ,
      sprint: this.movementKeys.has("ShiftLeft") || this.movementKeys.has("ShiftRight"),
      active: moveX !== 0 || moveZ !== 0,
    };
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

    if (this.playerDead) {
      return;
    }

    const movement = this.currentMovementState();

    if (movement.active) {
      this.tempForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.tempForward.y = 0;
      this.tempForward.normalize();
      this.tempRight.crossVectors(this.tempForward, new THREE.Vector3(0, 1, 0)).normalize();

      const speed = PLAYER_SPEED * (movement.sprint ? PLAYER_SPRINT_MULTIPLIER : 1);
      const length = Math.hypot(movement.moveX, movement.moveZ);

      this.tempDelta
        .copy(this.tempForward)
        .multiplyScalar((movement.moveZ / length) * speed * delta)
        .addScaledVector(this.tempRight, (movement.moveX / length) * speed * delta);

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

    if (this.primaryFireHeld && this.inputCaptured() && now >= this.nextShotAt) {
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

    this.scene.updateMatrixWorld(true);
    this.attackDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.raycaster.set(this.camera.position, this.attackDirection);
    const environmentIntersections = this.raycaster.intersectObjects(
      this.environmentRaycastMeshes,
      false,
    );
    const environmentDistance = environmentIntersections[0]?.distance ?? Number.POSITIVE_INFINITY;

    if (this.activeMode === "shared") {
      const remoteTarget = this.findRemoteShotTarget(environmentDistance);
      const claim = this.sharedRole === "guest" ? this.buildShotClaim(Date.now()) : null;
      this.applyLocalShotEffects(now);

      if (this.sharedRole === "guest") {
        this.sendGuestShotClaim(claim, remoteTarget, now);
        return;
      }

      if (remoteTarget && remoteTarget.status === "alive") {
        this.applyRemoteActorDamage(remoteTarget, PLAYER_DAMAGE, this.playerIdentity.id, now);
        this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
        this.audio.hitConfirm();
        this.publishHostSnapshot(true);
      }
      return;
    }

    this.applyLocalShotEffects(now);
    const combatantMeshes = this.enemyRaycastMeshes;
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

  private applyLocalShotEffects(now: number): void {
    this.nextShotAt = now + FIRE_INTERVAL;
    this.ammoInClip -= 1;
    this.spreadIndex += 1;
    this.recoil = Math.min(1, this.recoil + 0.8);
    this.muzzleFlashUntil = now + MUZZLE_FLASH_DURATION;
    this.audio.fire();
  }

  private buildShotClaim(
    tickMs: number,
    overrides: DebugShotClaimOverride = {},
  ): RoomShotClaim | null {
    if (this.activeMode !== "shared") {
      return null;
    }

    const direction = overrides.direction
      ? new THREE.Vector3(overrides.direction.x, overrides.direction.y, overrides.direction.z)
      : this.attackDirection.clone();
    if (direction.lengthSq() <= 0.001) {
      direction.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    }
    direction.normalize();

    const origin = overrides.origin
      ? new THREE.Vector3(overrides.origin.x, overrides.origin.y, overrides.origin.z)
      : this.camera.position.clone();

    return {
      claimId: this.nextShotClaimId++,
      shooterId: this.playerIdentity.id,
      tick: overrides.tick ?? tickMs,
      origin: [origin.x, origin.y, origin.z],
      direction: [direction.x, direction.y, direction.z],
      ammoInClip: overrides.ammoInClip ?? this.ammoInClip,
      reserveAmmo: overrides.reserveAmmo ?? this.reserveAmmo,
      reloadSequence: overrides.reloadSequence ?? this.reloadSequence,
      spreadIndex: overrides.spreadIndex ?? this.spreadIndex,
      inputSequence: overrides.inputSequence ?? Math.max(0, this.nextInputSequence - 1),
      weaponId: overrides.weaponId ?? SHARED_WEAPON_ID,
    };
  }

  private sendGuestShotClaim(
    claim: RoomShotClaim | null,
    predictedTarget: RemoteActor | undefined,
    now: number,
  ): void {
    if (!claim || !this.sharedRoom) {
      return;
    }

    this.lastShotClaim = claim;
    this.pendingShotClaims.set(claim.claimId, {
      claimId: claim.claimId,
      submittedAt: Date.now(),
      targetId: predictedTarget?.id,
    });

    if (predictedTarget?.status === "alive") {
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION * 0.45;
    }

    if (!this.sharedRoom.sendShotClaim(claim)) {
      this.pendingShotClaims.delete(claim.claimId);
      this.pushFeed("Shot uplink failed.", 0.7);
    }
  }

  private handleSharedShotClaim(event: RoomShotClaimEvent): void {
    if (this.sharedRole !== "host" || !this.sharedRoom) {
      return;
    }

    const weaponState = this.remoteWeaponStates.get(event.peerId);
    if (!weaponState) {
      return;
    }

    noteInputSequence(weaponState, event.inputSequence);
    syncWeaponState(weaponState, event.tick, CLIP_SIZE);

    const shooter =
      this.rewindBuffer.sample(event.peerId, event.tick, SHOT_REWIND_DRIFT_MS) ??
      (() => {
        const actor = this.remoteActors.get(event.peerId);
        return actor ? this.buildRemoteRewindFrame(actor, Date.now()) : undefined;
      })();
    if (!shooter) {
      const rejected = {
        claimId: event.claimId,
        shooterId: event.shooterId,
        decision: "rejected" as const,
        damage: 0,
        reason: "rewind-missing",
        shooterWeapon: snapshotWeaponState(weaponState),
      };
      this.sharedRoom.sendShotResult(rejected, event.peerId);
      this.lastShotResult = {
        peerId: this.playerIdentity.id,
        sentAt: Date.now(),
        ...rejected,
      };
      return;
    }

    const targets = this.collectShotValidationTargets(event.peerId, event.tick);
    const resolution = validateShotClaim({
      claim: event,
      shooter,
      targets,
      weaponState,
      collisionWorld: this.collisionWorld,
      nowMs: Date.now(),
      config: {
        clipSize: CLIP_SIZE,
        damage: PLAYER_DAMAGE,
        fireIntervalMs: FIRE_INTERVAL_MS,
        maxLatencyMs: SHOT_MAX_LATENCY_MS,
        maxFutureSkewMs: SHOT_MAX_FUTURE_SKEW_MS,
        maxInputSequenceLag: SHOT_MAX_INPUT_SEQUENCE_LAG,
        maxOriginDelta: SHOT_MAX_ORIGIN_DELTA,
        maxAimAngleRad: SHOT_MAX_AIM_ANGLE_RAD,
        maxRange: SHOT_MAX_RANGE,
        rewindDriftMs: SHOT_REWIND_DRIFT_MS,
        targetRadius: 0.55,
        targetHeight: 2.15,
      },
    });

    const now = performance.now() / 1000;
    if (resolution.targetId && resolution.damage > 0) {
      if (resolution.targetId === this.playerIdentity.id) {
        this.applyPlayerDamage(resolution.damage, shooter.name, now, shooter.id);
      } else {
        const target = this.remoteActors.get(resolution.targetId);
        if (target) {
          this.applyRemoteActorDamage(target, resolution.damage, shooter.id, now);
        }
      }
      this.publishHostSnapshot(true);
    }

    this.sharedRoom.sendShotResult(resolution, event.peerId);
    this.lastShotResult = {
      peerId: this.playerIdentity.id,
      sentAt: Date.now(),
      ...resolution,
    };
  }

  private handleSharedShotResult(event: RoomShotResultEvent): void {
    if (event.shooterId !== this.playerIdentity.id) {
      return;
    }

    const now = performance.now() / 1000;
    this.lastShotResult = event;
    this.recentShotResults.push(event);
    if (this.recentShotResults.length > 8) {
      this.recentShotResults.shift();
    }
    const pending = this.pendingShotClaims.get(event.claimId);
    this.pendingShotClaims.delete(event.claimId);
    this.applyAuthoritativeWeaponState(event.shooterWeapon);

    if (event.targetId) {
      const target = this.remoteActors.get(event.targetId);
      if (target) {
        target.health = event.targetHealth ?? target.health;
        target.status = event.targetStatus ?? target.status;
        if (target.status === "respawning") {
          target.respawnAt = Date.now() + PLAYER_RESPAWN_DELAY * 1000;
        }
      }
    }

    if (event.damage > 0 && event.targetId) {
      const target = this.remoteActors.get(event.targetId);
      if (target) {
        target.hitFlashUntil = now + 0.12;
      }
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();
      this.pushFeed(
        event.targetStatus === "respawning" ? "Host confirmed elimination." : "Host confirmed hit.",
        event.targetStatus === "respawning" ? 1.4 : 0.8,
      );
      return;
    }

    if (pending?.targetId) {
      this.hitIndicatorUntil = 0;
    }

    if (event.reason === "blocked-by-cover") {
      this.pushFeed("Host rejected the shot through cover.", 0.9);
      return;
    }

    if (event.reason === "fire-rate") {
      this.pushFeed("Host rejected the shot timing.", 0.9);
      return;
    }

    if (event.reason === "ammo-state" || event.reason === "reload-state") {
      this.pushFeed("Host corrected your weapon state.", 0.9);
    }
  }

  private collectShotValidationTargets(
    shooterId: string,
    tickMs: number,
  ): Array<CombatantRewindState & { capturedAt: number }> {
    const targets: Array<CombatantRewindState & { capturedAt: number }> = [];

    if (this.playerIdentity.id !== shooterId) {
      const localFrame =
        this.rewindBuffer.sample(this.playerIdentity.id, tickMs, SHOT_REWIND_DRIFT_MS) ??
        this.buildLocalRewindFrame(Date.now());
      targets.push(localFrame);
    }

    for (const actor of this.remoteActors.values()) {
      if (actor.id === shooterId) {
        continue;
      }

      const frame =
        this.rewindBuffer.sample(actor.id, tickMs, SHOT_REWIND_DRIFT_MS) ??
        this.buildRemoteRewindFrame(actor, Date.now());
      targets.push(frame);
    }

    return targets;
  }

  private buildLocalRewindFrame(capturedAt: number): CombatantRewindState & { capturedAt: number } {
    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    return {
      id: this.playerIdentity.id,
      name: this.playerIdentity.name,
      team: this.sharedTeam,
      status: this.playerDead ? "respawning" : "alive",
      health: this.playerHealth,
      capturedAt,
      position: this.camera.position.clone(),
      look: this.tempLook.clone(),
    };
  }

  private buildRemoteRewindFrame(
    actor: RemoteActor,
    capturedAt: number,
  ): CombatantRewindState & { capturedAt: number } {
    return {
      id: actor.id,
      name: actor.name,
      team: actor.team,
      status: actor.status,
      health: actor.health,
      capturedAt,
      position: actor.targetPosition.clone().setY(PLAYER_EYE_HEIGHT),
      look: actor.forward.clone(),
    };
  }

  private applyAuthoritativeWeaponState(state: WeaponStateSnapshot): void {
    this.ammoInClip = state.ammoInClip;
    this.reserveAmmo = state.reserveAmmo;
    this.reloadSequence = state.reloadSequence;
    this.spreadIndex = state.spreadIndex;
    if (state.reloadEndsAt > Date.now()) {
      this.reloadEndsAt = performance.now() / 1000 + (state.reloadEndsAt - Date.now()) / 1000;
      return;
    }
    this.reloadEndsAt = 0;
  }

  private applyRemoteActorDamage(
    target: RemoteActor,
    amount: number,
    shooterId: string,
    now: number,
  ): void {
    if (target.status !== "alive") {
      return;
    }

    target.health = Math.max(0, target.health - amount);
    target.hitFlashUntil = now + 0.12;

    if (target.health <= 0) {
      target.deaths += 1;
      target.status = "respawning";
      target.respawnAt = Date.now() + PLAYER_RESPAWN_DELAY * 1000;
      this.awardElimination(shooterId);
      if (shooterId === this.playerIdentity.id) {
        this.pushFeed(`${target.name} dropped.`, 1.7);
      }
      return;
    }

    if (shooterId === this.playerIdentity.id) {
      this.pushFeed(`${target.name} tagged.`, 0.8);
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

    this.reloadSequence += 1;
    this.reloadEndsAt = performance.now() / 1000 + RELOAD_DURATION;
    this.pushFeed("Reloading...", RELOAD_DURATION);
  }

  private updateAuthoritativeRemoteActors(delta: number): void {
    for (const actor of this.remoteActors.values()) {
      if (actor.status !== "alive") {
        continue;
      }

      const inputLength = actor.inputMovement.length();
      if (inputLength <= 0.01) {
        continue;
      }

      this.tempForward.copy(actor.forward);
      if (this.tempForward.lengthSq() <= 0.01) {
        this.tempForward.set(0, 0, -1);
      } else {
        this.tempForward.normalize();
      }

      this.tempRight.crossVectors(this.tempForward, new THREE.Vector3(0, 1, 0)).normalize();

      const speed = PLAYER_SPEED * (actor.inputSprint ? PLAYER_SPRINT_MULTIPLIER : 1);
      this.tempDelta
        .copy(this.tempForward)
        .multiplyScalar((actor.inputMovement.y / inputLength) * speed * delta)
        .addScaledVector(this.tempRight, (actor.inputMovement.x / inputLength) * speed * delta);

      const next = resolveHorizontalMovement(
        this.collisionWorld,
        actor.targetPosition,
        this.tempDelta,
        PLAYER_RADIUS,
        PLAYER_BODY_HEIGHT,
      );

      actor.targetPosition.set(next.x, 0, next.z);
    }
  }

  private sendLocalInputTick(now: number): void {
    if (!this.sharedRoom || this.sharedRole !== "guest") {
      return;
    }

    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    const movement = this.currentMovementState();
    const actions: string[] = [];
    if (movement.sprint) {
      actions.push("sprint");
    }
    if (this.reloadEndsAt > now) {
      actions.push("reload");
    }

    const signature = [
      movement.moveX.toFixed(2),
      movement.moveZ.toFixed(2),
      actions.join(","),
      this.tempLook.x.toFixed(2),
      this.tempLook.z.toFixed(2),
    ].join("|");

    if (signature === this.lastInputSignature && now - this.lastInputSentAt < 0.12) {
      return;
    }

    this.lastInputSignature = signature;
    this.lastInputSentAt = now;
    this.sharedRoom.sendInputTick({
      tick: Date.now(),
      sequence: this.nextInputSequence++,
      look: [this.tempLook.x, this.tempLook.y, this.tempLook.z],
      movement: [movement.moveX, movement.moveZ],
      actions,
    });
  }

  private reconcileAuthoritativePosition(delta: number): void {
    if (!this.authoritativePosition) {
      return;
    }

    const errorX = this.authoritativePosition.x - this.camera.position.x;
    const errorZ = this.authoritativePosition.z - this.camera.position.z;
    const distance = Math.hypot(errorX, errorZ);

    if (distance > 2 || this.playerDead) {
      this.camera.position.x = this.authoritativePosition.x;
      this.camera.position.z = this.authoritativePosition.z;
      return;
    }

    if (distance < 0.02) {
      return;
    }

    const blend = 1 - Math.exp(-10 * delta);
    this.camera.position.x += errorX * blend;
    this.camera.position.z += errorZ * blend;
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
    if (this.activeMode === "shared" && this.sharedRole === "host") {
      this.publishHostSnapshot(true);
    }

    if (this.playerHealth <= 0) {
      this.playerDead = true;
      this.playerDeaths += 1;
      this.playerRespawnsAt = now + PLAYER_RESPAWN_DELAY;
      this.authoritativeRespawnAtMs = Date.now() + PLAYER_RESPAWN_DELAY * 1000;

      if (this.activeMode === "shared" && this.sharedRole === "host" && attackerId) {
        this.awardElimination(attackerId);
      } else if (this.activeMode !== "shared") {
        const killer = this.enemies.find((enemy) => enemy.name === attacker);
        if (killer) {
          killer.eliminations += 1;
        }
      }

      this.audio.death();
      this.pushFeed(`${attacker} dropped you.`, PLAYER_RESPAWN_DELAY);
      if (this.activeMode === "shared" && this.sharedRole === "host") {
        this.publishHostSnapshot(true);
      }
      return;
    }

    this.pushFeed(`${attacker} hit you for ${amount}.`, 0.9);
  }

  private updateRespawns(now: number): void {
    if (
      this.playerDead &&
      this.playerRespawnsAt > 0 &&
      now >= this.playerRespawnsAt &&
      !(this.activeMode === "shared" && this.sharedRole === "guest")
    ) {
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

    if (this.activeMode === "shared" && this.sharedRole === "host") {
      const nowMs = Date.now();
      for (const actor of this.remoteActors.values()) {
        if (actor.status !== "respawning" || actor.respawnAt <= 0 || nowMs < actor.respawnAt) {
          continue;
        }

        actor.health = 100;
        actor.status = "alive";
        actor.respawnAt = 0;
        actor.hitFlashUntil = 0;
        actor.targetPosition.copy(this.sharedSpawnPoint(actor.id, actor.deaths));
        actor.displayPosition.copy(actor.targetPosition);
        const weaponState = this.remoteWeaponStates.get(actor.id);
        if (weaponState) {
          this.remoteWeaponStates.set(actor.id, createInitialWeaponState(CLIP_SIZE, RESERVE_AMMO));
        }
      }
    }
  }

  private syncRemoteWeaponStates(nowMs: number): void {
    for (const state of this.remoteWeaponStates.values()) {
      syncWeaponState(state, nowMs, CLIP_SIZE);
    }
  }

  private recordSharedCombatFrame(capturedAt: number): void {
    if (this.activeMode !== "shared" || this.sharedRole !== "host") {
      return;
    }

    const states: CombatantRewindState[] = [this.buildLocalRewindFrame(capturedAt)];
    for (const actor of this.remoteActors.values()) {
      states.push(this.buildRemoteRewindFrame(actor, capturedAt));
    }

    this.rewindBuffer.record(capturedAt, states);
  }

  private awardElimination(shooterId: string): void {
    if (shooterId === this.playerIdentity.id) {
      this.playerEliminations += 1;
      return;
    }

    const shooter = this.remoteActors.get(shooterId);
    if (shooter) {
      shooter.eliminations += 1;
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
      if (this.remoteActors.size > 0) {
        return `${this.remoteActors.size + 1} operators live in the room.`;
      }

      const detail = this.sharedRoom?.uiSnapshot.detail;
      return detail ?? "Shared room armed. Awaiting another operator.";
    }

    return "Solo skirmish active.";
  }

  private modeNotice(): string {
    if (this.activeMode === "shared") {
      const connection = this.sharedRoom?.uiSnapshot;
      if (connection) {
        return `${connection.title}: ${connection.detail}`;
      }

      return `Shared room live on ${this.map.name}.`;
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return `Shared room requested, but ${this.sharedRoomFallbackReason} Solo drill armed instead.`;
    }

    return "Local fallback mode: solo skirmish with procedural audio and lightweight hostile operators.";
  }

  private promptText(): string {
    if (this.activeMode === "shared") {
      const detail = this.sharedRoom?.uiSnapshot.detail ?? "Shared room connected.";
      return `Click the viewport to engage controls. ${detail} WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.`;
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return "Click the viewport to engage controls. Shared-room sync could not start here, so the app stayed in the solo drill without crashing. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.";
    }

    return "Click the viewport to engage controls. Pointer lock is used when available; fallback mouse-look stays browser-safe. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.";
  }

  private publishHostSnapshot(force = false): void {
    if (this.activeMode !== "shared" || this.sharedRole !== "host" || !this.sharedRoom) {
      return;
    }

    this.sharedRoom.publishHostSnapshot(this.buildHostSnapshot(), force);
  }

  private buildHostSnapshot(): HostRoomSnapshot {
    const now = Date.now();
    const phase = this.remoteActors.size > 0 ? "active" : "waiting";

    return {
      snapshotId: this.nextHostSnapshotId++,
      hostPeerId: this.playerIdentity.id,
      phase,
      roundPhase: phase === "active" ? "live" : "staging",
      objective: {
        objectiveId: "sandbox-room",
        phase: phase === "active" ? "contested" : "idle",
        value: this.remoteActors.size + 1,
        detail:
          phase === "active"
            ? "Host is replicating the room state."
            : "Host is waiting for another operator.",
      },
      roster: [
        this.buildLocalPresenceSnapshot(now),
        ...[...this.remoteActors.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((actor) => this.buildRemotePresenceSnapshot(actor, now)),
      ],
    };
  }

  private buildLocalPresenceSnapshot(now: number): HostRoomSnapshot["roster"][number] {
    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    const localParticipant = this.sharedRoom?.participantsSnapshot.find(
      (entry) => entry.id === this.playerIdentity.id,
    );

    return {
      id: this.playerIdentity.id,
      name: this.playerIdentity.name,
      accentColor: this.playerIdentity.accentColor,
      team: this.sharedTeam,
      joinedAt: localParticipant?.joinedAt ?? now,
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      status: this.playerDead ? "respawning" : "alive",
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      look: [this.tempLook.x, this.tempLook.y, this.tempLook.z],
      respawnAt: this.playerDead ? this.authoritativeRespawnAtMs : 0,
      updatedAt: now,
    };
  }

  private buildRemotePresenceSnapshot(
    actor: RemoteActor,
    now: number,
  ): HostRoomSnapshot["roster"][number] {
    return {
      id: actor.id,
      name: actor.name,
      accentColor: actor.accentColor,
      team: actor.team,
      joinedAt: actor.joinedAt,
      health: actor.health,
      eliminations: actor.eliminations,
      deaths: actor.deaths,
      status: actor.status,
      position: [actor.targetPosition.x, PLAYER_EYE_HEIGHT, actor.targetPosition.z],
      look: [actor.forward.x, 0, actor.forward.z],
      respawnAt: actor.respawnAt,
      updatedAt: now,
    };
  }

  private inputCaptured(): boolean {
    return this.controls.isLocked || this.fallbackLookEnabled;
  }

  private findDebugDuelPair(): [THREE.Vector3, THREE.Vector3] | null {
    return this.findDebugPair(true);
  }

  private findDebugPair(requireLineOfSight: boolean): [THREE.Vector3, THREE.Vector3] | null {
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
        const minDistance = requireLineOfSight ? 6 : 4;
        const maxDistance = requireLineOfSight ? 20 : 28;

        if (distance < minDistance || distance > maxDistance) {
          continue;
        }

        const startView = start.clone().setY(PLAYER_EYE_HEIGHT);
        const endView = end.clone().setY(PLAYER_EYE_HEIGHT);
        const visible = hasLineOfSight(this.collisionWorld, startView, endView);
        if (visible !== requireLineOfSight) {
          continue;
        }

        if (
          requireLineOfSight &&
          !this.hasDebugSightline(startView, endView)
        ) {
          continue;
        }

        return [start, end];
      }
    }

    if (!requireLineOfSight && this.map.id === "sandline-foundry") {
      return [
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(6, 0, 3),
          PLAYER_RADIUS,
          PLAYER_BODY_HEIGHT,
        ),
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(15, 0, 3),
          PLAYER_RADIUS,
          PLAYER_BODY_HEIGHT,
        ),
      ];
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
