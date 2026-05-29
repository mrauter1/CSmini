import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import type { MapDefinition, TeamId, TeamPreference } from "../types";
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
  createHostageAvatar,
  createWeaponRig,
  type CombatantAvatar,
  type HostageAvatar,
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
  CROUCH_EYE_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_AIR_CONTROL,
  PLAYER_CROUCH_MULTIPLIER,
  PLAYER_GRAVITY,
  PLAYER_JUMP_VELOCITY,
  PLAYER_WALK_SPEED,
  STANDING_EYE_HEIGHT,
  createPlayerMovementState,
  currentBodyHeight,
  currentEyeHeight,
  setDebugCameraPose,
  updatePlayerMovement,
  type PlayerMovementState,
} from "./playerMovement";
import {
  CLASSIC_CROUCH_KEY_CODES,
  CROUCH_KEY_CODES,
  crouchControlLabel,
  hasAnyKey,
} from "./controls";
import {
  createBombRuntimeState,
  currentBombProgress,
  hydrateBombRuntimeState,
  serializeBombRuntimeState,
  shouldAdoptBombRuntimeState,
  synchronizeBombCarrier,
  type BombCombatantSnapshot,
  type BombRuntimeState,
} from "./bombState";
import {
  allHostagesExtracted,
  createHostageRuntimeState,
  currentHostageProgress,
  extractedHostageCount,
  hydrateHostageRuntimeState,
  serializeHostageRuntimeState,
  shouldAdoptHostageRuntimeState,
  type HostageRuntimeState,
  type HostageUnitRuntime,
} from "./hostageState";
import {
  ROUND_DURATIONS,
  createBriefingRoundState,
  createInitialRoundState,
  emptyTeamCounts,
  forceRoundActive,
  hydrateRoundState,
  roundPhaseLabel,
  roundTimeRemaining,
  resolveRoundState,
  serializeRoundState,
  shouldAdoptRoundState,
  tickRoundState,
  type RoundState,
  type TeamRoundCounts,
} from "./rounds";
import {
  TEAM_ORDER,
  getTeamDefinition,
  opposingTeam,
  resolveTeamPreference,
} from "./teams";
import {
  buildPatrolRoute,
  buildTacticalProfile,
  buildVisibilityPoints,
  chooseRepositionAnchor,
  evaluateEnemyShotProfile,
  evaluateVisibility,
  resolveObjectiveAnchor,
  rollEnemyShot,
  type EnemyBehavior,
  type EnemyShotProfile,
  type EnemyStance,
  type TacticalAnchor,
  type TacticalProfile,
} from "./tacticalAi";

const FIRE_INTERVAL = 0.18;
const RELOAD_DURATION = 1.05;
const CLIP_SIZE = 24;
const RESERVE_AMMO = 120;
const PLAYER_DAMAGE = 34;
const ENEMY_DAMAGE = 14;
const ENEMY_SPEED = 2.35;
const ENEMY_FIRE_INTERVAL = 0.92;
const ENEMY_ENGAGE_DISTANCE = 20;
const HIT_INDICATOR_DURATION = 0.16;
const DAMAGE_FLASH_DURATION = 0.2;
const MUZZLE_FLASH_DURATION = 0.06;
const REMOTE_LERP_SPEED = 12;
const ENEMY_INVESTIGATION_WINDOW = 3.8;
const ENEMY_PURSUIT_WINDOW = 4.8;
const ENEMY_REPOSITION_WINDOW = 2.2;
const PLAYER_NOISE_INTERVAL = 0.28;
const PLAYER_NOISE_HEARING_RADIUS = 19;
const ENEMY_CROUCH_EYE_HEIGHT = 1.08;
const ENEMY_STANDING_EYE_HEIGHT = 1.45;
const CAPTURED_KEY_EVENT_OPTIONS = { capture: true };

const ENEMY_NAMES = ["Copper-2", "Vale-3", "Rook-4"];

export interface MatchRosterEntry {
  id: string;
  name: string;
  health: number;
  eliminations: number;
  deaths: number;
  local: boolean;
  status: CombatantStatus;
  teamId: TeamId;
  teamLabel: string;
  objectiveRole: string;
}

export interface TeamHudCount {
  teamId: TeamId;
  label: string;
  total: number;
  alive: number;
  accentColor: string;
}

export interface LocalMatchSnapshot {
  mapName: string;
  teamId: TeamId;
  teamName: string;
  teamBanner: string;
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
  roundNumber: number;
  roundPhaseLabel: string;
  roundTimer: string;
  missionLabel: string;
  objectiveLabel: string;
  missionSummary: string;
  objectiveStatus: string;
  objectiveProgress: number;
  objectiveProgressLabel: string;
  aliveState: string;
  teamCounts: TeamHudCount[];
  scoreboardVisible: boolean;
}

interface LocalMatchOptions {
  mode: MatchMode;
  teamPreference: TeamPreference;
  classicCrouchAlias: boolean;
  onActionRequest?: (action: "catalog" | "menu") => void;
  onSnapshot: (snapshot: LocalMatchSnapshot) => void;
}

interface EnemyActor {
  id: string;
  name: string;
  teamId: TeamId;
  avatar: CombatantAvatar;
  health: number;
  alive: boolean;
  eliminations: number;
  deaths: number;
  nextFireAt: number;
  waypointIndex: number;
  waypoints: THREE.Vector3[];
  recoil: number;
  moveBlend: number;
  hitFlashUntil: number;
  spawnPoint: THREE.Vector3;
  ai: {
    role: "anchor" | "route" | "flank";
    behavior: EnemyBehavior;
    stance: EnemyStance;
    targetLabel: string;
    targetPosition: THREE.Vector3;
    objectiveAnchor: TacticalAnchor;
    patrolRoute: TacticalAnchor[];
    patrolIndex: number;
    lastKnownPlayerPosition: THREE.Vector3 | null;
    lastHeardPosition: THREE.Vector3 | null;
    lastSeenAt: number;
    lastHeardAt: number;
    lastDamagedAt: number;
    lastVisibility: number;
    canSeePlayer: boolean;
    blockedBy: string | null;
    repositionReason: "cover" | "angle" | null;
    shotsFired: number;
    shotHits: number;
    shotMisses: number;
    lastShotAt: number;
    lastShotOutcome: "hit" | "miss" | null;
    lastShotProfile: EnemyShotProfile | null;
    rngState: number;
  };
}

interface RemoteActor {
  id: string;
  name: string;
  accentColor: string;
  teamId: TeamId;
  teamPreference: TeamPreference;
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

interface HostageActor {
  id: string;
  avatar: HostageAvatar;
  moveBlend: number;
  lastPosition: THREE.Vector3;
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
  private readonly tacticalProfile: TacticalProfile;
  private readonly audio = new RetroAudio();
  private readonly environmentRaycastMeshes: THREE.Object3D[] = [];
  private readonly enemyRaycastMeshes: THREE.Object3D[] = [];
  private readonly remoteRaycastMeshes: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly movementKeys = new Set<string>();
  private readonly enemies: EnemyActor[] = [];
  private readonly remoteActors = new Map<string, RemoteActor>();
  private readonly weaponRig: WeaponRig;
  private readonly attackDirection = new THREE.Vector3();
  private readonly tempForward = new THREE.Vector3();
  private readonly tempRight = new THREE.Vector3();
  private readonly tempDelta = new THREE.Vector3();
  private readonly tempLook = new THREE.Vector3();
  private readonly tempHitPoint = new THREE.Vector3();
  private readonly tempEnemyMove = new THREE.Vector3();
  private readonly shotRay = new THREE.Ray();
  private readonly remoteHitBox = new THREE.Box3();
  private readonly lookEuler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly playerIdentity: RoomIdentity;
  private readonly roomId: string;
  private readonly movementState: PlayerMovementState;
  private readonly teamSpawnPositions: Record<TeamId, THREE.Vector3>;
  private readonly localTeamPreference: TeamPreference;
  private readonly localTeamId: TeamId;
  private readonly enemyTeamId: TeamId;

  private sharedRoom?: SharedRoomSession;
  private activeMode: MatchMode = "local";
  private sharedRoomFallbackReason = "";
  private animationHandle = 0;
  private roundState: RoundState;
  private bombState: BombRuntimeState | null = null;
  private hostageState: HostageRuntimeState | null = null;
  private playerHealth = 100;
  private ammoInClip = CLIP_SIZE;
  private reserveAmmo = RESERVE_AMMO;
  private playerEliminations = 0;
  private playerDeaths = 0;
  private primaryFireHeld = false;
  private nextShotAt = 0;
  private reloadEndsAt = 0;
  private playerDead = false;
  private recoil = 0;
  private muzzleFlashUntil = 0;
  private hitIndicatorUntil = 0;
  private damageFlashUntil = 0;
  private feedMessage?: FeedMessage;
  private fallbackLookEnabled = false;
  private scoreboardVisible = false;
  private jumpRequested = false;
  private interactHeld = false;
  private classicCrouchAlias: boolean;
  private playerMoveBlend = 0;
  private playerSpeed = 0;
  private playerGrounded = true;
  private playerCrouching = false;
  private playerEyeHeight = currentEyeHeight(createPlayerMovementState());
  private qaInvulnerable = false;
  private readonly hostageActors = new Map<string, HostageActor>();
  private readonly lastPlayerNoisePosition = new THREE.Vector3();
  private lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: MapDefinition,
    private readonly options: LocalMatchOptions,
  ) {
    this.playerIdentity = createRoomIdentity();
    this.roomId = buildRoomId(map.id);
    this.localTeamPreference = options.teamPreference;
    this.localTeamId = resolveTeamPreference(options.teamPreference, []);
    this.enemyTeamId = opposingTeam(this.localTeamId);
    this.movementState = createPlayerMovementState();
    this.playerEyeHeight = currentEyeHeight(this.movementState);
    this.roundState = createInitialRoundState(map, this.roundNow());

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(map.scene.environment.background);
    this.scene.fog = new THREE.Fog(map.scene.environment.fog, 16, 96);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 180);
    this.camera.position.y = this.playerEyeHeight;
    this.scene.add(this.camera);

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);
    this.controls.minPolarAngle = Math.PI * 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.82;
    this.controls.pointerSpeed = 0.88;
    this.controls.addEventListener("lock", this.handlePointerLock);
    this.controls.addEventListener("unlock", this.handlePointerLock);
    this.classicCrouchAlias = options.classicCrouchAlias;

    this.weaponRig = createWeaponRig();
    this.camera.add(this.weaponRig.group);

    this.collisionWorld = buildCollisionWorld(map);
    this.teamSpawnPositions = this.collectTeamSpawnPositions();
    this.tacticalProfile = buildTacticalProfile(
      map,
      this.collisionWorld,
      currentBodyHeight(this.movementState),
    );
    this.sharedRoom = this.initializeSharedRoom();

    this.host.replaceChildren(this.renderer.domElement);
    this.buildScene();

    if (this.activeMode === "local") {
      this.spawnEnemies();
    }

    this.resetRound(true);
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
      scoreboardVisible: this.scoreboardVisible,
      localPlayer: {
        id: this.playerIdentity.id,
        name: this.playerIdentity.name,
        teamId: this.localTeamId,
        teamName: getTeamDefinition(this.localTeamId).name,
        health: this.playerHealth,
        dead: this.playerDead,
        pointerCaptured: this.inputCaptured(),
        grounded: this.playerGrounded,
        crouching: this.playerCrouching,
        speed: Number(this.playerSpeed.toFixed(2)),
        position: {
          x: Number(this.camera.position.x.toFixed(2)),
          y: Number(this.camera.position.y.toFixed(2)),
          z: Number(this.camera.position.z.toFixed(2)),
        },
      },
      round: {
        roundNumber: this.roundState.roundNumber,
        phase: this.roundState.phase,
        missionType: this.roundState.activeMission.missionType,
        timeRemaining: Number(roundTimeRemaining(this.roundState, this.roundNow()).toFixed(2)),
        missionLabel: this.roundState.activeMission.missionLabel,
        objectiveLabel: this.roundState.activeMission.objectiveLabel,
        result: this.roundState.resolutionLabel,
      },
      tuning: {
        movement: {
          standingEyeHeight: Number(STANDING_EYE_HEIGHT.toFixed(2)),
          crouchEyeHeight: Number(CROUCH_EYE_HEIGHT.toFixed(2)),
          walkSpeed: Number(PLAYER_WALK_SPEED.toFixed(2)),
          crouchMultiplier: Number(PLAYER_CROUCH_MULTIPLIER.toFixed(2)),
          crouchSpeed: Number((PLAYER_WALK_SPEED * PLAYER_CROUCH_MULTIPLIER).toFixed(2)),
          airControl: Number(PLAYER_AIR_CONTROL.toFixed(2)),
          gravity: Number(PLAYER_GRAVITY.toFixed(2)),
          jumpVelocity: Number(PLAYER_JUMP_VELOCITY.toFixed(2)),
        },
        weapon: {
          fireInterval: Number(FIRE_INTERVAL.toFixed(2)),
          reloadDuration: Number(RELOAD_DURATION.toFixed(2)),
          clipSize: CLIP_SIZE,
          reserveAmmo: RESERVE_AMMO,
          recoilKickStanding: 0.8,
          recoilKickCrouched: 0.58,
          airborneRecoilPenalty: 0.12,
          playerDamage: PLAYER_DAMAGE,
        },
        round: {
          briefingSeconds: Number(ROUND_DURATIONS.briefing.toFixed(1)),
          activeSeconds: Number(ROUND_DURATIONS.active.toFixed(1)),
          resolutionSeconds: Number(ROUND_DURATIONS.resolution.toFixed(1)),
        },
        ai: {
          enemySpeed: Number(ENEMY_SPEED.toFixed(2)),
          fireInterval: Number(ENEMY_FIRE_INTERVAL.toFixed(2)),
          engageDistance: Number(ENEMY_ENGAGE_DISTANCE.toFixed(1)),
          investigationWindow: Number(ENEMY_INVESTIGATION_WINDOW.toFixed(1)),
          pursuitWindow: Number(ENEMY_PURSUIT_WINDOW.toFixed(1)),
          repositionWindow: Number(ENEMY_REPOSITION_WINDOW.toFixed(1)),
        },
      },
      bomb: this.debugBombStateSnapshot(),
      hostage: this.debugHostageStateSnapshot(),
      teamSpawns: {
        amber: this.toPoint(this.teamSpawnPositions.amber),
        cobalt: this.toPoint(this.teamSpawnPositions.cobalt),
      },
      teamCounts: this.teamCountsSnapshot(),
      roster: this.rosterSnapshot(),
      focusPoints: this.map.scene.focusPoints.map((focusPoint) => ({
        id: focusPoint.id,
        label: focusPoint.label,
        cameraPosition: this.toPoint(
          new THREE.Vector3(
            focusPoint.cameraPosition[0],
            focusPoint.cameraPosition[1],
            focusPoint.cameraPosition[2],
          ),
        ),
        target: this.toPoint(
          new THREE.Vector3(focusPoint.target[0], focusPoint.target[1], focusPoint.target[2]),
        ),
      })),
      enemies: this.enemies.map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        alive: enemy.alive,
        health: enemy.health,
        position: this.toPoint(enemy.avatar.group.position, 0),
        ai: {
          role: enemy.ai.role,
          behavior: enemy.ai.behavior,
          stance: enemy.ai.stance,
          targetLabel: enemy.ai.targetLabel,
          targetPosition: this.toPoint(enemy.ai.targetPosition, 0),
          objectiveLabel: enemy.ai.objectiveAnchor.label,
          patrolRoute: enemy.ai.patrolRoute.map((anchor) => anchor.label),
          patrolIndex: enemy.ai.patrolIndex,
          canSeePlayer: enemy.ai.canSeePlayer,
          visibility: Number(enemy.ai.lastVisibility.toFixed(3)),
          blockedBy: enemy.ai.blockedBy,
          repositionReason: enemy.ai.repositionReason,
          lastSeenAgo:
            enemy.ai.lastSeenAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastSeenAt).toFixed(2))
              : null,
          lastHeardAgo:
            enemy.ai.lastHeardAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastHeardAt).toFixed(2))
              : null,
          lastDamagedAgo:
            enemy.ai.lastDamagedAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastDamagedAt).toFixed(2))
              : null,
          shotsFired: enemy.ai.shotsFired,
          shotHits: enemy.ai.shotHits,
          shotMisses: enemy.ai.shotMisses,
          lastShotAt:
            enemy.ai.lastShotAt > Number.NEGATIVE_INFINITY
              ? Number(enemy.ai.lastShotAt.toFixed(2))
              : null,
          lastShotOutcome: enemy.ai.lastShotOutcome,
          lastShotProfile: enemy.ai.lastShotProfile,
        },
      })),
      remotePlayers: [...this.remoteActors.values()].map((actor) => ({
        id: actor.id,
        name: actor.name,
        teamId: actor.teamId,
        status: actor.status,
        health: actor.health,
        position: this.toPoint(actor.displayPosition),
      })),
    };
  }

  debugSetPose(x: number, z: number, yaw: number, pitch = 0): void {
    this.debugSetCameraPose(x, currentEyeHeight(this.movementState), z, yaw, pitch);
  }

  debugSetCameraPose(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    const holdSeconds = Math.abs(y - currentEyeHeight(this.movementState)) > 0.2 ? 0.75 : 0.12;
    setDebugCameraPose(this.movementState, this.camera, this.gameNow(), x, y, z, holdSeconds);
    this.lookEuler.set(pitch, yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.lookEuler);
    this.playerGrounded = this.movementState.grounded;
    this.playerEyeHeight = currentEyeHeight(this.movementState);
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
    const holdSeconds = Math.abs(y - currentEyeHeight(this.movementState)) > 0.2 ? 0.75 : 0.12;
    setDebugCameraPose(this.movementState, this.camera, this.gameNow(), x, y, z, holdSeconds);
    this.camera.lookAt(targetX, targetY, targetZ);
    this.playerGrounded = this.movementState.grounded;
    this.playerEyeHeight = currentEyeHeight(this.movementState);
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
    const eyeHeight = currentEyeHeight(this.movementState);
    this.debugSetView(self.x, eyeHeight, self.z, target.x, eyeHeight, target.z);

    return {
      self: this.toPoint(self, eyeHeight),
      target: this.toPoint(target, eyeHeight),
    };
  }

  debugFire(): void {
    this.fire(this.gameNow());
    this.emitSnapshot();
  }

  debugForcePlayerDeath(attacker = "QA Rig"): void {
    this.applyPlayerDamage(Math.max(this.playerHealth, 100), attacker, this.gameNow());
    this.emitSnapshot();
  }

  debugForceNextRound(): void {
    this.applyRoundState(
      createBriefingRoundState(this.map, this.roundState.roundNumber + 1, this.roundNow()),
    );
    this.emitSnapshot();
  }

  debugForceRoundActive(): void {
    if (this.roundState.phase !== "briefing") {
      return;
    }

    this.applyRoundState(forceRoundActive(this.roundState, this.roundNow()));
    this.emitSnapshot();
  }

  debugSetInvulnerable(enabled: boolean): void {
    this.qaInvulnerable = enabled;
    this.emitSnapshot();
  }

  debugStartObjectiveAction(): boolean {
    if (this.roundState.phase !== "active" || this.playerDead) {
      return false;
    }

    if (this.bombState) {
      const siteDistance = this.distanceToBombSite(this.camera.position);
      if (siteDistance <= this.bombState.site.radius) {
        if (
          this.bombState.phase === "carried" &&
          this.localTeamId === this.bombState.attackingTeam &&
          this.bombState.carrierId === this.playerIdentity.id
        ) {
          this.interactHeld = true;
          this.startBombPlant(this.roundNow());
          this.emitSnapshot();
          return true;
        }

        if (
          this.bombState.phase === "planted" &&
          this.localTeamId === this.bombState.defendingTeam
        ) {
          this.interactHeld = true;
          this.startBombDefuse(this.roundNow());
          this.emitSnapshot();
          return true;
        }
      }
    }

    if (
      this.hostageState &&
      this.hostageState.phase === "awaiting-rescue" &&
      this.localTeamId === this.hostageState.attackingTeam &&
      this.distanceToHostageCluster(this.camera.position) <= this.hostageState.cluster.radius
    ) {
      this.interactHeld = true;
      this.startHostageSecure(this.roundNow());
      this.emitSnapshot();
      return true;
    }

    return false;
  }

  debugSetKey(code: string, active: boolean): void {
    if (code === "Tab") {
      this.scoreboardVisible = active && this.inputCaptured();
      this.emitSnapshot();
      return;
    }

    if (active) {
      if (code === "Space") {
        if (this.inputCaptured() && !this.playerDead) {
          this.jumpRequested = true;
        }
      } else if (code === "KeyE") {
        this.interactHeld = true;
      } else {
        this.movementKeys.add(code);
      }
    } else {
      if (code === "KeyE") {
        this.interactHeld = false;
      }
      this.movementKeys.delete(code);
    }

    this.emitSnapshot();
  }

  debugJump(): void {
    if (!this.playerDead) {
      this.fallbackLookEnabled = true;
      this.jumpRequested = true;
    }

    this.emitSnapshot();
  }

  setClassicCrouchAlias(enabled: boolean): void {
    this.classicCrouchAlias = enabled;

    if (!enabled) {
      this.movementKeys.delete("ControlLeft");
      this.movementKeys.delete("ControlRight");
    }

    this.emitSnapshot();
  }

  debugJumpSample(): {
    peakY: number;
    landedY: number;
    landed: boolean;
    airborneSeconds: number;
  } {
    const sampleState = createPlayerMovementState();
    const sampleCamera = new THREE.PerspectiveCamera();
    const tempForward = new THREE.Vector3();
    const tempRight = new THREE.Vector3();
    const tempDelta = new THREE.Vector3();
    sampleCamera.quaternion.copy(this.camera.quaternion);
    sampleCamera.position.set(this.camera.position.x, currentEyeHeight(sampleState), this.camera.position.z);
    let peakY = sampleCamera.position.y;
    let landed = false;
    let landedY = sampleCamera.position.y;
    let airborneFrames = 0;

    for (let frame = 0; frame < 180; frame += 1) {
      const result = updatePlayerMovement(
        sampleState,
        sampleCamera,
        this.collisionWorld,
        1 / 60,
        frame / 60,
        {
          enabled: true,
          moveX: 0,
          moveZ: 0,
          crouching: false,
          jumpRequested: frame === 0,
        },
        tempForward,
        tempRight,
        tempDelta,
      );

      peakY = Math.max(peakY, sampleCamera.position.y);
      if (frame > 0 && result.grounded) {
        landed = true;
        landedY = sampleCamera.position.y;
        airborneFrames = frame + 1;
        break;
      }
    }

    return {
      peakY: Number(peakY.toFixed(3)),
      landedY: Number(landedY.toFixed(3)),
      landed,
      airborneSeconds: Number(((landed ? airborneFrames : 180) / 60).toFixed(3)),
    };
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
    if (this.activeMode !== "shared") {
      return null;
    }

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

  debugStageAiSightlineCase():
    | {
        enemyId: string;
        enemyLabel: string;
        blockerName: string;
        enemyPosition: { x: number; y: number; z: number };
        blockedPlayerPosition: { x: number; y: number; z: number };
        clearPlayerPosition: { x: number; y: number; z: number };
        blockedPlayerLabel: string;
        clearPlayerLabel: string;
      }
    | null {
    if (this.activeMode !== "local") {
      return null;
    }

    const caseData = this.findAiSightlineCase();
    if (!caseData) {
      return null;
    }

    const enemy = this.enemies.find((entry) => entry.id === caseData.enemyId);
    if (!enemy) {
      return null;
    }

    enemy.avatar.group.position.copy(caseData.enemyPosition);
    enemy.avatar.group.lookAt(
      caseData.blockedPlayerPosition.x,
      this.playerEyeHeight,
      caseData.blockedPlayerPosition.z,
    );
    this.configureEnemyAi(enemy, this.enemies.indexOf(enemy));
    this.lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;
    this.lastPlayerNoisePosition.copy(caseData.blockedPlayerPosition);
    this.debugSetView(
      caseData.blockedPlayerPosition.x,
      currentEyeHeight(this.movementState),
      caseData.blockedPlayerPosition.z,
      caseData.enemyPosition.x,
      ENEMY_STANDING_EYE_HEIGHT,
      caseData.enemyPosition.z,
    );

    return {
      enemyId: enemy.id,
      enemyLabel: enemy.name,
      blockerName: caseData.blockerName,
      enemyPosition: this.toPoint(caseData.enemyPosition, ENEMY_STANDING_EYE_HEIGHT),
      blockedPlayerPosition: this.toPoint(
        caseData.blockedPlayerPosition,
        currentEyeHeight(this.movementState),
      ),
      clearPlayerPosition: this.toPoint(
        caseData.clearPlayerPosition,
        currentEyeHeight(this.movementState),
      ),
      blockedPlayerLabel: caseData.blockedPlayerLabel,
      clearPlayerLabel: caseData.clearPlayerLabel,
    };
  }

  debugEvaluateEnemyShot(
    combatantId: string,
    overrides?: Partial<{
      distance: number;
      visibility: number;
      targetSpeed: number;
      shooterSpeed: number;
      targetCrouching: boolean;
      shooterCrouching: boolean;
    }>,
  ): EnemyShotProfile | null {
    const enemy = this.enemies.find((entry) => entry.id === combatantId);
    if (!enemy) {
      return null;
    }

    return evaluateEnemyShotProfile({
      distance:
        overrides?.distance ??
        enemy.avatar.group.position.distanceTo(
          new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z),
        ),
      visibility: overrides?.visibility ?? enemy.ai.lastVisibility,
      targetSpeed: overrides?.targetSpeed ?? this.playerSpeed,
      shooterSpeed: overrides?.shooterSpeed ?? (enemy.ai.behavior === "engage" ? 0.35 : ENEMY_SPEED),
      targetCrouching: overrides?.targetCrouching ?? this.playerCrouching,
      shooterCrouching:
        overrides?.shooterCrouching ?? enemy.ai.stance === "crouched",
    });
  }

  private roundNow(): number {
    return Date.now() / 1000;
  }

  private gameNow(): number {
    return performance.now() / 1000;
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

    this.activeMode = "shared";
    return new SharedRoomSession(this.roomId, this.playerIdentity, {
      onPresence: (presence) => {
        this.upsertRemoteActor(presence);

        const remoteRound = hydrateRoundState(this.map, presence.roundState);
        if (remoteRound && shouldAdoptRoundState(this.roundState, remoteRound)) {
          this.applyRoundState(remoteRound);
        }

        const remoteBomb = hydrateBombRuntimeState(
          this.map,
          this.roundState.activeMission,
          presence.bombState,
        );
        if (shouldAdoptBombRuntimeState(this.bombState, remoteBomb)) {
          this.bombState = remoteBomb;
        }

        const remoteHostage = hydrateHostageRuntimeState(
          this.map,
          this.roundState.activeMission,
          presence.hostageState,
        );
        if (shouldAdoptHostageRuntimeState(this.hostageState, remoteHostage)) {
          this.hostageState = remoteHostage;
          this.syncHostageActors();
        }

        this.emitSnapshot();
      },
      onLeave: (peerId) => {
        this.removeRemoteActor(peerId);
        this.emitSnapshot();
      },
      onHit: (event) => {
        this.handleRoomHit(event);
        this.emitSnapshot();
      },
      onElimination: (event) => {
        this.handleRoomElimination(event);
        this.emitSnapshot();
      },
    });
  }

  private buildScene(): void {
    const ambient = new THREE.HemisphereLight(
      this.map.scene.environment.sun,
      this.map.scene.environment.fill,
      1.25,
    );
    ambient.position.set(0, 30, 0);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(this.map.scene.environment.sun, 1.7);
    sun.position.set(18, 28, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 120;
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

  private collectTeamSpawnPositions(): Record<TeamId, THREE.Vector3> {
    const focusLookup = new Map(
      this.map.scene.focusPoints.map((focusPoint) => [focusPoint.id, focusPoint]),
    );

    const resolveTeamSpawn = (teamId: TeamId): THREE.Vector3 => {
      const spawn = this.map.teamSpawns[teamId];
      const focusPoint = focusLookup.get(spawn.focusId);
      const preferred = focusPoint
        ? new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2])
        : new THREE.Vector3(0, 0, teamId === "amber" ? 12 : -12);

      return findOpenGroundPosition(
        this.collisionWorld,
        preferred,
        PLAYER_RADIUS,
        currentBodyHeight(this.movementState),
      );
    };

    return {
      amber: resolveTeamSpawn("amber"),
      cobalt: resolveTeamSpawn("cobalt"),
    };
  }

  private resetRound(initial = false): void {
    this.playerHealth = 100;
    this.playerDead = false;
    this.playerMoveBlend = 0;
    this.playerSpeed = 0;
    this.playerGrounded = true;
    this.playerCrouching = false;
    this.reloadEndsAt = 0;
    this.nextShotAt = 0;
    this.ammoInClip = CLIP_SIZE;
    this.reserveAmmo = RESERVE_AMMO;
    this.recoil = 0;
    this.primaryFireHeld = false;
    this.jumpRequested = false;
    this.interactHeld = false;
    this.movementState.verticalVelocity = 0;
    this.movementState.heightOffset = 0;
    this.movementState.grounded = true;
    this.movementState.crouchBlend = 0;
    this.movementState.spectatorUntil = 0;
    this.playerEyeHeight = currentEyeHeight(this.movementState);
    this.lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;
    this.lastPlayerNoisePosition.copy(this.teamSpawnPositions[this.localTeamId]);

    this.spawnPlayer();

    if (this.activeMode === "local") {
      this.resetEnemies();
    } else {
      this.resetRemoteActorsForRound();
    }

    this.bombState = createBombRuntimeState(
      this.map,
      this.roundState.activeMission,
      this.roundState.roundNumber,
      this.bombCombatants(),
      this.roundNow(),
    );
    this.hostageState = createHostageRuntimeState(
      this.map,
      this.roundState.activeMission,
      this.roundState.roundNumber,
      this.roundNow(),
    );
    this.syncHostageActors();

    this.weaponRig.setVisible(true);

    if (!initial) {
      this.audio.respawn();
      this.pushFeed(
        `Round ${this.roundState.roundNumber} briefing: ${this.roundState.activeMission.objectiveLabel}.`,
        2.2,
      );
    }

    this.publishRoomState(true);
  }

  private spawnPlayer(): void {
    const spawn = this.teamSpawnPositions[this.localTeamId];
    this.camera.position.set(spawn.x, currentEyeHeight(this.movementState), spawn.z);
    this.playerEyeHeight = currentEyeHeight(this.movementState);

    const anchorFocus =
      this.roundState.activeMission.focusId ??
      this.map.tacticalRoutes[0]?.focusId ??
      this.map.scene.focusPoints[0]?.id;
    const focusPoint = this.map.scene.focusPoints.find((entry) => entry.id === anchorFocus);

    if (focusPoint) {
      this.camera.lookAt(focusPoint.target[0], this.playerEyeHeight, focusPoint.target[2]);
    }
  }

  private spawnEnemies(): void {
    for (let index = 0; index < 3; index += 1) {
      const avatar = createCombatantAvatar(getTeamDefinition(this.enemyTeamId).accentColor);
      const spawnPoint = this.enemySpawnPoint(index);
      avatar.group.position.copy(spawnPoint);
      this.scene.add(avatar.group);

      for (const mesh of avatar.hitMeshes) {
        mesh.userData.combatantId = `enemy-${index}`;
        this.enemyRaycastMeshes.push(mesh);
      }

      const enemy: EnemyActor = {
        id: `enemy-${index}`,
        name: ENEMY_NAMES[index % ENEMY_NAMES.length],
        teamId: this.enemyTeamId,
        avatar,
        health: 100,
        alive: true,
        eliminations: 0,
        deaths: 0,
        nextFireAt: 0,
        waypointIndex: 0,
        waypoints: [],
        recoil: 0,
        moveBlend: 0,
        hitFlashUntil: 0,
        spawnPoint,
        ai: {
          role: index === 0 ? "anchor" : index === 1 ? "route" : "flank",
          behavior: index === 0 ? "objective" : "patrol",
          stance: "standing",
          targetLabel: "Spawn",
          targetPosition: spawnPoint.clone(),
          objectiveAnchor: resolveObjectiveAnchor(
            this.tacticalProfile,
            this.map,
            this.roundState.activeMission,
            this.bombState,
            this.hostageState,
            this.enemyTeamId,
          ),
          patrolRoute: [],
          patrolIndex: 0,
          lastKnownPlayerPosition: null,
          lastHeardPosition: null,
          lastSeenAt: Number.NEGATIVE_INFINITY,
          lastHeardAt: Number.NEGATIVE_INFINITY,
          lastDamagedAt: Number.NEGATIVE_INFINITY,
          lastVisibility: 0,
          canSeePlayer: false,
          blockedBy: null,
          repositionReason: null,
          shotsFired: 0,
          shotHits: 0,
          shotMisses: 0,
          lastShotAt: Number.NEGATIVE_INFINITY,
          lastShotOutcome: null,
          lastShotProfile: null,
          rngState: (((index + 1) * 0x9e3779b9) ^ (this.roundState.roundNumber * 2654435761)) >>> 0,
        },
      };

      this.configureEnemyAi(enemy, index);
      this.enemies.push(enemy);
    }
  }

  private resetEnemies(): void {
    for (let index = 0; index < this.enemies.length; index += 1) {
      const enemy = this.enemies[index];
      enemy.alive = true;
      enemy.health = 100;
      enemy.nextFireAt = 0;
      enemy.recoil = 0;
      enemy.moveBlend = 0;
      enemy.hitFlashUntil = 0;
      enemy.spawnPoint = this.enemySpawnPoint(index);
      enemy.avatar.group.position.copy(enemy.spawnPoint);
      enemy.avatar.group.rotation.set(0, 0, 0);
      this.configureEnemyAi(enemy, index);
    }
  }

  private enemySpawnPoint(index: number): THREE.Vector3 {
    const base = this.teamSpawnPositions[this.enemyTeamId];
    const offsets = [
      new THREE.Vector3(-1.8, 0, 1.5),
      new THREE.Vector3(0.5, 0, 0),
      new THREE.Vector3(1.9, 0, -1.2),
    ];
    const preferred = base.clone().add(offsets[index % offsets.length]);

    return findOpenGroundPosition(
      this.collisionWorld,
      preferred,
      PLAYER_RADIUS,
      currentBodyHeight(this.movementState),
    );
  }

  private configureEnemyAi(enemy: EnemyActor, index: number): void {
    const objectiveAnchor = resolveObjectiveAnchor(
      this.tacticalProfile,
      this.map,
      this.roundState.activeMission,
      this.bombState,
      this.hostageState,
      this.enemyTeamId,
    );
    const patrolRoute = buildPatrolRoute(
      this.tacticalProfile,
      objectiveAnchor,
      enemy.spawnPoint,
      index,
    );

    enemy.waypoints = patrolRoute.map((anchor) => anchor.position.clone());
    enemy.waypointIndex = 0;
    enemy.ai.objectiveAnchor = objectiveAnchor;
    enemy.ai.patrolRoute = patrolRoute;
    enemy.ai.patrolIndex = Math.min(index, Math.max(0, patrolRoute.length - 1));
    enemy.ai.behavior = enemy.ai.role === "anchor" ? "objective" : "patrol";
    enemy.ai.stance = "standing";
    enemy.ai.targetLabel =
      enemy.ai.behavior === "objective"
        ? objectiveAnchor.label
        : patrolRoute[enemy.ai.patrolIndex]?.label ?? objectiveAnchor.label;
    enemy.ai.targetPosition.copy(
      enemy.ai.behavior === "objective"
        ? objectiveAnchor.position
        : patrolRoute[enemy.ai.patrolIndex]?.position ?? objectiveAnchor.position,
    );
    enemy.ai.lastKnownPlayerPosition = null;
    enemy.ai.lastHeardPosition = null;
    enemy.ai.lastSeenAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastHeardAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastDamagedAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastVisibility = 0;
    enemy.ai.canSeePlayer = false;
    enemy.ai.blockedBy = null;
    enemy.ai.repositionReason = null;
    enemy.ai.shotsFired = 0;
    enemy.ai.shotHits = 0;
    enemy.ai.shotMisses = 0;
    enemy.ai.lastShotAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastShotOutcome = null;
    enemy.ai.lastShotProfile = null;
    enemy.ai.rngState =
      (((index + 1) * 0x9e3779b9) ^ (this.roundState.roundNumber * 2654435761)) >>> 0;
  }

  private resetRemoteActorsForRound(): void {
    for (const actor of this.remoteActors.values()) {
      const spawn = this.teamSpawnPositions[actor.teamId];
      actor.health = 100;
      actor.status = "alive";
      actor.targetPosition.copy(spawn);
      actor.displayPosition.copy(spawn);
      actor.avatar.group.position.copy(spawn);
      actor.hitFlashUntil = 0;
    }
  }

  private syncHostageActors(): void {
    const activeIds = new Set(this.hostageState?.hostages.map((hostage) => hostage.id) ?? []);

    for (const [hostageId, actor] of this.hostageActors) {
      if (activeIds.has(hostageId)) {
        continue;
      }

      this.scene.remove(actor.avatar.group);
      disposeObject(actor.avatar.group);
      this.hostageActors.delete(hostageId);
    }

    if (!this.hostageState) {
      return;
    }

    for (const hostage of this.hostageState.hostages) {
      const existing = this.hostageActors.get(hostage.id);
      const point = new THREE.Vector3(hostage.position[0], hostage.position[1], hostage.position[2]);

      if (existing) {
        existing.avatar.group.position.copy(point);
        existing.lastPosition.copy(point);
        continue;
      }

      const avatar = createHostageAvatar();
      avatar.group.position.copy(point);
      this.scene.add(avatar.group);
      this.hostageActors.set(hostage.id, {
        id: hostage.id,
        avatar,
        moveBlend: 0,
        lastPosition: point.clone(),
      });
    }
  }

  private updateHostageActors(delta: number, now: number): void {
    if (!this.hostageState) {
      return;
    }

    for (const hostage of this.hostageState.hostages) {
      const actor = this.hostageActors.get(hostage.id);
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

      actor.avatar.update(now, actor.moveBlend, this.hostageState.phase !== "awaiting-rescue");
      actor.avatar.setVisible(!hostage.extracted);
      actor.lastPosition.copy(nextPosition);
    }
  }

  private upsertRemoteActor(presence: RoomPresenceSnapshot): void {
    const existing = this.remoteActors.get(presence.id);
    if (existing) {
      existing.name = presence.name;
      existing.accentColor = presence.accentColor;
      existing.teamId = presence.teamId;
      existing.teamPreference = presence.teamPreference;
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
      teamId: presence.teamId,
      teamPreference: presence.teamPreference,
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
    window.addEventListener("keydown", this.handleKeyDown, CAPTURED_KEY_EVENT_OPTIONS);
    window.addEventListener("keyup", this.handleKeyUp, CAPTURED_KEY_EVENT_OPTIONS);
    window.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("blur", this.handleBlur);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private detachEvents(): void {
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("keydown", this.handleKeyDown, CAPTURED_KEY_EVENT_OPTIONS);
    window.removeEventListener("keyup", this.handleKeyUp, CAPTURED_KEY_EVENT_OPTIONS);
    window.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("blur", this.handleBlur);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
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

  private readonly handlePointerLock = (): void => {
    if (this.controls.isLocked) {
      this.audio.prime();
    } else {
      this.clearActiveInput(true);
    }

    this.emitSnapshot();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.preventDefaultWhenInputCaptured(event);

    if (event.code === "Tab") {
      if (this.inputCaptured()) {
        this.scoreboardVisible = true;
        this.emitSnapshot();
      }
      return;
    }

    if (event.repeat) {
      return;
    }

    if (event.code === "Escape") {
      this.clearActiveInput(true);
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
        this.jumpRequested = true;
      }
      return;
    }

    if (event.code === "KeyE") {
      this.interactHeld = true;
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
    this.preventDefaultWhenInputCaptured(event);

    if (event.code === "Tab") {
      if (this.scoreboardVisible) {
        this.scoreboardVisible = false;
        this.emitSnapshot();
      }
      return;
    }

    if (event.code === "KeyE") {
      this.interactHeld = false;
    }
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
    this.clearActiveInput(true);
    this.emitSnapshot();
  };

  private readonly handleVisibilityChange = (): void => {
    if (!document.hidden) {
      return;
    }

    this.clearActiveInput(true);
    this.emitSnapshot();
  };

  private clearActiveInput(releaseFallbackLook: boolean): void {
    this.primaryFireHeld = false;
    this.jumpRequested = false;
    this.interactHeld = false;
    this.scoreboardVisible = false;
    this.movementKeys.clear();
    if (releaseFallbackLook) {
      this.fallbackLookEnabled = false;
    }
  }

  private preventDefaultWhenInputCaptured(event: KeyboardEvent): void {
    if (!this.inputCaptured() || this.isEditableEventTarget(event.target)) {
      return;
    }

    event.preventDefault();
  }

  private isEditableEventTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  private readonly animate = (): void => {
    this.animationHandle = requestAnimationFrame(this.animate);

    const delta = Math.min(0.04, this.clock.getDelta());
    const now = this.gameNow();
    const roundNow = this.roundNow();

    this.updatePlayer(delta, now);
    if (this.activeMode === "shared") {
      this.updateRemoteActors(delta, now);
    } else {
      this.updateEnemies(delta, now);
    }

    this.updateBombObjectiveState(roundNow);
    this.updateHostageObjectiveState(delta, roundNow);

    const previousRound = this.roundState;
    const nextRound = tickRoundState(
      this.map,
      previousRound,
      roundNow,
      this.teamCountsForRoundTick(),
    );

    if (nextRound !== previousRound) {
      this.applyRoundState(nextRound);
    }

    this.publishRoomState();

    this.weaponRig.update(
      now,
      this.playerMoveBlend,
      this.recoil,
      this.muzzleFlashUntil > now,
      this.movementState.crouchBlend,
      this.playerGrounded ? 0 : 1,
    );
    this.weaponRig.setVisible(!this.playerDead);
    this.recoil = THREE.MathUtils.damp(this.recoil, 0, 14, delta);
    this.updateHostageActors(delta, now);

    this.renderer.render(this.scene, this.camera);
    this.emitSnapshot();
  };

  private applyRoundState(nextState: RoundState): void {
    const previous = this.roundState;
    const roundChanged = previous.roundNumber !== nextState.roundNumber;
    const phaseChanged = previous.phase !== nextState.phase;

    this.roundState = nextState;

    if (roundChanged) {
      this.resetRound();
      return;
    }

    if (!phaseChanged) {
      return;
    }

    if (nextState.phase === "active") {
      this.pushFeed(
        `${nextState.activeMission.missionLabel}: ${nextState.activeMission.objectiveLabel} is live.`,
        1.8,
      );
    } else if (nextState.phase === "resolution") {
      this.pushFeed(nextState.resolutionLabel, 2.4);
    }

    this.publishRoomState(true);
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

    let moveX = 0;
    let moveZ = 0;

    if (this.movementKeys.has("KeyW")) moveZ += 1;
    if (this.movementKeys.has("KeyS")) moveZ -= 1;
    if (this.movementKeys.has("KeyD")) moveX += 1;
    if (this.movementKeys.has("KeyA")) moveX -= 1;

    const previousX = this.camera.position.x;
    const previousZ = this.camera.position.z;

    const movement = updatePlayerMovement(
      this.movementState,
      this.camera,
      this.collisionWorld,
      delta,
      now,
      {
        enabled: this.inputCaptured() && !this.playerDead,
        moveX,
        moveZ,
        crouching: this.crouchHeld(),
        jumpRequested: this.jumpRequested,
      },
      this.tempForward,
      this.tempRight,
      this.tempDelta,
    );

    this.jumpRequested = false;
    this.playerMoveBlend = movement.moveBlend;
    this.playerGrounded = movement.grounded;
    this.playerCrouching = movement.crouching;
    this.playerEyeHeight = movement.eyeHeight;
    const horizontalDistance = Math.hypot(
      this.camera.position.x - previousX,
      this.camera.position.z - previousZ,
    );
    this.playerSpeed = delta > 0 ? horizontalDistance / delta : 0;

    if (
      this.roundState.phase === "active" &&
      !this.playerDead &&
      this.playerSpeed > (this.playerCrouching ? 1.95 : 2.85) &&
      now - this.lastPlayerNoiseAt >= PLAYER_NOISE_INTERVAL
    ) {
      this.registerPlayerNoise(now);
    }

    if (!this.inputCaptured() || this.playerDead) {
      return;
    }

    if (this.primaryFireHeld && now >= this.nextShotAt) {
      this.fire(now);
    }
  }

  private bombCombatants(): BombCombatantSnapshot[] {
    const combatants: BombCombatantSnapshot[] = [
      {
        id: this.playerIdentity.id,
        name: this.playerIdentity.name,
        teamId: this.localTeamId,
        alive: !this.playerDead,
        local: true,
      },
    ];

    if (this.activeMode === "shared") {
      for (const actor of this.remoteActors.values()) {
        combatants.push({
          id: actor.id,
          name: actor.name,
          teamId: actor.teamId,
          alive: actor.status === "alive",
          local: false,
        });
      }

      return combatants;
    }

    for (const enemy of this.enemies) {
      combatants.push({
        id: enemy.id,
        name: enemy.name,
        teamId: enemy.teamId,
        alive: enemy.alive,
        local: false,
      });
    }

    return combatants;
  }

  private bombCombatantById(combatantId: string | null): BombCombatantSnapshot | null {
    if (!combatantId) {
      return null;
    }

    return this.bombCombatants().find((combatant) => combatant.id === combatantId) ?? null;
  }

  private bombCombatantPosition(combatantId: string | null): THREE.Vector3 | null {
    if (!combatantId) {
      return null;
    }

    if (combatantId === this.playerIdentity.id) {
      return this.camera.position.clone();
    }

    const remoteActor = this.remoteActors.get(combatantId);
    if (remoteActor) {
      return remoteActor.displayPosition.clone().setY(this.playerEyeHeight);
    }

    const enemy = this.enemies.find((entry) => entry.id === combatantId);
    if (enemy) {
      return enemy.avatar.group.position.clone().setY(1.45);
    }

    return null;
  }

  private distanceToBombSite(position: THREE.Vector3): number {
    if (!this.bombState) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.hypot(
      position.x - this.bombState.site.position[0],
      position.z - this.bombState.site.position[2],
    );
  }

  private updateBombObjectiveState(now: number): void {
    this.bombState = synchronizeBombCarrier(this.bombState, this.bombCombatants(), now);

    if (!this.bombState || this.roundState.phase !== "active") {
      return;
    }

    if (this.bombState.phase === "planting") {
      const planter = this.bombCombatantById(this.bombState.actingCombatantId);
      const planterPosition = this.bombCombatantPosition(this.bombState.actingCombatantId);
      const planterDistance = planterPosition
        ? this.distanceToBombSite(planterPosition)
        : Number.POSITIVE_INFINITY;
      if (this.bombState.plantEndsAt !== null && now >= this.bombState.plantEndsAt) {
        this.armBomb(now);
        return;
      }
      const localPlanter = this.bombState.actingCombatantId === this.playerIdentity.id;
      const plantingBroken =
        !planter ||
        !planter.alive ||
        planterDistance > this.bombState.site.radius + 0.2 ||
        (localPlanter &&
          (!this.interactHeld || this.playerDead || !this.inputCaptured()));

      if (plantingBroken) {
        this.cancelBombPlant(now);
        return;
      }
      return;
    }

    if (this.bombState.phase === "defusing") {
      const defuser = this.bombCombatantById(this.bombState.actingCombatantId);
      const defuserPosition = this.bombCombatantPosition(this.bombState.actingCombatantId);
      const defuserDistance = defuserPosition
        ? this.distanceToBombSite(defuserPosition)
        : Number.POSITIVE_INFINITY;
      if (this.bombState.defuseEndsAt !== null && now >= this.bombState.defuseEndsAt) {
        const defuserName = this.bombState.actingCombatantName ?? "Operator";
        this.applyRoundState(
          resolveRoundState(
            this.roundState,
            this.bombState.defendingTeam,
            `${defuserName} disarmed ${this.bombState.site.label}.`,
            now,
          ),
        );
        return;
      }
      const localDefuser = this.bombState.actingCombatantId === this.playerIdentity.id;
      const defuseBroken =
        !defuser ||
        !defuser.alive ||
        defuserDistance > this.bombState.site.radius + 0.2 ||
        (localDefuser &&
          (!this.interactHeld || this.playerDead || !this.inputCaptured()));

      if (defuseBroken) {
        this.cancelBombDefuse(now);
        return;
      }
      return;
    }

    if (this.bombState.phase === "planted") {
      if (this.bombState.detonatesAt !== null && now >= this.bombState.detonatesAt) {
        const planterName = this.bombState.plantedByName ?? "Amber Vanguard";
        this.applyRoundState(
          resolveRoundState(
            this.roundState,
            this.bombState.attackingTeam,
            `${planterName} breached ${this.bombState.site.label}.`,
            now,
          ),
        );
        return;
      }

      const canDefuse =
        this.localTeamId === this.bombState.defendingTeam &&
        !this.playerDead &&
        this.inputCaptured() &&
        this.interactHeld &&
        this.distanceToBombSite(this.camera.position) <= this.bombState.site.radius;

      if (canDefuse) {
        this.startBombDefuse(now);
      }

      return;
    }

    const canPlant =
      this.localTeamId === this.bombState.attackingTeam &&
      this.bombState.carrierId === this.playerIdentity.id &&
      !this.playerDead &&
      this.inputCaptured() &&
      this.interactHeld &&
      this.distanceToBombSite(this.camera.position) <= this.bombState.site.radius;

    if (canPlant) {
      this.startBombPlant(now);
    }
  }

  private distanceToHostageCluster(position: THREE.Vector3): number {
    if (!this.hostageState) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.hypot(
      position.x - this.hostageState.cluster.position[0],
      position.z - this.hostageState.cluster.position[2],
    );
  }

  private distanceToExtractionZone(position: THREE.Vector3): number {
    if (!this.hostageState) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.hypot(
      position.x - this.hostageState.extraction.position[0],
      position.z - this.hostageState.extraction.position[2],
    );
  }

  private hostageObjectiveAuthority(): boolean {
    if (!this.hostageState) {
      return false;
    }

    if (this.activeMode === "local") {
      return true;
    }

    if (this.hostageState.phase === "awaiting-rescue") {
      return this.localTeamId === this.hostageState.attackingTeam;
    }

    return (
      this.hostageState.actingCombatantId === this.playerIdentity.id ||
      this.hostageState.rescuerId === this.playerIdentity.id
    );
  }

  private hostageFormationOffset(slotIndex: number): THREE.Vector3 {
    const offsets = [
      new THREE.Vector3(-0.75, 0, -0.2),
      new THREE.Vector3(0.75, 0, -0.2),
      new THREE.Vector3(-0.75, 0, 0.65),
      new THREE.Vector3(0.75, 0, 0.65),
    ];

    return offsets[slotIndex % offsets.length] ?? new THREE.Vector3();
  }

  private hostageTargetPoint(hostage: HostageUnitRuntime): THREE.Vector3 {
    if (!this.hostageState) {
      return new THREE.Vector3();
    }

    const finalIndex = Math.max(0, this.hostageState.route.length - 1);
    const targetIndex = Math.min(hostage.pathIndex, finalIndex);
    const target = this.hostageState.route[targetIndex] ?? this.hostageState.route[finalIndex];

    if (!target) {
      return new THREE.Vector3();
    }

    const point = new THREE.Vector3(target.position[0], target.position[1], target.position[2]);
    if (targetIndex === finalIndex) {
      point.add(this.hostageFormationOffset(hostage.slotIndex));
    }

    return point;
  }

  private allHostagesAtExtraction(): boolean {
    return allHostagesExtracted(this.hostageState);
  }

  private updateHostageEscortMovement(delta: number, now: number): void {
    if (
      !this.hostageState ||
      (this.hostageState.phase !== "escorting" && this.hostageState.phase !== "extracting")
    ) {
      return;
    }

    const rescuer = this.bombCombatantById(this.hostageState.rescuerId);
    if (!rescuer?.alive) {
      return;
    }

    const hostageState = this.hostageState;
    const routeEnd = Math.max(0, hostageState.route.length - 1);
    const movementDelta = THREE.MathUtils.clamp(now - hostageState.updatedAt, 0.016, 1);
    let changed = false;
    const nextHostages = hostageState.hostages.map((hostage) => {
      if (hostage.extracted) {
        return hostage;
      }

      let pathIndex = hostage.pathIndex;
      let position = new THREE.Vector3(hostage.position[0], hostage.position[1], hostage.position[2]);
      let targetPoint = this.hostageTargetPoint({ ...hostage, pathIndex });
      let distance = position.distanceTo(targetPoint);

      if (distance < 0.7 && pathIndex < routeEnd) {
        pathIndex += 1;
        changed = true;
        targetPoint = this.hostageTargetPoint({ ...hostage, pathIndex });
        distance = position.distanceTo(targetPoint);
      }

      if (distance > 0.01) {
        const direction = targetPoint.clone().sub(position).normalize();
        const step = Math.min(distance, 2.05 * movementDelta);
        const nextPosition = position.clone().add(direction.multiplyScalar(step));

        if (nextPosition.distanceTo(position) > 0.001) {
          changed = true;
          position = nextPosition;
        }
      }

      const extracted =
        pathIndex >= routeEnd &&
        this.distanceToExtractionZone(position) <= hostageState.extraction.radius * 0.72;
      if (extracted !== hostage.extracted) {
        changed = true;
      }

      return {
        ...hostage,
        extracted,
        pathIndex,
        position: [
          Number(position.x.toFixed(4)),
          Number(position.y.toFixed(4)),
          Number(position.z.toFixed(4)),
        ] as [number, number, number],
      };
    });

    if (nextHostages.some((hostage) => hostage.extracted)) {
      for (const hostage of nextHostages) {
        if (hostage.extracted) {
          continue;
        }

        const offset = this.hostageFormationOffset(hostage.slotIndex);
        hostage.extracted = true;
        hostage.pathIndex = routeEnd;
        hostage.position = [
          hostageState.extraction.position[0] + offset.x,
          hostageState.extraction.position[1] + offset.y,
          hostageState.extraction.position[2] + offset.z,
        ];
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    this.hostageState = {
      ...hostageState,
      hostages: nextHostages,
      updatedAt: now,
    };
  }

  private updateHostageObjectiveState(delta: number, now: number): void {
    if (!this.hostageState || this.roundState.phase !== "active") {
      return;
    }

    const authority = this.hostageObjectiveAuthority();
    if (!authority) {
      return;
    }

    if (this.hostageState.phase === "securing") {
      const rescuer = this.bombCombatantById(this.hostageState.actingCombatantId);
      const rescuerPosition = this.bombCombatantPosition(this.hostageState.actingCombatantId);
      const rescuerDistance = rescuerPosition
        ? this.distanceToHostageCluster(rescuerPosition)
        : Number.POSITIVE_INFINITY;

      if (
        this.hostageState.secureEndsAt !== null &&
        now >= this.hostageState.secureEndsAt
      ) {
        this.completeHostageSecure(now);
        return;
      }

      const localSecuring = this.hostageState.actingCombatantId === this.playerIdentity.id;
      const securingBroken =
        !rescuer ||
        !rescuer.alive ||
        rescuerDistance > this.hostageState.cluster.radius + 0.2 ||
        (localSecuring &&
          (!this.interactHeld || this.playerDead || !this.inputCaptured()));

      if (securingBroken) {
        this.cancelHostageSecure(now);
      }

      return;
    }

    if (this.hostageState.phase === "awaiting-rescue") {
      const canSecure =
        this.localTeamId === this.hostageState.attackingTeam &&
        !this.playerDead &&
        this.inputCaptured() &&
        this.interactHeld &&
        this.distanceToHostageCluster(this.camera.position) <= this.hostageState.cluster.radius;

      if (canSecure) {
        this.startHostageSecure(now);
      }

      return;
    }

    this.updateHostageEscortMovement(delta, now);

    if (this.hostageState.phase === "extracting") {
      const rescuerPosition = this.bombCombatantPosition(this.hostageState.rescuerId);
      const extractionBroken =
        !rescuerPosition ||
        this.playerDead ||
        this.distanceToExtractionZone(rescuerPosition) > this.hostageState.extraction.radius + 0.25;

      if (
        this.hostageState.extractEndsAt !== null &&
        now >= this.hostageState.extractEndsAt
      ) {
        const rescuerName = this.hostageState.rescuerName ?? "Cobalt Reach";
        this.applyRoundState(
          resolveRoundState(
            this.roundState,
            this.hostageState.attackingTeam,
            `${rescuerName} extracted ${this.hostageState.cluster.label}.`,
            now,
          ),
        );
        return;
      }

      if (extractionBroken || !this.allHostagesAtExtraction()) {
        this.cancelHostageExtraction(now);
      }

      return;
    }

    const readyToExtract =
      this.hostageState.rescuerId === this.playerIdentity.id &&
      !this.playerDead &&
      this.allHostagesAtExtraction() &&
      this.distanceToExtractionZone(this.camera.position) <= this.hostageState.extraction.radius;

    if (readyToExtract) {
      this.startHostageExtraction(now);
    }
  }

  private startHostageSecure(now: number): void {
    if (!this.hostageState || this.hostageState.phase !== "awaiting-rescue") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "securing",
      actingCombatantId: this.playerIdentity.id,
      actingCombatantName: this.playerIdentity.name,
      secureStartedAt: now,
      secureEndsAt: now + this.hostageState.secureSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Securing ${this.hostageState.cluster.label}...`, 1);
    this.publishRoomState(true);
  }

  private cancelHostageSecure(now: number): void {
    if (!this.hostageState || this.hostageState.phase !== "securing") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "awaiting-rescue",
      actingCombatantId: null,
      actingCombatantName: null,
      secureStartedAt: null,
      secureEndsAt: null,
      updatedAt: now,
    };
    this.pushFeed("Escort link interrupted.", 0.9);
    this.publishRoomState(true);
  }

  private completeHostageSecure(now: number): void {
    if (!this.hostageState || this.hostageState.phase !== "securing") {
      return;
    }

    const rescuerId = this.hostageState.actingCombatantId ?? this.playerIdentity.id;
    const rescuerName = this.hostageState.actingCombatantName ?? this.playerIdentity.name;
    this.hostageState = {
      ...this.hostageState,
      phase: "escorting",
      rescuerId,
      rescuerName,
      actingCombatantId: null,
      actingCombatantName: null,
      secureStartedAt: null,
      secureEndsAt: null,
      updatedAt: now,
    };
    this.pushFeed(`${rescuerName} secured ${this.hostageState.cluster.label}.`, 2.1);
    this.publishRoomState(true);
  }

  private startHostageExtraction(now: number): void {
    if (!this.hostageState || this.hostageState.phase !== "escorting") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "extracting",
      actingCombatantId: this.playerIdentity.id,
      actingCombatantName: this.playerIdentity.name,
      extractStartedAt: now,
      extractEndsAt: now + this.hostageState.extractSeconds,
      updatedAt: now,
    };
    this.roundState = {
      ...this.roundState,
      phaseEndsAt: Math.max(this.roundState.phaseEndsAt, now + this.hostageState.extractSeconds),
    };
    this.pushFeed(`Opening ${this.hostageState.extraction.label}...`, 1.2);
    this.publishRoomState(true);
  }

  private cancelHostageExtraction(now: number): void {
    if (!this.hostageState || this.hostageState.phase !== "extracting") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "escorting",
      actingCombatantId: null,
      actingCombatantName: null,
      extractStartedAt: null,
      extractEndsAt: null,
      updatedAt: now,
    };
    this.pushFeed("Extraction window broken.", 0.9);
    this.publishRoomState(true);
  }

  private startBombPlant(now: number): void {
    if (!this.bombState || this.bombState.phase !== "carried") {
      return;
    }

    this.bombState = {
      ...this.bombState,
      phase: "planting",
      actingCombatantId: this.playerIdentity.id,
      actingCombatantName: this.playerIdentity.name,
      plantStartedAt: now,
      plantEndsAt: now + this.bombState.plantSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Arming ${this.bombState.site.label}...`, 0.9);
    this.publishRoomState(true);
  }

  private cancelBombPlant(now: number): void {
    if (!this.bombState || this.bombState.phase !== "planting") {
      return;
    }

    const carrierName = this.bombState.actingCombatantName ?? this.bombState.carrierName;
    this.bombState = synchronizeBombCarrier(
      {
        ...this.bombState,
        phase: "carried",
        carrierId: this.bombState.actingCombatantId ?? this.bombState.carrierId,
        carrierName,
        actingCombatantId: null,
        actingCombatantName: null,
        plantStartedAt: null,
        plantEndsAt: null,
        updatedAt: now,
      },
      this.bombCombatants(),
      now,
    );

    if (this.bombState?.carrierId === this.playerIdentity.id) {
      this.pushFeed("Charge arm interrupted.", 0.9);
    }

    this.publishRoomState(true);
  }

  private armBomb(now: number): void {
    if (!this.bombState || this.bombState.phase !== "planting") {
      return;
    }

    const planterId = this.bombState.actingCombatantId ?? this.bombState.carrierId;
    const planterName =
      this.bombState.actingCombatantName ?? this.bombState.carrierName ?? "Amber Vanguard";
    this.bombState = {
      ...this.bombState,
      phase: "planted",
      carrierId: null,
      carrierName: null,
      plantedById: planterId,
      plantedByName: planterName,
      actingCombatantId: null,
      actingCombatantName: null,
      plantStartedAt: null,
      plantEndsAt: null,
      defuseStartedAt: null,
      defuseEndsAt: null,
      detonatesAt: now + this.bombState.fuseSeconds,
      updatedAt: now,
    };
    this.roundState = {
      ...this.roundState,
      phaseEndsAt: now + this.bombState.fuseSeconds,
    };
    this.pushFeed(`${planterName} armed ${this.bombState.site.label}.`, 2.2);
    this.publishRoomState(true);
  }

  private startBombDefuse(now: number): void {
    if (!this.bombState || this.bombState.phase !== "planted") {
      return;
    }

    this.bombState = {
      ...this.bombState,
      phase: "defusing",
      actingCombatantId: this.playerIdentity.id,
      actingCombatantName: this.playerIdentity.name,
      defuseStartedAt: now,
      defuseEndsAt: now + this.bombState.defuseSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Disarming ${this.bombState.site.label}...`, 0.9);
    this.publishRoomState(true);
  }

  private cancelBombDefuse(now: number): void {
    if (!this.bombState || this.bombState.phase !== "defusing") {
      return;
    }

    this.bombState = {
      ...this.bombState,
      phase: "planted",
      actingCombatantId: null,
      actingCombatantName: null,
      defuseStartedAt: null,
      defuseEndsAt: null,
      updatedAt: now,
    };

    if (this.localTeamId === this.bombState.defendingTeam) {
      this.pushFeed("Defuse broken.", 0.9);
    }

    this.publishRoomState(true);
  }

  private fire(now: number): void {
    if (this.playerDead || this.roundState.phase !== "active") {
      return;
    }

    if (this.reloadEndsAt > 0) {
      return;
    }

    if (this.ammoInClip <= 0) {
      this.tryReload();
      return;
    }

    this.nextShotAt = now + FIRE_INTERVAL;
    this.ammoInClip -= 1;
    this.recoil = Math.min(
      1,
      this.recoil + (this.playerCrouching ? 0.58 : 0.8) + (this.playerGrounded ? 0 : 0.12),
    );
    this.muzzleFlashUntil = now + MUZZLE_FLASH_DURATION;
    this.audio.fire();
    this.registerPlayerNoise(now);

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
      this.noteEnemyContact(enemy, now);
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();

      if (enemy.health <= 0) {
        enemy.alive = false;
        enemy.deaths += 1;
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

    this.reloadEndsAt = this.gameNow() + RELOAD_DURATION;
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
    const playerFeet = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    const playerVisibilityPoints = this.playerVisibilityPoints();

    for (const enemy of this.enemies) {
      enemy.recoil = THREE.MathUtils.damp(enemy.recoil, 0, 12, delta);

      if (!enemy.alive) {
        enemy.avatar.update(now, 0, false, 0, enemy.hitFlashUntil > now ? 1 : 0);
        continue;
      }

      if (this.roundState.phase !== "active") {
        enemy.moveBlend = THREE.MathUtils.damp(enemy.moveBlend, 0, 8, delta);
        enemy.avatar.update(
          now,
          enemy.moveBlend,
          true,
          enemy.recoil,
          enemy.hitFlashUntil > now ? 1 : 0,
        );
        continue;
      }

      const objectiveAnchor = resolveObjectiveAnchor(
        this.tacticalProfile,
        this.map,
        this.roundState.activeMission,
        this.bombState,
        this.hostageState,
        this.enemyTeamId,
      );
      if (enemy.ai.objectiveAnchor.focusId !== objectiveAnchor.focusId) {
        this.configureEnemyAi(enemy, this.enemies.indexOf(enemy));
      } else {
        enemy.ai.objectiveAnchor = objectiveAnchor;
      }

      const previousVisibility = enemy.ai.canSeePlayer;
      const enemyPosition = enemy.avatar.group.position;
      const enemyEye = this.enemyEyePosition(enemy);
      const toPlayer = playerFeet.clone().sub(enemyPosition);
      const playerDistance = toPlayer.length();
      const visibility = !this.playerDead
        ? evaluateVisibility(this.collisionWorld, enemyEye, playerVisibilityPoints)
        : 0;
      const canSeePlayer =
        !this.playerDead &&
        playerDistance <= ENEMY_ENGAGE_DISTANCE &&
        visibility >= 0.34;
      enemy.ai.canSeePlayer = canSeePlayer;
      enemy.ai.lastVisibility = visibility;
      enemy.ai.blockedBy = canSeePlayer
        ? null
        : this.findBlockingGeometryName(enemyEye, this.camera.position.clone());

      const heardPlayer =
        now - this.lastPlayerNoiseAt <= 1.6 &&
        enemyPosition.distanceTo(this.lastPlayerNoisePosition) <= PLAYER_NOISE_HEARING_RADIUS;
      if (heardPlayer) {
        enemy.ai.lastHeardAt = now;
        enemy.ai.lastHeardPosition = this.lastPlayerNoisePosition.clone();
      }

      if (canSeePlayer) {
        enemy.ai.lastSeenAt = now;
        enemy.ai.lastKnownPlayerPosition = playerFeet.clone();
      }

      let behavior: EnemyBehavior = enemy.ai.role === "anchor" ? "objective" : "patrol";
      let stance: EnemyStance = enemy.ai.role === "anchor" ? "crouched" : "standing";
      let targetPosition = enemy.ai.objectiveAnchor.position.clone();
      let targetLabel = enemy.ai.objectiveAnchor.label;
      let desiredSpeed = ENEMY_SPEED * 0.86;
      let shotProfile: EnemyShotProfile | null = null;
      let shouldShoot = false;
      enemy.ai.repositionReason = null;

      if (canSeePlayer) {
        shotProfile = evaluateEnemyShotProfile({
          distance: playerDistance,
          visibility,
          shooterSpeed: enemy.moveBlend > 0.45 ? ENEMY_SPEED : 0,
          targetSpeed: this.playerSpeed,
          targetCrouching: this.playerCrouching,
          shooterCrouching: enemy.ai.stance === "crouched",
        });

        const underPressure = now - enemy.ai.lastDamagedAt <= ENEMY_REPOSITION_WINDOW;
        const repositionChoice =
          underPressure || visibility < 0.56 || playerDistance < 4.4
            ? chooseRepositionAnchor({
                profile: this.tacticalProfile,
                world: this.collisionWorld,
                bodyHeight: this.enemyBodyHeight(enemy),
                enemyPosition,
                enemyEyeHeight: this.enemyEyeHeight(enemy),
                playerPosition: playerFeet,
                playerVisibilityPoints,
                objectiveAnchor: enemy.ai.objectiveAnchor,
              })
            : null;
        const fallbackAnchor =
          repositionChoice?.anchor ??
          enemy.ai.patrolRoute[(enemy.ai.patrolIndex + 1) % Math.max(enemy.ai.patrolRoute.length, 1)] ??
          enemy.ai.objectiveAnchor;

        if (underPressure) {
          behavior = "reposition";
          stance = repositionChoice?.reason === "cover" ? "crouched" : "standing";
          targetPosition = fallbackAnchor.position.clone();
          targetLabel = fallbackAnchor.label;
          desiredSpeed = ENEMY_SPEED * 1.04;
          enemy.ai.repositionReason = repositionChoice?.reason ?? "angle";
        } else if (repositionChoice) {
          behavior = "reposition";
          stance = repositionChoice.reason === "cover" ? "crouched" : "standing";
          targetPosition = repositionChoice.anchor.position.clone();
          targetLabel = repositionChoice.anchor.label;
          desiredSpeed = ENEMY_SPEED * 1.04;
          enemy.ai.repositionReason = repositionChoice.reason;
        } else if (playerDistance > 11.5) {
          behavior = "pursue";
          stance = "standing";
          targetPosition = playerFeet.clone();
          targetLabel = "Last seen angle";
          desiredSpeed = ENEMY_SPEED;
          shouldShoot = visibility >= 0.72;
        } else {
          behavior = "engage";
          stance = visibility < 0.58 ? "crouched" : "standing";
          targetPosition = enemyPosition.clone();
          targetLabel = visibility >= 0.72 ? "Clear shot" : "Partial angle";
          desiredSpeed = playerDistance > 6.2 ? ENEMY_SPEED * 0.32 : 0;
          shouldShoot = true;
        }
      } else if (
        enemy.ai.lastKnownPlayerPosition &&
        now - enemy.ai.lastSeenAt <= ENEMY_PURSUIT_WINDOW
      ) {
        behavior = "pursue";
        stance = "standing";
        targetPosition = enemy.ai.lastKnownPlayerPosition.clone();
        targetLabel = "Last known position";
        desiredSpeed = ENEMY_SPEED * 1.04;
      } else if (
        enemy.ai.lastHeardPosition &&
        now - enemy.ai.lastHeardAt <= ENEMY_INVESTIGATION_WINDOW
      ) {
        behavior = "investigate";
        stance = "standing";
        targetPosition = enemy.ai.lastHeardPosition.clone();
        targetLabel = "Sound contact";
        desiredSpeed = ENEMY_SPEED * 0.95;
      } else if (enemy.ai.role === "anchor") {
        behavior = "objective";
        stance = enemy.ai.role === "anchor" ? "crouched" : "standing";
        targetPosition = enemy.ai.objectiveAnchor.position.clone();
        targetLabel = enemy.ai.objectiveAnchor.label;
        desiredSpeed = ENEMY_SPEED * 0.82;
      } else {
        behavior = "patrol";
        stance = "standing";
        const routeTarget =
          enemy.ai.patrolRoute[enemy.ai.patrolIndex] ?? enemy.ai.objectiveAnchor;
        targetPosition = routeTarget.position.clone();
        targetLabel = routeTarget.label;
        desiredSpeed = ENEMY_SPEED * 0.88;
      }

      const toTarget = targetPosition.clone().sub(enemyPosition);
      const targetDistance = toTarget.length();
      if (behavior === "patrol" && targetDistance < 0.9 && enemy.ai.patrolRoute.length > 0) {
        enemy.ai.patrolIndex = (enemy.ai.patrolIndex + 1) % enemy.ai.patrolRoute.length;
        const nextPatrol = enemy.ai.patrolRoute[enemy.ai.patrolIndex] ?? enemy.ai.objectiveAnchor;
        targetPosition = nextPatrol.position.clone();
        targetLabel = nextPatrol.label;
      }

      const shouldMove = targetDistance > 0.5 && desiredSpeed > 0.02;
      if (shouldMove) {
        toTarget.normalize();
        this.tempEnemyMove.set(
          toTarget.x * desiredSpeed * delta,
          0,
          toTarget.z * desiredSpeed * delta,
        );

        const next = resolveHorizontalMovement(
          this.collisionWorld,
          enemyPosition,
          this.tempEnemyMove,
          PLAYER_RADIUS * 0.9,
          this.enemyBodyHeight(enemy, stance),
        );

        enemyPosition.x = next.x;
        enemyPosition.z = next.z;
      }

      enemy.ai.behavior = behavior;
      enemy.ai.stance = stance;
      enemy.ai.targetLabel = targetLabel;
      enemy.ai.targetPosition.copy(targetPosition);

      const lookTarget = canSeePlayer ? playerFeet : targetPosition;
      enemy.avatar.group.lookAt(lookTarget.x, this.enemyEyeHeight(enemy), lookTarget.z);

      if (canSeePlayer && shotProfile && !previousVisibility) {
        enemy.nextFireAt = Math.max(enemy.nextFireAt, now + shotProfile.reactionSeconds);
      }

      if (canSeePlayer && shouldShoot && shotProfile && now >= enemy.nextFireAt) {
        const rolled = rollEnemyShot(enemy.ai.rngState, shotProfile);
        enemy.ai.rngState = rolled.state;
        enemy.ai.shotsFired += 1;
        enemy.ai.lastShotAt = now;
        enemy.ai.lastShotProfile = shotProfile;
        enemy.ai.lastShotOutcome = rolled.result.hit ? "hit" : "miss";
        enemy.nextFireAt =
          now + ENEMY_FIRE_INTERVAL + shotProfile.missChance * 0.16 + Math.abs(rolled.result.offsetYawDegrees) * 0.01;
        enemy.recoil = 0.8;

        if (rolled.result.hit) {
          enemy.ai.shotHits += 1;
          this.applyPlayerDamage(ENEMY_DAMAGE, enemy.name, now);
        } else {
          enemy.ai.shotMisses += 1;
        }
      }

      enemy.moveBlend = THREE.MathUtils.damp(enemy.moveBlend, shouldMove ? 1 : 0.16, 8, delta);
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
    this.applyPlayerDamage(event.damage, event.attackerName, this.gameNow(), event.attackerId);
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
      target.status = "down";
      target.hitFlashUntil = this.gameNow() + 0.16;
    }
  }

  private applyPlayerDamage(
    amount: number,
    attacker: string,
    now: number,
    attackerId?: string,
  ): void {
    if (this.playerDead || this.qaInvulnerable) {
      return;
    }

    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.damageFlashUntil = now + DAMAGE_FLASH_DURATION;
    this.audio.playerHit();
    this.publishRoomState(true);

    if (this.playerHealth <= 0) {
      this.playerDead = true;
      this.playerDeaths += 1;

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
      this.pushFeed(`${attacker} dropped you. Hold for the next round reset.`, 2.6);
      this.publishRoomState(true);
      return;
    }

    this.pushFeed(`${attacker} hit you for ${amount}.`, 0.9);
  }

  private pushFeed(text: string, seconds: number): void {
    this.feedMessage = {
      text,
      expiresAt: this.gameNow() + seconds,
    };
  }

  private teamCountsSnapshot(): TeamRoundCounts {
    const counts = emptyTeamCounts();

    const add = (teamId: TeamId, alive: boolean): void => {
      counts[teamId].total += 1;
      if (alive) {
        counts[teamId].alive += 1;
      }
    };

    add(this.localTeamId, !this.playerDead);

    if (this.activeMode === "shared") {
      for (const actor of this.remoteActors.values()) {
        add(actor.teamId, actor.status === "alive");
      }
      return counts;
    }

    for (const enemy of this.enemies) {
      add(enemy.teamId, enemy.alive);
    }

    return counts;
  }

  private teamCountsForRoundTick(): TeamRoundCounts {
    const counts = this.teamCountsSnapshot();

    if (
      !this.bombState ||
      (this.bombState.phase !== "planted" && this.bombState.phase !== "defusing")
    ) {
      return counts;
    }

    return {
      ...counts,
      [this.bombState.attackingTeam]: {
        ...counts[this.bombState.attackingTeam],
        alive: Math.max(1, counts[this.bombState.attackingTeam].alive),
      },
    };
  }

  private objectiveRoleForCombatant(combatantId: string): string {
    if (this.hostageState) {
      if (
        this.hostageState.phase === "securing" &&
        this.hostageState.actingCombatantId === combatantId
      ) {
        return "Securing";
      }

      if (
        (this.hostageState.phase === "escorting" ||
          this.hostageState.phase === "extracting") &&
        this.hostageState.rescuerId === combatantId
      ) {
        return "Escort";
      }
    }

    if (!this.bombState) {
      return "";
    }

    if (this.bombState.phase === "carried" && this.bombState.carrierId === combatantId) {
      return "Charge";
    }

    if (this.bombState.phase === "planting" && this.bombState.actingCombatantId === combatantId) {
      return "Arming";
    }

    if (this.bombState.phase === "planted" && this.bombState.plantedById === combatantId) {
      return "Armed";
    }

    if (this.bombState.phase === "defusing" && this.bombState.actingCombatantId === combatantId) {
      return "Defusing";
    }

    return "";
  }

  private rosterSnapshot(): MatchRosterEntry[] {
    const localEntry: MatchRosterEntry = {
      id: this.playerIdentity.id,
      name: this.playerIdentity.name,
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      local: true,
      status: this.playerDead ? "down" : "alive",
      teamId: this.localTeamId,
      teamLabel: getTeamDefinition(this.localTeamId).shortName,
      objectiveRole: this.objectiveRoleForCombatant(this.playerIdentity.id),
    };

    const entries: MatchRosterEntry[] =
      this.activeMode === "shared"
        ? [
            localEntry,
            ...[...this.remoteActors.values()].map<MatchRosterEntry>((actor) => ({
              id: actor.id,
              name: actor.name,
              health: actor.health,
              eliminations: actor.eliminations,
              deaths: actor.deaths,
              local: false,
              status: actor.status,
              teamId: actor.teamId,
              teamLabel: getTeamDefinition(actor.teamId).shortName,
              objectiveRole: this.objectiveRoleForCombatant(actor.id),
            })),
          ]
        : [
            localEntry,
            ...this.enemies.map<MatchRosterEntry>((enemy) => ({
              id: enemy.id,
              name: enemy.name,
              health: enemy.health,
              eliminations: enemy.eliminations,
              deaths: enemy.deaths,
              local: false,
              status: enemy.alive ? "alive" : "down",
              teamId: enemy.teamId,
              teamLabel: getTeamDefinition(enemy.teamId).shortName,
              objectiveRole: this.objectiveRoleForCombatant(enemy.id),
            })),
          ];

    return entries.sort((left, right) => {
      const teamDelta = TEAM_ORDER.indexOf(left.teamId) - TEAM_ORDER.indexOf(right.teamId);
      if (teamDelta !== 0) {
        return teamDelta;
      }

      if (left.local !== right.local) {
        return left.local ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }

  private hudTeamCounts(counts: TeamRoundCounts): TeamHudCount[] {
    return TEAM_ORDER.map((teamId) => {
      const team = getTeamDefinition(teamId);
      return {
        teamId,
        label: team.shortName,
        total: counts[teamId].total,
        alive: counts[teamId].alive,
        accentColor: team.accentColor,
      };
    });
  }

  private emitSnapshot(): void {
    const now = this.gameNow();
    const roundNow = this.roundNow();
    if (this.feedMessage && this.feedMessage.expiresAt <= now) {
      this.feedMessage = undefined;
    }

    const team = getTeamDefinition(this.localTeamId);
    const teamCounts = this.teamCountsSnapshot();
    const roster = this.rosterSnapshot();
    const objectiveHud = this.objectiveHudSnapshot(roundNow);
    const deathLine = this.playerDead ? "Down for the round." : "";

    const statusLine =
      this.playerDead
        ? "Operator down."
        : this.reloadEndsAt > now
          ? `Reloading ${(this.reloadEndsAt - now).toFixed(1)}s`
          : this.feedMessage?.text ?? this.defaultStatusLine();

    const firingStatus =
      this.playerDead
        ? "Down"
        : this.roundState.phase !== "active"
          ? "Hold"
          : this.reloadEndsAt > now
            ? "Reloading"
            : this.ammoInClip === 0
              ? "Dry"
              : "Ready";

    const prompt = this.inputCaptured() ? "" : this.promptText();

    this.options.onSnapshot({
      mapName: this.map.name,
      teamId: this.localTeamId,
      teamName: team.name,
      teamBanner: team.banner,
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
      playerCount: roster.length,
      roster,
      roundNumber: this.roundState.roundNumber,
      roundPhaseLabel: roundPhaseLabel(this.roundState.phase),
      roundTimer: this.formatRoundClock(roundTimeRemaining(this.roundState, roundNow)),
      missionLabel: this.roundState.activeMission.missionLabel,
      objectiveLabel: this.roundState.activeMission.objectiveLabel,
      missionSummary:
        this.roundState.phase === "resolution"
          ? this.roundState.resolutionLabel
          : this.roundState.activeMission.summary,
      objectiveStatus: objectiveHud.status,
      objectiveProgress: objectiveHud.progress,
      objectiveProgressLabel: objectiveHud.progressLabel,
      aliveState: this.playerDead ? "Down" : "Alive",
      teamCounts: this.hudTeamCounts(teamCounts),
      scoreboardVisible: this.scoreboardVisible,
    });
  }

  private objectiveHudSnapshot(now: number): {
    status: string;
    progress: number;
    progressLabel: string;
  } {
    if (this.roundState.activeMission.missionType === "hostage") {
      return this.hostageHudSnapshot(now);
    }

    return this.bombHudSnapshot(now);
  }

  private bombHudSnapshot(now: number): {
    status: string;
    progress: number;
    progressLabel: string;
  } {
    if (!this.bombState) {
      return {
        status: "",
        progress: 0,
        progressLabel: "",
      };
    }

    if (this.roundState.phase === "resolution") {
      return {
        status: "",
        progress: 0,
        progressLabel: "",
      };
    }

    const { progress, secondsRemaining } = currentBombProgress(this.bombState, now);

    if (this.bombState.phase === "carried") {
      const localCarrier = this.bombState.carrierId === this.playerIdentity.id;
      const atSite = this.distanceToBombSite(this.camera.position) <= this.bombState.site.radius;
      return {
        status: this.bombState.carrierName
          ? `Charge with ${this.bombState.carrierName}.`
          : "Charge carrier pending.",
        progress: 0,
        progressLabel:
          localCarrier && atSite && this.roundState.phase === "active"
            ? `Hold E to arm ${this.bombState.site.label}`
            : "",
      };
    }

    if (this.bombState.phase === "planting") {
      return {
        status: `${this.bombState.actingCombatantName ?? "Operator"} arming ${this.bombState.site.label}.`,
        progress,
        progressLabel: `${secondsRemaining.toFixed(1)}s to arm`,
      };
    }

    if (this.bombState.phase === "planted") {
      const atSite = this.distanceToBombSite(this.camera.position) <= this.bombState.site.radius;
      const canDefuse =
        this.localTeamId === this.bombState.defendingTeam &&
        !this.playerDead &&
        this.roundState.phase === "active";
      return {
        status: `${this.bombState.site.label} is armed.`,
        progress,
        progressLabel:
          canDefuse && atSite
            ? `Hold E to disarm · ${secondsRemaining.toFixed(1)}s to breach`
            : `${secondsRemaining.toFixed(1)}s to breach`,
      };
    }

    return {
      status: `${this.bombState.actingCombatantName ?? "Operator"} disarming ${this.bombState.site.label}.`,
      progress,
      progressLabel: `${secondsRemaining.toFixed(1)}s to disarm`,
    };
  }

  private hostageHudSnapshot(now: number): {
    status: string;
    progress: number;
    progressLabel: string;
  } {
    if (!this.hostageState || this.roundState.phase === "resolution") {
      return {
        status: "",
        progress: 0,
        progressLabel: "",
      };
    }

    const { progress, secondsRemaining } = currentHostageProgress(this.hostageState, now);
    const rescuedCount = extractedHostageCount(this.hostageState);
    const totalCount = this.hostageState.hostages.length;

    if (this.hostageState.phase === "awaiting-rescue") {
      const canSecure =
        this.localTeamId === this.hostageState.attackingTeam &&
        !this.playerDead &&
        this.distanceToHostageCluster(this.camera.position) <= this.hostageState.cluster.radius;
      return {
        status: `${this.hostageState.cluster.label} pinned near ${this.hostageState.extraction.label}.`,
        progress: 0,
        progressLabel: canSecure ? `Hold E to secure ${this.hostageState.cluster.label}` : "",
      };
    }

    if (this.hostageState.phase === "securing") {
      return {
        status: `${this.hostageState.actingCombatantName ?? "Operator"} securing ${this.hostageState.cluster.label}.`,
        progress,
        progressLabel: `${secondsRemaining.toFixed(1)}s to link escort`,
      };
    }

    if (this.hostageState.phase === "escorting") {
      const readyToExtract =
        this.hostageState.rescuerId === this.playerIdentity.id &&
        this.allHostagesAtExtraction() &&
        this.distanceToExtractionZone(this.camera.position) <= this.hostageState.extraction.radius;
      return {
        status: `${this.hostageState.rescuerName ?? "Cobalt Reach"} escorting ${this.hostageState.cluster.label}.`,
        progress,
        progressLabel: readyToExtract
          ? `Extraction lane clear at ${this.hostageState.extraction.label}`
          : `${rescuedCount}/${totalCount} through ${this.hostageState.extraction.label}`,
      };
    }

    return {
      status: `${this.hostageState.actingCombatantName ?? "Operator"} extracting ${this.hostageState.cluster.label}.`,
      progress,
      progressLabel: `${secondsRemaining.toFixed(1)}s to clear ${this.hostageState.extraction.label}`,
    };
  }

  private debugBombStateSnapshot(): Record<string, unknown> | null {
    if (!this.bombState) {
      return null;
    }

    const now = this.roundNow();
    const { progress, secondsRemaining } = currentBombProgress(this.bombState, now);
    const siteDistance = this.distanceToBombSite(this.camera.position);

    return {
      phase: this.bombState.phase,
      siteId: this.bombState.site.id,
      siteLabel: this.bombState.site.label,
      siteRadius: this.bombState.site.radius,
      sitePosition: {
        x: Number(this.bombState.site.position[0].toFixed(2)),
        y: Number(this.bombState.site.position[1].toFixed(2)),
        z: Number(this.bombState.site.position[2].toFixed(2)),
      },
      carrierId: this.bombState.carrierId,
      carrierName: this.bombState.carrierName,
      plantedById: this.bombState.plantedById,
      plantedByName: this.bombState.plantedByName,
      actingCombatantId: this.bombState.actingCombatantId,
      actingCombatantName: this.bombState.actingCombatantName,
      progress: Number(progress.toFixed(3)),
      secondsRemaining: Number(secondsRemaining.toFixed(2)),
      plantSeconds: Number(this.bombState.plantSeconds.toFixed(1)),
      defuseSeconds: Number(this.bombState.defuseSeconds.toFixed(1)),
      fuseSeconds: Number(this.bombState.fuseSeconds.toFixed(1)),
      localDistanceToSite: Number(siteDistance.toFixed(2)),
      localCanPlant:
        this.bombState.phase === "carried" &&
        this.bombState.carrierId === this.playerIdentity.id &&
        this.localTeamId === this.bombState.attackingTeam &&
        !this.playerDead &&
        siteDistance <= this.bombState.site.radius,
      localCanDefuse:
        this.bombState.phase === "planted" &&
        this.localTeamId === this.bombState.defendingTeam &&
        !this.playerDead &&
        siteDistance <= this.bombState.site.radius,
    };
  }

  private debugHostageStateSnapshot(): Record<string, unknown> | null {
    if (!this.hostageState) {
      return null;
    }

    const now = this.roundNow();
    const { progress, secondsRemaining } = currentHostageProgress(this.hostageState, now);
    const clusterDistance = this.distanceToHostageCluster(this.camera.position);
    const extractionDistance = this.distanceToExtractionZone(this.camera.position);

    return {
      phase: this.hostageState.phase,
      clusterId: this.hostageState.cluster.id,
      clusterLabel: this.hostageState.cluster.label,
      clusterRadius: this.hostageState.cluster.radius,
      clusterPosition: {
        x: Number(this.hostageState.cluster.position[0].toFixed(2)),
        y: Number(this.hostageState.cluster.position[1].toFixed(2)),
        z: Number(this.hostageState.cluster.position[2].toFixed(2)),
      },
      extractionLabel: this.hostageState.extraction.label,
      extractionRadius: this.hostageState.extraction.radius,
      extractionPosition: {
        x: Number(this.hostageState.extraction.position[0].toFixed(2)),
        y: Number(this.hostageState.extraction.position[1].toFixed(2)),
        z: Number(this.hostageState.extraction.position[2].toFixed(2)),
      },
      route: this.hostageState.route.map((point) => ({
        focusId: point.focusId,
        label: point.label,
        position: {
          x: Number(point.position[0].toFixed(2)),
          y: Number(point.position[1].toFixed(2)),
          z: Number(point.position[2].toFixed(2)),
        },
      })),
      rescuerId: this.hostageState.rescuerId,
      rescuerName: this.hostageState.rescuerName,
      actingCombatantId: this.hostageState.actingCombatantId,
      actingCombatantName: this.hostageState.actingCombatantName,
      progress: Number(progress.toFixed(3)),
      secondsRemaining: Number(secondsRemaining.toFixed(2)),
      secureSeconds: Number(this.hostageState.secureSeconds.toFixed(2)),
      extractSeconds: Number(this.hostageState.extractSeconds.toFixed(2)),
      extractedCount: extractedHostageCount(this.hostageState),
      localDistanceToCluster: Number(clusterDistance.toFixed(2)),
      localDistanceToExtraction: Number(extractionDistance.toFixed(2)),
      localCanSecure:
        this.hostageState.phase === "awaiting-rescue" &&
        this.localTeamId === this.hostageState.attackingTeam &&
        !this.playerDead &&
        clusterDistance <= this.hostageState.cluster.radius,
      localCanExtract:
        this.hostageState.phase === "escorting" &&
        this.hostageState.rescuerId === this.playerIdentity.id &&
        !this.playerDead &&
        this.allHostagesAtExtraction() &&
        extractionDistance <= this.hostageState.extraction.radius,
      hostages: this.hostageState.hostages.map((hostage) => ({
        id: hostage.id,
        slotIndex: hostage.slotIndex,
        extracted: hostage.extracted,
        pathIndex: hostage.pathIndex,
        position: {
          x: Number(hostage.position[0].toFixed(2)),
          y: Number(hostage.position[1].toFixed(2)),
          z: Number(hostage.position[2].toFixed(2)),
        },
      })),
    };
  }

  private defaultStatusLine(): string {
    if (this.roundState.phase === "briefing") {
      return `Round ${this.roundState.roundNumber} briefing. ${this.roundState.activeMission.briefing}`;
    }

    if (this.roundState.phase === "resolution") {
      return this.roundState.resolutionLabel || "Round resetting.";
    }

    const objectiveStatus = this.objectiveHudSnapshot(this.roundNow()).status;
    if (objectiveStatus) {
      return objectiveStatus;
    }

    return this.roundState.activeMission.summary;
  }

  private modeNotice(): string {
    if (this.activeMode === "shared") {
      return this.remoteActors.size > 0
        ? `Shared room live on ${this.map.name}: roster, team colors, and round phase are syncing across this map session.`
        : `Shared room live on ${this.map.name}. Open the same map in a second tab or window to link another operator.`;
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return `Shared room requested, but ${this.sharedRoomFallbackReason} Solo drill armed instead.`;
    }

    return "Solo local round: one player against an opposing fireteam, with round resets driven by the live mission briefing.";
  }

  private promptText(): string {
    const crouchLabel = crouchControlLabel(this.classicCrouchAlias);

    if (this.activeMode === "shared") {
      return `Click the viewport to engage controls. WASD moves, ${crouchLabel} crouches, Space jumps, E interacts with objectives, left click fires, R reloads, and M reopens map select.`;
    }

    if (this.options.mode === "shared" && this.sharedRoomFallbackReason) {
      return `Click the viewport to engage controls. Shared-room sync could not start here, so the app stayed in the solo round without crashing. WASD moves, ${crouchLabel} crouches, Space jumps, E interacts with objectives, left click fires, R reloads, and M reopens map select.`;
    }

    return `Click the viewport to engage controls. Pointer lock is used when available; fallback mouse-look stays browser-safe. WASD moves, ${crouchLabel} crouches, Space jumps, E interacts with objectives, left click fires, R reloads, and M reopens map select.`;
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
      teamId: this.localTeamId,
      teamPreference: this.localTeamPreference,
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      status: this.playerDead ? "down" : "alive",
      roundState: serializeRoundState(this.roundState),
      bombState: serializeBombRuntimeState(this.bombState),
      hostageState: serializeHostageRuntimeState(this.hostageState),
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

  private crouchHeld(): boolean {
    return (
      hasAnyKey(this.movementKeys, CROUCH_KEY_CODES) ||
      (this.classicCrouchAlias && hasAnyKey(this.movementKeys, CLASSIC_CROUCH_KEY_CODES))
    );
  }

  private enemyEyeHeight(enemy: EnemyActor, stance = enemy.ai.stance): number {
    return stance === "crouched" ? ENEMY_CROUCH_EYE_HEIGHT : ENEMY_STANDING_EYE_HEIGHT;
  }

  private enemyEyePosition(enemy: EnemyActor, stance = enemy.ai.stance): THREE.Vector3 {
    return enemy.avatar.group.position.clone().setY(this.enemyEyeHeight(enemy, stance));
  }

  private enemyBodyHeight(enemy: EnemyActor, stance = enemy.ai.stance): number {
    return stance === "crouched" ? 1.28 : 1.72;
  }

  private playerVisibilityPoints(): THREE.Vector3[] {
    return buildVisibilityPoints(
      new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z),
      this.playerEyeHeight,
      this.playerCrouching,
    );
  }

  private registerPlayerNoise(now: number): void {
    this.lastPlayerNoiseAt = now;
    this.lastPlayerNoisePosition.set(this.camera.position.x, 0, this.camera.position.z);
  }

  private noteEnemyContact(enemy: EnemyActor, now: number): void {
    enemy.ai.lastDamagedAt = now;
    enemy.ai.lastKnownPlayerPosition = new THREE.Vector3(
      this.camera.position.x,
      0,
      this.camera.position.z,
    );
    enemy.ai.lastSeenAt = now;
  }

  private findBlockingGeometryName(origin: THREE.Vector3, target: THREE.Vector3): string | null {
    const direction = target.clone().sub(origin);
    const distance = direction.length();

    if (distance <= 0.01) {
      return null;
    }

    direction.normalize();
    this.scene.updateMatrixWorld(true);
    this.raycaster.set(origin, direction);

    const hit = this.raycaster.intersectObjects(this.environmentRaycastMeshes, false)[0];
    if (!hit || hit.distance >= distance - 0.2) {
      return null;
    }

    return hit.object.name || "blocking geometry";
  }

  private findAiSightlineCase():
    | {
        enemyId: string;
        enemyPosition: THREE.Vector3;
        blockedPlayerPosition: THREE.Vector3;
        clearPlayerPosition: THREE.Vector3;
        blockedPlayerLabel: string;
        clearPlayerLabel: string;
        blockerName: string;
      }
    | null {
    const enemy = this.enemies.find((entry) => entry.alive) ?? this.enemies[0];
    if (!enemy) {
      return null;
    }

    const playerEyeHeight = currentEyeHeight(this.movementState);
    let bestCase:
      | {
          enemyPosition: THREE.Vector3;
          blockedPlayerPosition: THREE.Vector3;
          clearPlayerPosition: THREE.Vector3;
          blockedPlayerLabel: string;
          clearPlayerLabel: string;
          blockerName: string;
          score: number;
        }
      | null = null;

    for (const enemyAnchor of this.tacticalProfile.anchors) {
      const objectiveDistance = enemyAnchor.position.distanceTo(enemy.ai.objectiveAnchor.position);
      if (objectiveDistance > 14) {
        continue;
      }

      const enemyEye = enemyAnchor.position.clone().setY(ENEMY_STANDING_EYE_HEIGHT);

      for (const blockedAnchor of this.tacticalProfile.anchors) {
        if (blockedAnchor.id === enemyAnchor.id) {
          continue;
        }

        const blockedDistance = enemyAnchor.position.distanceTo(blockedAnchor.position);
        if (blockedDistance < 6 || blockedDistance > 20) {
          continue;
        }

        const blockedVisibility = evaluateVisibility(
          this.collisionWorld,
          enemyEye,
          buildVisibilityPoints(blockedAnchor.position, playerEyeHeight, false),
        );
        if (blockedVisibility > 0.05) {
          continue;
        }

        const blockerName = this.findBlockingGeometryName(
          enemyEye,
          blockedAnchor.position.clone().setY(playerEyeHeight),
        );
        if (!blockerName) {
          continue;
        }

        for (const clearAnchor of this.tacticalProfile.anchors) {
          if (clearAnchor.id === enemyAnchor.id || clearAnchor.id === blockedAnchor.id) {
            continue;
          }

          const clearDistance = enemyAnchor.position.distanceTo(clearAnchor.position);
          if (clearDistance < 6 || clearDistance > 20) {
            continue;
          }

          const clearVisibility = evaluateVisibility(
            this.collisionWorld,
            enemyEye,
            buildVisibilityPoints(clearAnchor.position, playerEyeHeight, false),
          );
          if (clearVisibility < 0.67) {
            continue;
          }

          const score =
            objectiveDistance +
            blockedAnchor.position.distanceTo(clearAnchor.position) * 0.14 +
            clearDistance * 0.1;
          if (bestCase && score >= bestCase.score) {
            continue;
          }

          bestCase = {
            enemyPosition: enemyAnchor.position.clone(),
            blockedPlayerPosition: blockedAnchor.position.clone(),
            clearPlayerPosition: clearAnchor.position.clone(),
            blockedPlayerLabel: blockedAnchor.label,
            clearPlayerLabel: clearAnchor.label,
            blockerName,
            score,
          };
        }
      }
    }

    if (!bestCase) {
      return null;
    }

    return {
      enemyId: enemy.id,
      enemyPosition: bestCase.enemyPosition,
      blockedPlayerPosition: bestCase.blockedPlayerPosition,
      clearPlayerPosition: bestCase.clearPlayerPosition,
      blockedPlayerLabel: bestCase.blockedPlayerLabel,
      clearPlayerLabel: bestCase.clearPlayerLabel,
      blockerName: bestCase.blockerName,
    };
  }

  private findDebugDuelPair(): [THREE.Vector3, THREE.Vector3] | null {
    const candidates = [
      this.teamSpawnPositions.amber.clone(),
      this.teamSpawnPositions.cobalt.clone(),
      ...this.map.scene.focusPoints.map((focusPoint) =>
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]),
          PLAYER_RADIUS,
          currentBodyHeight(this.movementState),
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

        const eyeHeight = currentEyeHeight(this.movementState);
        if (
          !hasLineOfSight(
            this.collisionWorld,
            start.clone().setY(eyeHeight),
            end.clone().setY(eyeHeight),
          )
        ) {
          continue;
        }

        if (
          !this.hasDebugSightline(start.clone().setY(eyeHeight), end.clone().setY(eyeHeight))
        ) {
          continue;
        }

        return [start, end];
      }
    }

    return [this.teamSpawnPositions.amber.clone(), this.teamSpawnPositions.cobalt.clone()];
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

  private formatRoundClock(seconds: number): string {
    const wholeSeconds = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(wholeSeconds / 60);
    const remainder = wholeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  private toPoint(vector: THREE.Vector3, forcedY?: number): { x: number; y: number; z: number } {
    return {
      x: Number(vector.x.toFixed(2)),
      y: Number((forcedY ?? vector.y).toFixed(2)),
      z: Number(vector.z.toFixed(2)),
    };
  }
}
