import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

import type { MapDefinition, TeamId, TeamPreference } from "../types";
import { createPrimitiveMesh, disposeObject } from "../world/primitives";
import type { BotDifficulty } from "./botDifficulty";
import { botDifficultyTuning, type BotDifficultyTuning } from "./botDifficultyTuning";
import {
  buildRoomId,
  createRoomIdentity,
  type CombatantStatus,
  type HostRoomSnapshot,
  type MatchMode,
  type MatchRoomConnection,
  type MatchRoomRole,
  type ParticipantRecord,
  type RoomIdentity,
  type RoomInputEvent,
  type RoomShotClaimEvent,
  type RoomShotResultEvent,
} from "../net/matchRoomConnection";
import type { RoomShotClaim, WeaponStateSnapshot } from "../net/protocol";
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
  CROUCH_BODY_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_AIR_CONTROL,
  PLAYER_CROUCH_MULTIPLIER,
  PLAYER_GRAVITY,
  PLAYER_JUMP_VELOCITY,
  PLAYER_WALK_SPEED,
  STANDING_BODY_HEIGHT,
  STANDING_EYE_HEIGHT,
  createMovementState,
  createPlayerMovementState,
  currentBodyHeight,
  currentEyeHeight,
  setDebugCameraPose,
  updateSharedMovement,
  updatePlayerMovement,
  type MovementState,
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
  type SerializedBombRuntimeState,
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
  type SerializedHostageRuntimeState,
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
  type SerializedRoundState,
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
  chooseRecoveryAnchor,
  chooseRepositionAnchor,
  evaluateEnemyShotProfile,
  evaluateVisibility,
  nextDeterministicRandom,
  resolveObjectiveAnchor,
  rollEnemyShot,
  type EnemyBehavior,
  type EnemyShotProfile,
  type EnemyStance,
  type TacticalAnchor,
  type TacticalProfile,
} from "./tacticalAi";
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

const FIRE_INTERVAL = 0.18;
const RELOAD_DURATION = 1.05;
const CLIP_SIZE = 24;
const RESERVE_AMMO = 120;
const PLAYER_DAMAGE = 34;
const ENEMY_DAMAGE = PLAYER_DAMAGE;
const ENEMY_FIRE_INTERVAL = FIRE_INTERVAL;
const ENEMY_ENGAGE_DISTANCE = 20;
const HIT_INDICATOR_DURATION = 0.16;
const DAMAGE_FLASH_DURATION = 0.2;
const MUZZLE_FLASH_DURATION = 0.06;
const REMOTE_LERP_SPEED = 12;
const GUEST_ACTIVE_INPUT_PULSE_SECONDS = 1 / 30;
const GUEST_IDLE_INPUT_PULSE_SECONDS = 0.2;
const GUEST_RECENT_ACTIVE_INPUT_SECONDS = 0.25;
const REMOTE_INPUT_DEADMAN_MS = 320;
const LOCAL_INPUT_HISTORY_MAX_ENTRIES = 40;
const LOCAL_INPUT_HISTORY_MAX_AGE_MS = 4_000;
const LOCAL_REPLAY_DELTA_MAX_ENTRIES = 180;
const LOCAL_REPLAY_DELTA_MAX_AGE_MS = 4_000;
const LOCAL_RECONCILE_SNAP_DISTANCE = 2;
const PLAYER_NOISE_INTERVAL = 0.28;
const PLAYER_NOISE_HEARING_RADIUS = 19;
const COMBATANT_AIM_PITCH_LIMIT = Math.PI * 0.34;
const FIRE_INTERVAL_MS = FIRE_INTERVAL * 1000;
const RELOAD_DURATION_MS = RELOAD_DURATION * 1000;
const SHOT_MAX_LATENCY_MS = 700;
const SHOT_MAX_FUTURE_SKEW_MS = 180;
const SHOT_MAX_INPUT_SEQUENCE_LAG = 18;
const SHOT_MAX_ORIGIN_DELTA = 1.85;
const SHOT_MAX_AIM_ANGLE_RAD = Math.PI * 0.18;
const SHOT_MAX_RANGE = 72;
const SHOT_REWIND_DRIFT_MS = 180;
const CAPTURED_KEY_EVENT_OPTIONS = { capture: true };
const COMBATANT_MOVEMENT_OFFSET = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI,
);

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
  fullscreenActive: boolean;
  fullscreenAvailable: boolean;
}

interface LocalMatchOptions {
  mode: MatchMode;
  teamPreference: TeamPreference;
  botDifficulty: BotDifficulty;
  classicCrouchAlias: boolean;
  sharedRoom?: MatchRoomConnection;
  sharedRoomFallbackReason?: string;
  onActionRequest?: (action: "catalog" | "menu") => void;
  onRoomEnded?: (reason: string) => void;
  onSnapshot: (snapshot: LocalMatchSnapshot) => void;
}

type EnemyJumpReason = "qa" | "stuck-recovery";

interface EnemyActor {
  id: string;
  name: string;
  teamId: TeamId;
  avatar: CombatantAvatar;
  movementState: MovementState;
  health: number;
  alive: boolean;
  eliminations: number;
  deaths: number;
  nextFireAt: number;
  waypointIndex: number;
  waypoints: THREE.Vector3[];
  recoil: number;
  moveBlend: number;
  speed: number;
  hitFlashUntil: number;
  spawnPoint: THREE.Vector3;
  lookDirection: THREE.Vector3;
  qaJumpRequested: boolean;
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
    lastSharedContactAt: number;
    lastDamagedAt: number;
    lastLostSightAt: number;
    lastVisibility: number;
    canSeePlayer: boolean;
    blockedBy: string | null;
    repositionReason: "cover" | "angle" | null;
    lastRecoveryReason: "repath" | null;
    recoveryCount: number;
    lastJumpReason: EnemyJumpReason | null;
    jumpCount: number;
    lastJumpAt: number;
    behaviorEnteredAt: number;
    behaviorHoldUntil: number;
    burstShotsRemaining: number;
    burstCooldownUntil: number;
    lastProgressAt: number;
    lastProgressPosition: THREE.Vector3;
    forcedBehavior: EnemyBehavior | null;
    forcedTargetPosition: THREE.Vector3 | null;
    forcedTargetLabel: string | null;
    forcedStance: EnemyStance | null;
    forcedUntil: number;
    shotsFired: number;
    shotHits: number;
    shotMisses: number;
    lastShotAt: number;
    lastShotOutcome: "hit" | "miss" | null;
    lastShotProfile: EnemyShotProfile | null;
    rngState: number;
  };
}

interface PendingEnemyContact {
  targetEnemyId: string;
  sourceEnemyId: string;
  deliverAt: number;
  position: THREE.Vector3;
  kind: "visual" | "sound" | "damage";
}

interface RemoteActor {
  id: string;
  name: string;
  accentColor: string;
  teamId: TeamId;
  teamPreference: TeamPreference;
  joinedAt: number;
  avatar: CombatantAvatar;
  movementState: MovementState;
  health: number;
  eliminations: number;
  deaths: number;
  status: CombatantStatus;
  targetPosition: THREE.Vector3;
  displayPosition: THREE.Vector3;
  forward: THREE.Vector3;
  lookDirection: THREE.Vector3;
  aimPitch: number;
  recoil: number;
  moveBlend: number;
  hitFlashUntil: number;
  lastShotAt: number;
  lastSeenAt: number;
  lastInputReceivedAt: number;
  lastInputSequence: number;
  lastProcessedInputSequence: number;
  inputMovement: THREE.Vector2;
  inputCrouching: boolean;
  inputInteracting: boolean;
  pendingJump: boolean;
  lastJumpSequence: number;
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

interface ShotDebugEvent {
  type: "local" | "shared-sent" | "shared-received" | "enemy";
  at: number;
  sourceId: string | null;
  distance: number | null;
}

interface DebugInputState {
  movementX: number;
  movementZ: number;
  crouching: boolean;
  jumpRequested: boolean;
}

interface LocalInputHistoryEntry {
  sequence: number;
  tick: number;
  movement: THREE.Vector2;
  crouching: boolean;
}

interface LocalReplayDeltaEntry {
  sequence: number;
  recordedAt: number;
  delta: THREE.Vector3;
}

interface PendingShotClaim {
  claimId: number;
  submittedAt: number;
  targetId?: string;
}

interface DebugShotClaimOverride {
  tick?: number;
  origin?: { x: number; y: number; z: number };
  direction?: { x: number; y: number; z: number };
  ammoInClip?: number;
  reserveAmmo?: number;
  reloadSequence?: number;
  spreadIndex?: number;
  inputSequence?: number;
  weaponId?: string;
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
  private readonly tempAudioOffset = new THREE.Vector3();
  private readonly tempWorldForward = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
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
  private readonly localInputHistory: LocalInputHistoryEntry[] = [];
  private readonly localReplayDeltas: LocalReplayDeltaEntry[] = [];
  private readonly rewindBuffer = new ShotRewindBuffer();
  private readonly remoteWeaponStates = new Map<string, SharedWeaponState>();
  private readonly pendingShotClaims = new Map<number, PendingShotClaim>();
  private readonly recentShotResults: RoomShotResultEvent[] = [];
  private botDifficulty: BotDifficulty;

  private sharedRoom?: MatchRoomConnection;
  private activeMode: MatchMode = "local";
  private sharedRole?: MatchRoomRole;
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
  private localShotSequence = 0;
  private lastLocalShotAt = Number.NEGATIVE_INFINITY;
  private lastSharedShotSentAt = Number.NEGATIVE_INFINITY;
  private lastRoomShotReceivedAt = Number.NEGATIVE_INFINITY;
  private reloadSequence = 0;
  private spreadIndex = 0;
  private nextShotClaimId = 1;
  private lastShotClaim?: RoomShotClaim;
  private lastShotResult?: RoomShotResultEvent;
  private readonly shotDebugEvents: ShotDebugEvent[] = [];
  private readonly enemyContactQueue: PendingEnemyContact[] = [];
  private nextShotAt = 0;
  private reloadEndsAt = 0;
  private playerDead = false;
  private recoil = 0;
  private muzzleFlashUntil = 0;
  private hitIndicatorUntil = 0;
  private damageFlashUntil = 0;
  private feedMessage?: FeedMessage;
  private fullscreenNotice?: FeedMessage;
  private fallbackLookEnabled = false;
  private debugInputState?: DebugInputState;
  private debugPauseInputTicks = false;
  private lastInputSentAt = 0;
  private lastActiveInputAt = 0;
  private lastSentInputSequence = 0;
  private nextInputSequence = 1;
  private lastInputSignature = "";
  private lastAcknowledgedInputSequence = 0;
  private authoritativePosition?: THREE.Vector3;
  private nextHostSnapshotId = 1;
  private lastHostSnapshotId = 0;
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
  private qaAllowEnemyObjectiveActions = false;
  private readonly hostageActors = new Map<string, HostageActor>();
  private readonly lastPlayerNoisePosition = new THREE.Vector3();
  private lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: MapDefinition,
    private readonly options: LocalMatchOptions,
  ) {
    this.playerIdentity = options.sharedRoom?.identity ?? createRoomIdentity();
    this.roomId = options.sharedRoom?.roomId ?? buildRoomId(map.id);
    this.localTeamPreference = options.teamPreference;
    const initialNetworkParticipant = options.sharedRoom?.participantsSnapshot.find(
      (participant) => participant.id === this.playerIdentity.id,
    );
    const initialNetworkTeam =
      initialNetworkParticipant && initialNetworkParticipant.team !== "observer"
        ? initialNetworkParticipant.team
        : undefined;
    this.localTeamId =
      initialNetworkTeam ?? resolveTeamPreference(options.teamPreference, []);
    this.enemyTeamId = opposingTeam(this.localTeamId);
    this.botDifficulty = options.botDifficulty;
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

  async toggleViewportFullscreen(): Promise<boolean> {
    const target = this.fullscreenTarget();
    if (!target || !this.fullscreenAvailable()) {
      this.pushFullscreenNotice("Viewport fullscreen is unavailable in this browser.");
      return false;
    }

    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
        return true;
      }

      if (document.fullscreenElement) {
        this.pushFullscreenNotice("Exit the current fullscreen view before changing viewport.");
        return false;
      }

      await target.requestFullscreen({ navigationUI: "hide" });
      return true;
    } catch {
      this.pushFullscreenNotice("Viewport fullscreen request was denied.");
      return false;
    }
  }

  debugSnapshot(): Record<string, unknown> {
    const fullscreenTarget = this.fullscreenTarget();
    const difficultyTuning = this.botTuning();

    return {
      mapId: this.map.id,
      mapName: this.map.name,
      requestedMode: this.options.mode,
      activeMode: this.activeMode,
      sharedRole: this.sharedRole ?? null,
      lastHostSnapshotId: this.lastHostSnapshotId,
      botDifficulty: this.botDifficulty,
      roomId: this.activeMode === "shared" ? this.roomId : null,
      scoreboardVisible: this.scoreboardVisible,
      fullscreen: {
        active: document.fullscreenElement === fullscreenTarget,
        available: this.fullscreenAvailable(),
        targetIsViewportShell: fullscreenTarget?.matches("[data-world-shell]") ?? false,
        targetTag: fullscreenTarget?.tagName.toLowerCase() ?? null,
        viewportWidth: Math.round(this.host.clientWidth),
        viewportHeight: Math.round(this.host.clientHeight),
        canvasClientWidth: Math.round(this.renderer.domElement.clientWidth),
        canvasClientHeight: Math.round(this.renderer.domElement.clientHeight),
        rendererWidth: this.renderer.domElement.width,
        rendererHeight: this.renderer.domElement.height,
      },
      weaponView: this.weaponViewSnapshot(),
      audio: this.audio.debugSnapshot(),
      audioState: this.audio.debugState(),
      roomConnection: this.sharedRoom?.debugSnapshot() ?? null,
      shots: this.shotDebugSnapshot(),
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
      localPlayer: {
        id: this.playerIdentity.id,
        name: this.playerIdentity.name,
        teamId: this.localTeamId,
        teamName: getTeamDefinition(this.localTeamId).name,
        health: this.playerHealth,
        ammoInClip: this.ammoInClip,
        reserveAmmo: this.reserveAmmo,
        reloadSequence: this.reloadSequence,
        spreadIndex: this.spreadIndex,
        dead: this.playerDead,
        pointerCaptured: this.inputCaptured(),
        grounded: this.playerGrounded,
        crouching: this.playerCrouching,
        speed: Number(this.playerSpeed.toFixed(2)),
        lastSentInputSequence: this.lastSentInputSequence,
        lastAcknowledgedInputSequence: this.lastAcknowledgedInputSequence,
        pendingInputCount: this.localInputHistory.length,
        pendingReplayDeltaCount: this.localReplayDeltas.length,
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
          standingBodyHeight: Number(STANDING_BODY_HEIGHT.toFixed(2)),
          crouchBodyHeight: Number(CROUCH_BODY_HEIGHT.toFixed(2)),
          radius: Number(PLAYER_RADIUS.toFixed(2)),
          walkSpeed: Number(PLAYER_WALK_SPEED.toFixed(2)),
          crouchMultiplier: Number(PLAYER_CROUCH_MULTIPLIER.toFixed(2)),
          crouchSpeed: Number((PLAYER_WALK_SPEED * PLAYER_CROUCH_MULTIPLIER).toFixed(2)),
          airControl: Number(PLAYER_AIR_CONTROL.toFixed(2)),
          gravity: Number(PLAYER_GRAVITY.toFixed(2)),
          jumpVelocity: Number(PLAYER_JUMP_VELOCITY.toFixed(2)),
        },
        botMovement: {
          standingEyeHeight: Number(STANDING_EYE_HEIGHT.toFixed(2)),
          crouchEyeHeight: Number(CROUCH_EYE_HEIGHT.toFixed(2)),
          standingBodyHeight: Number(STANDING_BODY_HEIGHT.toFixed(2)),
          crouchBodyHeight: Number(CROUCH_BODY_HEIGHT.toFixed(2)),
          radius: Number(PLAYER_RADIUS.toFixed(2)),
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
          enemyDamage: ENEMY_DAMAGE,
        },
        round: {
          briefingSeconds: Number(ROUND_DURATIONS.briefing.toFixed(1)),
          activeSeconds: Number(ROUND_DURATIONS.active.toFixed(1)),
          resolutionSeconds: Number(ROUND_DURATIONS.resolution.toFixed(1)),
        },
        ai: {
          botDifficulty: this.botDifficulty,
          fireInterval: Number(ENEMY_FIRE_INTERVAL.toFixed(2)),
          engageDistance: Number(ENEMY_ENGAGE_DISTANCE.toFixed(1)),
          investigationWindow: Number(difficultyTuning.investigationSeconds.toFixed(1)),
          pursuitWindow: Number(difficultyTuning.pursuitSeconds.toFixed(1)),
          repositionWindow: Number(difficultyTuning.postContactRepositionSeconds.toFixed(1)),
          communicationDelay: Number(difficultyTuning.communicationDelaySeconds.toFixed(2)),
          communicationMemory: Number(difficultyTuning.communicationMemorySeconds.toFixed(2)),
          reactionBias: Number(difficultyTuning.reactionBiasSeconds.toFixed(2)),
          hitChanceBias: Number(difficultyTuning.hitChanceBias.toFixed(2)),
          spreadMultiplier: Number(difficultyTuning.spreadMultiplier.toFixed(2)),
          fireIntervalMultiplier: Number(difficultyTuning.fireIntervalMultiplier.toFixed(2)),
          burstMinShots: difficultyTuning.burstMinShots,
          burstMaxShots: difficultyTuning.burstMaxShots,
          burstCooldown: Number(difficultyTuning.burstCooldownSeconds.toFixed(2)),
          behaviorHold: Number(difficultyTuning.behaviorHoldSeconds.toFixed(2)),
          stuckSeconds: Number(difficultyTuning.stuckSeconds.toFixed(2)),
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
        teamId: enemy.teamId,
        alive: enemy.alive,
        health: enemy.health,
        position: this.toPoint(enemy.avatar.group.position),
        posture: this.combatantPostureSnapshot(enemy.avatar.group, enemy.alive),
        visual: this.combatantVisualSnapshot(enemy.avatar),
        movement: {
          crouchBlend: Number(enemy.movementState.crouchBlend.toFixed(3)),
          verticalVelocity: Number(enemy.movementState.verticalVelocity.toFixed(3)),
          heightOffset: Number(enemy.movementState.heightOffset.toFixed(3)),
          grounded: enemy.movementState.grounded,
          airborne: !enemy.movementState.grounded,
          eyeHeight: Number(this.enemyEyeHeight(enemy).toFixed(3)),
          bodyHeight: Number(this.enemyBodyHeight(enemy).toFixed(3)),
          speed: Number(enemy.speed.toFixed(2)),
        },
        look: this.toPoint(enemy.lookDirection),
        aimPitch: Number(this.aimPitchFromLook(enemy.lookDirection).toFixed(4)),
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
          lastSharedContactAgo:
            enemy.ai.lastSharedContactAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastSharedContactAt).toFixed(2))
              : null,
          lastDamagedAgo:
            enemy.ai.lastDamagedAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastDamagedAt).toFixed(2))
              : null,
          lastLostSightAgo:
            enemy.ai.lastLostSightAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastLostSightAt).toFixed(2))
              : null,
          behaviorAge: Number((this.gameNow() - enemy.ai.behaviorEnteredAt).toFixed(2)),
          behaviorLockRemaining: Number(
            Math.max(0, enemy.ai.behaviorHoldUntil - this.gameNow()).toFixed(2),
          ),
          burstShotsRemaining: enemy.ai.burstShotsRemaining,
          burstCooldownRemaining: Number(
            Math.max(0, enemy.ai.burstCooldownUntil - this.gameNow()).toFixed(2),
          ),
          lastRecoveryReason: enemy.ai.lastRecoveryReason,
          recoveryCount: enemy.ai.recoveryCount,
          lastJumpReason: enemy.ai.lastJumpReason,
          jumpCount: enemy.ai.jumpCount,
          lastJumpAgo:
            enemy.ai.lastJumpAt > Number.NEGATIVE_INFINITY
              ? Number((this.gameNow() - enemy.ai.lastJumpAt).toFixed(2))
              : null,
          forcedTargetLabel:
            enemy.ai.forcedUntil > this.gameNow() ? enemy.ai.forcedTargetLabel : null,
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
        aim: this.combatantAimSnapshot(enemy.avatar, enemy.lookDirection),
      })),
      remotePlayers: [...this.remoteActors.values()].map((actor) => ({
        id: actor.id,
        name: actor.name,
        teamId: actor.teamId,
        status: actor.status,
        health: actor.health,
        lastInputSequence: actor.lastInputSequence,
        lastProcessedInputSequence: actor.lastProcessedInputSequence,
        lastInputReceivedAt: actor.lastInputReceivedAt,
        inputMovement: {
          x: Number(actor.inputMovement.x.toFixed(2)),
          z: Number(actor.inputMovement.y.toFixed(2)),
        },
        inputCrouching: actor.inputCrouching,
        position: this.toPoint(actor.displayPosition),
        posture: this.combatantPostureSnapshot(actor.avatar.group, actor.status === "alive"),
        visual: this.combatantVisualSnapshot(actor.avatar),
        movement: {
          crouchBlend: Number(actor.movementState.crouchBlend.toFixed(3)),
          verticalVelocity: Number(actor.movementState.verticalVelocity.toFixed(3)),
          heightOffset: Number(actor.movementState.heightOffset.toFixed(3)),
          grounded: actor.movementState.grounded,
          airborne: !actor.movementState.grounded,
          eyeHeight: Number(currentEyeHeight(actor.movementState).toFixed(3)),
          bodyHeight: Number(currentBodyHeight(actor.movementState).toFixed(3)),
        },
        look: this.toPoint(actor.lookDirection),
        aimPitch: Number(actor.aimPitch.toFixed(4)),
        recoil: Number(actor.recoil.toFixed(3)),
        lastShotAgo:
          actor.lastShotAt > Number.NEGATIVE_INFINITY
            ? Number((this.gameNow() - actor.lastShotAt).toFixed(2))
            : null,
        aim: this.combatantAimSnapshot(actor.avatar, actor.lookDirection),
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
    this.publishHostSnapshot(true);
    this.emitSnapshot();
  }

  debugStageSharedRemotePose(peerId: string, x: number, y: number, z: number, yaw = 0): boolean {
    if (this.activeMode !== "shared" || this.sharedRole !== "host") {
      return false;
    }

    const actor = this.remoteActors.get(peerId);
    if (!actor) {
      return false;
    }

    const eyeHeight = currentEyeHeight(actor.movementState);
    const feetY = Math.max(0, y - eyeHeight);
    actor.targetPosition.set(x, feetY, z);
    actor.displayPosition.copy(actor.targetPosition);
    actor.avatar.group.position.copy(actor.targetPosition);
    actor.avatar.group.rotation.set(0, yaw, 0);
    actor.movementState.verticalVelocity = 0;
    actor.movementState.heightOffset = feetY;
    actor.movementState.grounded = feetY <= 0.05;
    actor.inputMovement.set(0, 0);
    actor.lastSeenAt = Date.now();
    actor.lastInputReceivedAt = Date.now();
    actor.lookDirection.set(Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    this.syncRemoteActorAim(actor, this.gameNow());
    this.publishHostSnapshot(true);
    this.emitSnapshot();
    return true;
  }

  debugStartSharedRemoteObjectiveAction(peerId: string): boolean {
    if (this.activeMode !== "shared" || this.sharedRole !== "host") {
      return false;
    }

    const actor = this.remoteActors.get(peerId);
    if (!actor) {
      return false;
    }

    const beforeBombPhase = this.bombState?.phase;
    const beforeHostagePhase = this.hostageState?.phase;
    actor.inputInteracting = true;
    actor.lastInputReceivedAt = Date.now();
    const now = this.roundNow();
    if (this.bombState?.phase === "planted" || this.bombState?.phase === "carried") {
      actor.targetPosition.set(
        this.bombState.site.position[0],
        0,
        this.bombState.site.position[2],
      );
      actor.displayPosition.copy(actor.targetPosition);
      actor.avatar.group.position.copy(actor.targetPosition);
    } else if (this.hostageState?.phase === "awaiting-rescue") {
      actor.targetPosition.set(
        this.hostageState.cluster.position[0],
        0,
        this.hostageState.cluster.position[2],
      );
      actor.displayPosition.copy(actor.targetPosition);
      actor.avatar.group.position.copy(actor.targetPosition);
    }
    this.tryStartRemoteObjectiveAction(actor, now);
    if (this.bombState?.actingCombatantId === actor.id) {
      if (this.bombState.phase === "planting") {
        this.bombState = { ...this.bombState, plantEndsAt: now + 0.25, updatedAt: now };
      } else if (this.bombState.phase === "defusing") {
        this.bombState = { ...this.bombState, defuseEndsAt: now + 0.25, updatedAt: now };
      }
    }
    if (this.hostageState?.actingCombatantId === actor.id) {
      if (this.hostageState.phase === "securing") {
        this.hostageState = { ...this.hostageState, secureEndsAt: now + 0.25, updatedAt: now };
      } else if (this.hostageState.phase === "extracting") {
        this.hostageState = { ...this.hostageState, extractEndsAt: now + 0.25, updatedAt: now };
      }
    }
    this.emitSnapshot();
    return this.bombState?.phase !== beforeBombPhase || this.hostageState?.phase !== beforeHostagePhase;
  }

  debugCompleteSharedRemoteObjectiveAction(peerId: string): boolean {
    if (this.activeMode !== "shared" || this.sharedRole !== "host") {
      return false;
    }

    const now = this.roundNow();
    if (
      this.roundState.phase === "resolution" &&
      this.roundState.resolutionLabel.toLowerCase().includes("disarmed")
    ) {
      return true;
    }

    if (this.bombState?.phase === "defusing" && this.bombState.actingCombatantId === peerId) {
      const defuserName = this.bombState.actingCombatantName ?? "Operator";
      this.applyRoundState(
        resolveRoundState(
          this.roundState,
          this.bombState.defendingTeam,
          `${defuserName} disarmed ${this.bombState.site.label}.`,
          now,
        ),
      );
      this.emitSnapshot();
      return true;
    }

    if (this.hostageState?.phase === "securing" && this.hostageState.actingCombatantId === peerId) {
      this.completeHostageSecure(now);
      this.emitSnapshot();
      return true;
    }

    if (this.hostageState?.phase === "escorting" && this.hostageState.rescuerId === peerId) {
      return true;
    }

    if (this.hostageState?.phase === "extracting" && this.hostageState.rescuerId === peerId) {
      const rescuerName = this.hostageState.rescuerName ?? "Cobalt Reach";
      this.applyRoundState(
        resolveRoundState(
          this.roundState,
          this.hostageState.attackingTeam,
          `${rescuerName} extracted ${this.hostageState.cluster.label}.`,
          now,
        ),
      );
      this.emitSnapshot();
      return true;
    }

    return false;
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
    this.publishHostSnapshot(true);
    this.emitSnapshot();
  }

  debugStageSharedDuel(slot: 0 | 1, aimOffsetY = 0):
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
    const targetY = eyeHeight + aimOffsetY;
    this.debugSetView(self.x, eyeHeight, self.z, target.x, targetY, target.z);

    return {
      self: this.toPoint(self, eyeHeight),
      target: this.toPoint(target, targetY),
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

    if (this.roundState.phase === "briefing") {
      this.applyRoundState(forceRoundActive(this.roundState, this.roundNow()));
    }

    const pair = this.findDebugPair(kind === "clear");
    if (!pair) {
      return null;
    }

    const hostPosition = pair[0];
    const guestPosition = pair[1];
    const eyeHeight = currentEyeHeight(this.movementState);
    this.debugSetView(
      hostPosition.x,
      eyeHeight,
      hostPosition.z,
      guestPosition.x,
      eyeHeight,
      guestPosition.z,
    );

    guestActor.movementState.verticalVelocity = 0;
    guestActor.movementState.heightOffset = 0;
    guestActor.movementState.grounded = true;
    guestActor.movementState.crouchBlend = 0;
    guestActor.targetPosition.copy(guestPosition);
    guestActor.displayPosition.copy(guestPosition);
    guestActor.avatar.group.position.copy(guestPosition);
    const guestLook = hostPosition.clone().sub(guestPosition).setY(0);
    if (guestLook.lengthSq() > 0.001) {
      guestLook.normalize();
      guestActor.forward.copy(guestLook);
      guestActor.lookDirection.copy(guestLook);
      guestActor.aimPitch = 0;
    }
    guestActor.lastSeenAt = Date.now();
    guestActor.lastInputReceivedAt = Date.now();
    this.recordSharedCombatFrame(Date.now());
    this.publishHostSnapshot(true);
    this.emitSnapshot();

    return {
      host: this.toPoint(hostPosition, eyeHeight),
      guest: this.toPoint(guestPosition, eyeHeight),
      guestId: guestActor.id,
    };
  }

  debugFire(): void {
    if (this.roundState.phase === "briefing") {
      this.applyRoundState(forceRoundActive(this.roundState, this.roundNow()));
    }
    this.fire(this.gameNow());
    this.emitSnapshot();
  }

  debugSubmitShotClaim(overrides: DebugShotClaimOverride = {}): boolean {
    if (this.activeMode !== "shared" || this.sharedRole !== "guest" || !this.sharedRoom) {
      return false;
    }

    const now = this.gameNow();
    if (this.playerDead || this.roundState.phase !== "active" || this.reloadEndsAt > now) {
      return false;
    }

    if (this.ammoInClip <= 0) {
      this.tryReload();
      return false;
    }

    this.scene.updateMatrixWorld(true);
    this.attackDirection.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.raycaster.set(this.camera.position, this.attackDirection);
    const environmentIntersections = this.raycaster.intersectObjects(
      this.environmentRaycastMeshes,
      false,
    );
    const environmentDistance = environmentIntersections[0]?.distance ?? Number.POSITIVE_INFINITY;
    const predictedTarget = this.findRemoteShotTarget(environmentDistance);
    const claim = this.buildShotClaim(Date.now(), overrides);
    if (!claim) {
      return false;
    }

    this.applyLocalShotEffects(now);
    this.sendGuestShotClaim(claim, predictedTarget, now);
    this.emitSnapshot();
    return true;
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
    if (enabled) {
      this.qaAllowEnemyObjectiveActions = false;
    }
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
          this.sendGuestObjectiveIntentTick();
          this.emitSnapshot();
          return true;
        }

        if (
          this.bombState.phase === "planted" &&
          this.localTeamId === this.bombState.defendingTeam
        ) {
          this.interactHeld = true;
          this.startBombDefuse(this.roundNow());
          this.sendGuestObjectiveIntentTick();
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
      this.sendGuestObjectiveIntentTick();
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

  debugSetInputState(
    movementX: number,
    movementZ: number,
    crouching = false,
    jumpRequested = false,
  ): void {
    this.debugInputState = {
      movementX,
      movementZ,
      crouching,
      jumpRequested,
    };
  }

  debugSetInputTickPaused(paused: boolean): void {
    this.debugPauseInputTicks = paused;
  }

  private sendGuestObjectiveIntentTick(): void {
    if (this.sharedRole !== "guest" || !this.sharedRoom || this.debugPauseInputTicks) {
      return;
    }

    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.lastInputSignature = "";
    this.lastInputSentAt = 0;
    this.sendGuestInputTickPayload(
      Date.now(),
      this.gameNow(),
      0,
      0,
      this.playerCrouching,
      false,
      true,
    );
  }

  debugSendInputTick(
    movementX: number,
    movementZ: number,
    crouching = false,
    jumpRequested = false,
  ): boolean {
    if (this.sharedRole !== "guest" || !this.sharedRoom || this.debugPauseInputTicks) {
      return false;
    }

    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.lastInputSignature = "";
    this.lastInputSentAt = 0;

    return this.sendGuestInputTickPayload(
      Date.now(),
      this.gameNow(),
      movementX,
      movementZ,
      crouching,
      jumpRequested,
      false,
    );
  }

  debugClearInputState(): void {
    this.debugInputState = undefined;
  }

  setClassicCrouchAlias(enabled: boolean): void {
    this.classicCrouchAlias = enabled;

    if (!enabled) {
      this.movementKeys.delete("ControlLeft");
      this.movementKeys.delete("ControlRight");
    }

    this.emitSnapshot();
  }

  setBotDifficulty(difficulty: BotDifficulty): void {
    this.botDifficulty = difficulty;
    this.emitSnapshot();
  }

  private botTuning(): BotDifficultyTuning {
    return botDifficultyTuning(this.botDifficulty);
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

  debugRequestEnemyJump(combatantId: string): boolean {
    if (this.activeMode !== "local") {
      return false;
    }

    const enemy = this.enemies.find((entry) => entry.id === combatantId && entry.alive);
    if (!enemy) {
      return false;
    }

    enemy.qaJumpRequested = true;
    this.emitSnapshot();
    return true;
  }

  debugEnemyMovementSample(combatantId: string):
    | {
        standing: { distance: number; speed: number; eyeHeight: number; bodyHeight: number };
        crouched: { distance: number; speed: number; eyeHeight: number; bodyHeight: number };
        live: {
          crouchBlend: number;
          grounded: boolean;
          eyeHeight: number;
          bodyHeight: number;
          speed: number;
        };
        jump: {
          groundedStart: boolean;
          airborneObserved: boolean;
          peakFeetY: number;
          peakEyeY: number;
          landedFeetY: number;
          landedEyeY: number;
          landed: boolean;
          airborneSeconds: number;
        };
      }
    | null {
    const enemy = this.enemies.find((entry) => entry.id === combatantId && entry.alive);
    if (!enemy) {
      return null;
    }

    const sampleStride = (crouching: boolean) => {
      const headings = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
      let bestDistance = 0;

      for (const heading of headings) {
        const sampleState = createMovementState();
        sampleState.crouchBlend = crouching ? 1 : 0;
        const samplePosition = enemy.avatar.group.position.clone().setY(0);
        const sampleOrientation = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading)
          .multiply(COMBATANT_MOVEMENT_OFFSET);
        const tempForward = new THREE.Vector3();
        const tempRight = new THREE.Vector3();
        const tempDelta = new THREE.Vector3();
        const startX = samplePosition.x;
        const startZ = samplePosition.z;
        const frames = 36;

        for (let frame = 0; frame < frames; frame += 1) {
          updateSharedMovement(
            sampleState,
            samplePosition,
            sampleOrientation,
            "feet",
            this.collisionWorld,
            1 / 60,
            frame / 60,
            {
              enabled: true,
              moveX: 0,
              moveZ: 1,
              crouching,
              jumpRequested: false,
            },
            tempForward,
            tempRight,
            tempDelta,
            PLAYER_RADIUS,
          );
        }

        bestDistance = Math.max(
          bestDistance,
          Math.hypot(samplePosition.x - startX, samplePosition.z - startZ),
        );
      }

      const seconds = 36 / 60;
      return {
        distance: Number(bestDistance.toFixed(3)),
        speed: Number((bestDistance / seconds).toFixed(3)),
        eyeHeight: Number((crouching ? CROUCH_EYE_HEIGHT : STANDING_EYE_HEIGHT).toFixed(3)),
        bodyHeight: Number((crouching ? CROUCH_BODY_HEIGHT : STANDING_BODY_HEIGHT).toFixed(3)),
      };
    };

    const jumpState = createMovementState();
    const jumpPosition = enemy.avatar.group.position.clone().setY(0);
    const jumpOrientation = enemy.avatar.group.quaternion.clone().multiply(COMBATANT_MOVEMENT_OFFSET);
    const tempForward = new THREE.Vector3();
    const tempRight = new THREE.Vector3();
    const tempDelta = new THREE.Vector3();
    const groundedStart = jumpState.grounded;
    let airborneObserved = false;
    let landed = false;
    let peakFeetY = jumpPosition.y;
    let peakEyeY = jumpPosition.y + currentEyeHeight(jumpState);
    let landedFeetY = jumpPosition.y;
    let landedEyeY = peakEyeY;
    let airborneFrames = 0;

    for (let frame = 0; frame < 180; frame += 1) {
      const result = updateSharedMovement(
        jumpState,
        jumpPosition,
        jumpOrientation,
        "feet",
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
        PLAYER_RADIUS,
      );

      peakFeetY = Math.max(peakFeetY, jumpPosition.y);
      peakEyeY = Math.max(peakEyeY, jumpPosition.y + result.eyeHeight);
      if (!result.grounded) {
        airborneObserved = true;
      }
      if (airborneObserved && !result.grounded) {
        airborneFrames = frame + 1;
      }
      if (airborneObserved && frame > 0 && result.grounded) {
        landed = true;
        landedFeetY = jumpPosition.y;
        landedEyeY = jumpPosition.y + result.eyeHeight;
        airborneFrames = frame + 1;
        break;
      }
    }

    return {
      standing: sampleStride(false),
      crouched: sampleStride(true),
      live: {
        crouchBlend: Number(enemy.movementState.crouchBlend.toFixed(3)),
        grounded: enemy.movementState.grounded,
        eyeHeight: Number(this.enemyEyeHeight(enemy).toFixed(3)),
        bodyHeight: Number(this.enemyBodyHeight(enemy).toFixed(3)),
        speed: Number(enemy.speed.toFixed(3)),
      },
      jump: {
        groundedStart,
        airborneObserved,
        peakFeetY: Number(peakFeetY.toFixed(3)),
        peakEyeY: Number(peakEyeY.toFixed(3)),
        landedFeetY: Number(landedFeetY.toFixed(3)),
        landedEyeY: Number(landedEyeY.toFixed(3)),
        landed,
        airborneSeconds: Number(((landed ? airborneFrames : 180) / 60).toFixed(3)),
      },
    };
  }

  debugAimAt(combatantId: string): boolean {
    const remote = this.remoteActors.get(combatantId);
    const enemy = this.enemies.find((entry) => entry.id === combatantId);
    const targetPosition = remote
      ? remote.displayPosition.clone().setY(1.45)
      : enemy
        ? enemy.avatar.group.position.clone().setY(this.enemyEyeHeight(enemy))
        : undefined;

    if (!targetPosition) {
      return false;
    }

    this.camera.lookAt(targetPosition.x, targetPosition.y, targetPosition.z);
    this.publishHostSnapshot(true);
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
    enemy.movementState.verticalVelocity = 0;
    enemy.movementState.heightOffset = 0;
    enemy.movementState.grounded = true;
    enemy.movementState.crouchBlend = 0;
    enemy.speed = 0;
    enemy.qaJumpRequested = false;
    this.faceCombatantAt(enemy.avatar.group, caseData.enemyPosition, caseData.blockedPlayerPosition);
    this.configureEnemyAi(enemy, this.enemies.indexOf(enemy));
    this.lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;
    this.lastPlayerNoisePosition.copy(caseData.blockedPlayerPosition);
    this.debugSetView(
      caseData.blockedPlayerPosition.x,
      currentEyeHeight(this.movementState),
      caseData.blockedPlayerPosition.z,
      caseData.enemyPosition.x,
      this.enemyEyeHeight(enemy),
      caseData.enemyPosition.z,
    );

    return {
      enemyId: enemy.id,
      enemyLabel: enemy.name,
      blockerName: caseData.blockerName,
      enemyPosition: this.toPoint(caseData.enemyPosition, this.enemyEyeHeight(enemy)),
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

  debugStageAiCommunicationCase():
    | {
        observerEnemyId: string;
        receiverEnemyId: string;
        playerPosition: { x: number; y: number; z: number };
        observerPosition: { x: number; y: number; z: number };
        receiverPosition: { x: number; y: number; z: number };
        blockerName: string;
      }
    | null {
    if (this.activeMode !== "local") {
      return null;
    }

    const caseData = this.findAiCommunicationCase();
    if (!caseData) {
      return null;
    }

    const observer = this.objectiveEnemyById(caseData.observerEnemyId);
    const receiver = this.objectiveEnemyById(caseData.receiverEnemyId);
    if (!observer || !receiver) {
      return null;
    }

    for (const enemy of [observer, receiver]) {
      enemy.movementState.verticalVelocity = 0;
      enemy.movementState.heightOffset = 0;
      enemy.movementState.grounded = true;
      enemy.movementState.crouchBlend = 0;
      enemy.speed = 0;
      enemy.qaJumpRequested = false;
      this.configureEnemyAi(enemy, this.enemies.indexOf(enemy));
    }

    observer.avatar.group.position.copy(caseData.observerPosition);
    receiver.avatar.group.position.copy(caseData.receiverPosition);
    observer.ai.lastProgressPosition.copy(caseData.observerPosition);
    receiver.ai.lastProgressPosition.copy(caseData.receiverPosition);
    this.enemyContactQueue.length = 0;
    this.lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;
    this.lastPlayerNoisePosition.copy(caseData.playerPosition);
    this.debugSetView(
      caseData.playerPosition.x,
      currentEyeHeight(this.movementState),
      caseData.playerPosition.z,
      caseData.observerPosition.x,
      this.enemyEyeHeight(observer),
      caseData.observerPosition.z,
    );

    return {
      observerEnemyId: observer.id,
      receiverEnemyId: receiver.id,
      playerPosition: this.toPoint(caseData.playerPosition, currentEyeHeight(this.movementState)),
      observerPosition: this.toPoint(caseData.observerPosition, this.enemyEyeHeight(observer)),
      receiverPosition: this.toPoint(caseData.receiverPosition, this.enemyEyeHeight(receiver)),
      blockerName: caseData.blockerName,
    };
  }

  debugStageAiRecoveryCase():
    | {
        enemyId: string;
        enemyLabel: string;
        blockerName: string;
        targetLabel: string;
        enemyPosition: { x: number; y: number; z: number };
        blockedTargetPosition: { x: number; y: number; z: number };
      }
    | null {
    if (this.activeMode !== "local") {
      return null;
    }

    const caseData = this.findAiSightlineCase();
    if (!caseData) {
      return null;
    }

    const enemy = this.objectiveEnemyById(caseData.enemyId);
    if (!enemy) {
      return null;
    }

    enemy.avatar.group.position.copy(caseData.enemyPosition);
    enemy.movementState.verticalVelocity = 0;
    enemy.movementState.heightOffset = 0;
    enemy.movementState.grounded = true;
    enemy.movementState.crouchBlend = 0;
    enemy.speed = 0;
    enemy.qaJumpRequested = false;
    this.configureEnemyAi(enemy, this.enemies.indexOf(enemy));
    enemy.ai.lastHeardAt = this.gameNow();
    enemy.ai.lastHeardPosition = caseData.blockedPlayerPosition.clone();
    enemy.ai.lastProgressAt = this.gameNow();
    enemy.ai.lastProgressPosition.copy(caseData.enemyPosition);
    this.setEnemyForcedDirective(
      enemy,
      this.gameNow(),
      "investigate",
      "standing",
      caseData.blockedPlayerPosition,
      caseData.blockedPlayerLabel,
      6,
    );
    this.enemyContactQueue.length = 0;
    this.lastPlayerNoiseAt = Number.NEGATIVE_INFINITY;
    this.lastPlayerNoisePosition.copy(caseData.blockedPlayerPosition);
    this.debugSetView(
      caseData.blockedPlayerPosition.x,
      currentEyeHeight(this.movementState),
      caseData.blockedPlayerPosition.z,
      caseData.enemyPosition.x,
      this.enemyEyeHeight(enemy),
      caseData.enemyPosition.z,
    );

    return {
      enemyId: enemy.id,
      enemyLabel: enemy.name,
      blockerName: caseData.blockerName,
      targetLabel: caseData.blockedPlayerLabel,
      enemyPosition: this.toPoint(caseData.enemyPosition, this.enemyEyeHeight(enemy)),
      blockedTargetPosition: this.toPoint(
        caseData.blockedPlayerPosition,
        currentEyeHeight(this.movementState),
      ),
    };
  }

  debugStageEnemyBombPlantCase():
    | {
        carrierEnemyId: string;
        siteLabel: string;
        sitePosition: { x: number; y: number; z: number };
      }
    | null {
    if (
      this.activeMode !== "local" ||
      !this.bombState ||
      this.bombState.phase !== "carried"
    ) {
      return null;
    }

    const carrier = this.objectiveEnemyById(this.bombState.carrierId);
    if (!carrier) {
      return null;
    }

    const sitePosition = new THREE.Vector3(
      this.bombState.site.position[0],
      0,
      this.bombState.site.position[2],
    );
    carrier.avatar.group.position.copy(sitePosition);
    carrier.movementState.verticalVelocity = 0;
    carrier.movementState.heightOffset = 0;
    carrier.movementState.grounded = true;
    carrier.movementState.crouchBlend = 0;
    carrier.speed = 0;
    this.configureEnemyAi(carrier, this.enemies.indexOf(carrier));
    carrier.ai.lastProgressPosition.copy(sitePosition);
    this.qaAllowEnemyObjectiveActions = true;
    this.setEnemyForcedDirective(
      carrier,
      this.gameNow(),
      "objective",
      "crouched",
      sitePosition,
      this.bombState.site.label,
      4,
    );
    const spawn = this.teamSpawnPositions[this.localTeamId];
    this.debugSetView(
      spawn.x,
      currentEyeHeight(this.movementState),
      spawn.z,
      sitePosition.x,
      currentEyeHeight(this.movementState),
      sitePosition.z,
    );

    return {
      carrierEnemyId: carrier.id,
      siteLabel: this.bombState.site.label,
      sitePosition: this.toPoint(sitePosition, 0),
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
      shooterSpeed: overrides?.shooterSpeed ?? enemy.speed,
      targetCrouching: overrides?.targetCrouching ?? this.playerCrouching,
      shooterCrouching: overrides?.shooterCrouching ?? enemy.movementState.crouchBlend > 0.5,
    }, this.botTuning());
  }

  private roundNow(): number {
    return Date.now() / 1000;
  }

  private gameNow(): number {
    return performance.now() / 1000;
  }

  private initializeSharedRoom(): MatchRoomConnection | undefined {
    if (this.options.mode !== "shared") {
      this.activeMode = "local";
      return undefined;
    }

    if (!this.options.sharedRoom) {
      this.activeMode = "local";
      this.sharedRoomFallbackReason =
        this.options.sharedRoomFallbackReason ??
        "no multiplayer room connection was configured.";
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
        this.emitSnapshot();
      },
      onInput: (event) => {
        if (this.sharedRole === "host") {
          this.handleSharedRoomInput(event);
          this.emitSnapshot();
        }
      },
      onShotClaim: (event) => {
        this.handleSharedShotClaim(event);
        this.emitSnapshot();
      },
      onShotResult: (event) => {
        this.handleSharedShotResult(event);
        this.emitSnapshot();
      },
      onSnapshot: (snapshot) => {
        if (this.sharedRole === "guest") {
          this.applyHostSnapshot(snapshot);
          this.emitSnapshot();
        }
      },
      onRoomClosed: (reason) => {
        this.options.onRoomEnded?.(reason);
      },
    });

    this.sharedRole = this.options.sharedRoom.role;
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
    this.reloadSequence = 0;
    this.spreadIndex = 0;
    this.pendingShotClaims.clear();
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
    this.enemyContactQueue.length = 0;
    this.qaAllowEnemyObjectiveActions = false;

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

    this.publishHostSnapshot(true);
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
      const avatar = createCombatantAvatar(this.enemyTeamId);
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
        movementState: createMovementState(),
        health: 100,
        alive: true,
        eliminations: 0,
        deaths: 0,
        nextFireAt: 0,
        waypointIndex: 0,
        waypoints: [],
        recoil: 0,
        moveBlend: 0,
        speed: 0,
        hitFlashUntil: 0,
        spawnPoint,
        lookDirection: new THREE.Vector3(0, 0, 1),
        qaJumpRequested: false,
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
          lastSharedContactAt: Number.NEGATIVE_INFINITY,
          lastDamagedAt: Number.NEGATIVE_INFINITY,
          lastLostSightAt: Number.NEGATIVE_INFINITY,
          lastVisibility: 0,
          canSeePlayer: false,
          blockedBy: null,
          repositionReason: null,
          lastRecoveryReason: null,
          recoveryCount: 0,
          lastJumpReason: null,
          jumpCount: 0,
          lastJumpAt: Number.NEGATIVE_INFINITY,
          behaviorEnteredAt: this.gameNow(),
          behaviorHoldUntil: this.gameNow(),
          burstShotsRemaining: 0,
          burstCooldownUntil: 0,
          lastProgressAt: this.gameNow(),
          lastProgressPosition: spawnPoint.clone(),
          forcedBehavior: null,
          forcedTargetPosition: null,
          forcedTargetLabel: null,
          forcedStance: null,
          forcedUntil: Number.NEGATIVE_INFINITY,
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
      enemy.speed = 0;
      enemy.hitFlashUntil = 0;
      enemy.spawnPoint = this.enemySpawnPoint(index);
      enemy.avatar.group.position.copy(enemy.spawnPoint);
      enemy.avatar.group.rotation.set(0, 0, 0);
      enemy.lookDirection.set(0, 0, 1);
      enemy.qaJumpRequested = false;
      enemy.movementState.verticalVelocity = 0;
      enemy.movementState.heightOffset = 0;
      enemy.movementState.grounded = true;
      enemy.movementState.crouchBlend = 0;
      enemy.movementState.spectatorUntil = 0;
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
    enemy.ai.lastSharedContactAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastDamagedAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastLostSightAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastVisibility = 0;
    enemy.ai.canSeePlayer = false;
    enemy.ai.blockedBy = null;
    enemy.ai.repositionReason = null;
    enemy.ai.lastRecoveryReason = null;
    enemy.ai.recoveryCount = 0;
    enemy.ai.lastJumpReason = null;
    enemy.ai.jumpCount = 0;
    enemy.ai.lastJumpAt = Number.NEGATIVE_INFINITY;
    enemy.ai.behaviorEnteredAt = this.gameNow();
    enemy.ai.behaviorHoldUntil = this.gameNow();
    enemy.ai.burstShotsRemaining = 0;
    enemy.ai.burstCooldownUntil = 0;
    enemy.ai.lastProgressAt = this.gameNow();
    enemy.ai.lastProgressPosition.copy(enemy.spawnPoint);
    enemy.ai.forcedBehavior = null;
    enemy.ai.forcedTargetPosition = null;
    enemy.ai.forcedTargetLabel = null;
    enemy.ai.forcedStance = null;
    enemy.ai.forcedUntil = Number.NEGATIVE_INFINITY;
    enemy.ai.shotsFired = 0;
    enemy.ai.shotHits = 0;
    enemy.ai.shotMisses = 0;
    enemy.ai.lastShotAt = Number.NEGATIVE_INFINITY;
    enemy.ai.lastShotOutcome = null;
    enemy.ai.lastShotProfile = null;
    enemy.ai.rngState =
      (((index + 1) * 0x9e3779b9) ^ (this.roundState.roundNumber * 2654435761)) >>> 0;
    enemy.qaJumpRequested = false;
  }

  private resetRemoteActorsForRound(): void {
    for (const actor of this.remoteActors.values()) {
      const spawn = this.teamSpawnPositions[actor.teamId];
      actor.health = 100;
      actor.status = "alive";
      actor.movementState.verticalVelocity = 0;
      actor.movementState.heightOffset = 0;
      actor.movementState.grounded = true;
      actor.movementState.crouchBlend = 0;
      actor.targetPosition.copy(spawn);
      actor.displayPosition.copy(spawn);
      actor.avatar.group.position.copy(spawn);
      actor.avatar.group.rotation.set(0, 0, 0);
      actor.hitFlashUntil = 0;
      actor.recoil = 0;
      actor.lastShotAt = Number.NEGATIVE_INFINITY;
      actor.lastInputSequence = 0;
      actor.lastProcessedInputSequence = 0;
      actor.inputMovement.set(0, 0);
      actor.inputCrouching = false;
      actor.inputInteracting = false;
      actor.pendingJump = false;
      actor.lastJumpSequence = 0;
      if (this.sharedRole === "host") {
        this.remoteWeaponStates.set(actor.id, createInitialWeaponState(CLIP_SIZE, RESERVE_AMMO));
      }
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

  private ensureRemoteActorFromParticipant(participant: ParticipantRecord): RemoteActor {
    if (participant.team === "observer") {
      throw new Error(`Observers are not supported in the live arena: ${participant.id}`);
    }

    if (this.sharedRole === "host" && !this.remoteWeaponStates.has(participant.id)) {
      this.remoteWeaponStates.set(participant.id, createInitialWeaponState(CLIP_SIZE, RESERVE_AMMO));
    }

    const existing = this.remoteActors.get(participant.id);
    if (existing && existing.teamId !== participant.team) {
      this.removeRemoteActor(participant.id);
    } else if (existing) {
      existing.name = participant.name;
      existing.accentColor = participant.accentColor;
      existing.teamId = participant.team;
      existing.teamPreference = participant.team;
      existing.joinedAt = participant.joinedAt;
      return existing;
    }

    const spawnPosition = this.teamSpawnPositions[participant.team];
    const avatar = createCombatantAvatar(participant.team, participant.accentColor);
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
      teamId: participant.team,
      teamPreference: participant.team,
      joinedAt: participant.joinedAt,
      avatar,
      movementState: createMovementState(),
      health: 100,
      eliminations: 0,
      deaths: 0,
      status: "alive",
      targetPosition: spawnPosition.clone(),
      displayPosition: spawnPosition.clone(),
      forward: new THREE.Vector3(0, 0, 1),
      lookDirection: new THREE.Vector3(0, 0, 1),
      aimPitch: 0,
      recoil: 0,
      moveBlend: 0,
      hitFlashUntil: 0,
      lastShotAt: Number.NEGATIVE_INFINITY,
      lastSeenAt: Date.now(),
      lastInputReceivedAt: Date.now(),
      lastInputSequence: 0,
      lastProcessedInputSequence: 0,
      inputMovement: new THREE.Vector2(),
      inputCrouching: false,
      inputInteracting: false,
      pendingJump: false,
      lastJumpSequence: 0,
    };
    this.syncRemoteActorAim(actor, this.gameNow());
    this.remoteActors.set(participant.id, actor);
    return actor;
  }

  private upsertRemoteActorFromSnapshot(
    presence: HostRoomSnapshot["roster"][number],
  ): void {
    if (presence.team === "observer") {
      this.removeRemoteActor(presence.id);
      return;
    }

    const actor = this.ensureRemoteActorFromParticipant({
      id: presence.id,
      name: presence.name,
      accentColor: presence.accentColor,
      team: presence.team,
      joinedAt: presence.joinedAt,
    });

    actor.health = presence.health;
    actor.eliminations = presence.eliminations;
    actor.deaths = presence.deaths;
    actor.status = presence.status;
    actor.lastSeenAt = presence.updatedAt;
    actor.lastInputReceivedAt = presence.updatedAt;
    actor.lastInputSequence = presence.lastProcessedInputSequence;
    actor.lastProcessedInputSequence = presence.lastProcessedInputSequence;

    this.applyRemoteSnapshotPose(actor, presence.position, presence.look);
    this.syncRemoteActorAim(actor, this.gameNow());
  }

  private applyRemoteSnapshotPose(
    actor: RemoteActor,
    position: HostRoomSnapshot["roster"][number]["position"],
    look: HostRoomSnapshot["roster"][number]["look"],
  ): void {
    const eyeY = position[1];
    const crouchBlend = THREE.MathUtils.clamp(
      (STANDING_EYE_HEIGHT - Math.min(eyeY, STANDING_EYE_HEIGHT)) /
        Math.max(0.001, STANDING_EYE_HEIGHT - CROUCH_EYE_HEIGHT),
      0,
      1,
    );
    actor.movementState.crouchBlend = crouchBlend;
    const baseEyeHeight = THREE.MathUtils.lerp(
      STANDING_EYE_HEIGHT,
      CROUCH_EYE_HEIGHT,
      crouchBlend,
    );
    actor.movementState.heightOffset = Math.max(0, eyeY - baseEyeHeight);
    actor.movementState.grounded = actor.movementState.heightOffset <= 0.01;
    actor.targetPosition.set(position[0], actor.movementState.heightOffset, position[2]);
    this.applyRemoteLook(actor, look);
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
    if (!participant || participant.team === "observer") {
      return;
    }

    const actor = this.ensureRemoteActorFromParticipant(participant);
    if (event.sequence <= actor.lastInputSequence) {
      return;
    }

    const [movementX, movementZ] = event.movement;
    const movementLength = Math.hypot(movementX, movementZ);
    if (
      Math.abs(movementX) > 1.01 ||
      Math.abs(movementZ) > 1.01 ||
      movementLength > Math.SQRT2 + 0.01
    ) {
      return;
    }

    actor.lastInputSequence = event.sequence;
    actor.lastProcessedInputSequence = event.sequence;
    actor.lastSeenAt = event.receivedAt;
    actor.lastInputReceivedAt = event.receivedAt;
    actor.inputMovement.set(movementX, movementZ);
    actor.inputCrouching = event.actions.includes("crouch");
    actor.inputInteracting = event.actions.includes("interact");
    if (event.actions.includes("jump") && event.sequence > actor.lastJumpSequence) {
      actor.pendingJump = true;
      actor.lastJumpSequence = event.sequence;
    }

    const weaponState = this.remoteWeaponStates.get(event.peerId);
    if (weaponState) {
      noteInputSequence(weaponState, event.sequence);
      syncWeaponState(weaponState, Date.now(), CLIP_SIZE);
      if (event.actions.includes("reload")) {
        startWeaponReload(weaponState, event.tick, CLIP_SIZE, RELOAD_DURATION_MS);
      }
    }

    this.applyRemoteLook(actor, event.look);
    if (actor.inputInteracting) {
      this.tryStartRemoteObjectiveAction(actor, this.roundNow());
    }
  }

  private applyHostSnapshot(snapshot: HostRoomSnapshot): void {
    if (snapshot.snapshotId <= this.lastHostSnapshotId) {
      return;
    }

    this.lastHostSnapshotId = snapshot.snapshotId;
    this.applyAuthoritativeObjectiveSnapshot(snapshot);
    this.applyAuthoritativeSharedRoundPhase(snapshot);
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

  private applyAuthoritativeSharedRoundPhase(snapshot: HostRoomSnapshot): void {
    if (this.sharedRole !== "guest") {
      return;
    }

    const now = this.roundNow();
    if (snapshot.roundPhase === "live" && this.roundState.phase === "briefing") {
      this.applyRoundState(forceRoundActive(this.roundState, now));
      return;
    }

    if (snapshot.roundPhase === "reset" && this.roundState.phase === "active") {
      const remoteRoundState = hydrateRoundState(
        this.map,
        snapshot.objective.state?.round as SerializedRoundState | null | undefined,
      );
      if (remoteRoundState && shouldAdoptRoundState(this.roundState, remoteRoundState)) {
        this.applyRoundState(remoteRoundState);
        return;
      }

      this.applyRoundState(
        resolveRoundState(
          this.roundState,
          null,
          snapshot.objective.detail || `${this.roundState.activeMission.missionLabel} reset.`,
          now,
        ),
      );
      return;
    }

    if (snapshot.roundPhase === "staging" && this.roundState.phase === "resolution") {
      this.applyRoundState(createBriefingRoundState(this.map, this.roundState.roundNumber + 1, now));
    }
  }

  private applyAuthoritativeObjectiveSnapshot(snapshot: HostRoomSnapshot): void {
    if (this.sharedRole !== "guest" || !snapshot.objective.state) {
      return;
    }

    const state = snapshot.objective.state;
    const remoteRoundState = hydrateRoundState(
      this.map,
      state.round as SerializedRoundState | null | undefined,
    );
    if (remoteRoundState && shouldAdoptRoundState(this.roundState, remoteRoundState)) {
      this.applyRoundState(remoteRoundState);
    }

    const mission = this.roundState.activeMission;
    const remoteBombState = hydrateBombRuntimeState(
      this.map,
      mission,
      state.bomb as SerializedBombRuntimeState | null | undefined,
    );
    if (shouldAdoptBombRuntimeState(this.bombState, remoteBombState)) {
      this.bombState = remoteBombState;
    }

    const remoteHostageState = hydrateHostageRuntimeState(
      this.map,
      mission,
      state.hostage as SerializedHostageRuntimeState | null | undefined,
    );
    if (shouldAdoptHostageRuntimeState(this.hostageState, remoteHostageState)) {
      this.hostageState = remoteHostageState;
      this.syncHostageActors();
    }
  }

  private applyAuthoritativeLocalState(
    presence: HostRoomSnapshot["roster"][number],
  ): void {
    const previousHealth = this.playerHealth;
    const wasDead = this.playerDead;
    const now = this.gameNow();
    const eyeY = presence.position[1];
    const crouchBlend = THREE.MathUtils.clamp(
      (STANDING_EYE_HEIGHT - Math.min(eyeY, STANDING_EYE_HEIGHT)) /
        Math.max(0.001, STANDING_EYE_HEIGHT - CROUCH_EYE_HEIGHT),
      0,
      1,
    );
    const authoritativeBaseEyeHeight = THREE.MathUtils.lerp(
      STANDING_EYE_HEIGHT,
      CROUCH_EYE_HEIGHT,
      crouchBlend,
    );
    const authoritativeHeightOffset = Math.max(0, eyeY - authoritativeBaseEyeHeight);

    this.playerHealth = presence.health;
    this.playerEliminations = presence.eliminations;
    this.playerDeaths = presence.deaths;
    this.playerDead = presence.status !== "alive";
    this.lastAcknowledgedInputSequence = Math.max(
      this.lastAcknowledgedInputSequence,
      presence.lastProcessedInputSequence,
    );
    this.pruneLocalPredictionHistory();

    if (!this.authoritativePosition) {
      this.authoritativePosition = new THREE.Vector3();
    }

    const correctionDistance = Math.hypot(
      presence.position[0] - this.camera.position.x,
      presence.position[2] - this.camera.position.z,
    );
    const heightError = Math.abs(eyeY - this.camera.position.y);
    const authoritativeGrounded = authoritativeHeightOffset <= 0.01;
    const shouldSnap =
      this.playerDead ||
      wasDead !== this.playerDead ||
      correctionDistance > LOCAL_RECONCILE_SNAP_DISTANCE ||
      heightError > 0.75 ||
      this.lastHostSnapshotId <= 1;

    this.movementState.crouchBlend = crouchBlend;
    this.movementState.heightOffset = authoritativeHeightOffset;
    this.movementState.grounded = authoritativeGrounded;
    if (authoritativeGrounded) {
      this.movementState.verticalVelocity = 0;
    }
    this.playerGrounded = this.movementState.grounded;
    this.playerCrouching = crouchBlend > 0.5;
    this.playerEyeHeight = currentEyeHeight(this.movementState);

    if (shouldSnap) {
      this.resetLocalPredictionHistory(presence.lastProcessedInputSequence);
      this.camera.position.set(presence.position[0], eyeY, presence.position[2]);
      this.authoritativePosition.set(presence.position[0], eyeY, presence.position[2]);
    } else {
      this.authoritativePosition.copy(
        this.buildReconciledAuthoritativePosition(presence.position),
      );
      if (authoritativeGrounded) {
        this.camera.position.y = eyeY;
        this.authoritativePosition.y = eyeY;
      }
    }

    if (presence.health < previousHealth && !this.playerDead) {
      this.damageFlashUntil = now + DAMAGE_FLASH_DURATION;
      this.audio.playerHit();
    }

    if (!wasDead && this.playerDead) {
      this.resetLocalPredictionHistory(presence.lastProcessedInputSequence);
      this.audio.death();
      this.weaponRig.setVisible(false);
    } else if (wasDead && !this.playerDead) {
      this.resetLocalPredictionHistory(presence.lastProcessedInputSequence);
      this.audio.respawn();
      this.camera.position.set(presence.position[0], eyeY, presence.position[2]);
      this.weaponRig.setVisible(true);
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
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    document.addEventListener("fullscreenerror", this.handleFullscreenError);
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
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    document.removeEventListener("fullscreenerror", this.handleFullscreenError);
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

  private readonly handleFullscreenChange = (): void => {
    this.handleResize();
    requestAnimationFrame(() => {
      this.handleResize();
      this.emitSnapshot();
    });
    this.emitSnapshot();
  };

  private readonly handleFullscreenError = (): void => {
    this.pushFullscreenNotice("Viewport fullscreen request was denied.");
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.preventDefaultWhenInputCaptured(event);
    if (this.inputCaptured()) {
      this.audio.prime();
    }

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
    if (
      event.code === "Escape" ||
      !this.inputCaptured() ||
      this.isEditableEventTarget(event.target)
    ) {
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

    const frameNowMs = Date.now();
    const delta = Math.min(0.04, this.clock.getDelta());
    const now = this.gameNow();
    const roundNow = this.roundNow();

    if (this.activeMode === "shared" && this.sharedRole === "guest") {
      this.sendLocalInputTick(now);
    }

    this.updatePlayer(delta, now);
    if (this.activeMode === "shared") {
      if (this.sharedRole === "host") {
        this.updateAuthoritativeRemoteActors(delta, now);
        this.syncRemoteWeaponStates(frameNowMs);
        this.recordSharedCombatFrame(frameNowMs);
      }
      this.updateRemoteActors(delta, now);
    } else {
      this.updateEnemies(delta, now);
    }

    this.updateBombObjectiveState(roundNow);
    this.updateHostageObjectiveState(delta, roundNow);

    if (!(this.activeMode === "shared" && this.sharedRole === "guest")) {
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
    }

    if (this.activeMode === "shared" && this.sharedRole === "guest") {
      this.reconcileAuthoritativePosition(delta);
    }

    this.publishHostSnapshot();
    this.sharedRoom?.tick();

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

    this.publishHostSnapshot(true);
  }

  private currentMovementInputState(): {
    moveX: number;
    moveZ: number;
    crouching: boolean;
    jumpRequested: boolean;
    active: boolean;
  } {
    if (this.debugInputState) {
      const length = Math.hypot(this.debugInputState.movementX, this.debugInputState.movementZ);
      return {
        moveX: this.debugInputState.movementX,
        moveZ: this.debugInputState.movementZ,
        crouching: this.debugInputState.crouching,
        jumpRequested: this.debugInputState.jumpRequested,
        active: length > 0.01,
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
      crouching: this.crouchHeld(),
      jumpRequested: this.jumpRequested,
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

    const movementInput = this.currentMovementInputState();

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
        moveX: movementInput.moveX,
        moveZ: movementInput.moveZ,
        crouching: movementInput.crouching,
        jumpRequested: movementInput.jumpRequested,
      },
      this.tempForward,
      this.tempRight,
      this.tempDelta,
    );

    this.jumpRequested = false;
    if (this.debugInputState) {
      this.debugInputState.jumpRequested = false;
    }
    this.playerMoveBlend = movement.moveBlend;
    this.playerGrounded = movement.grounded;
    this.playerCrouching = movement.crouching;
    this.playerEyeHeight = movement.eyeHeight;
    const horizontalDistance = Math.hypot(
      this.camera.position.x - previousX,
      this.camera.position.z - previousZ,
    );
    this.playerSpeed = delta > 0 ? horizontalDistance / delta : 0;
    if (this.activeMode === "shared" && this.sharedRole === "guest") {
      this.recordLocalReplayDelta(this.camera.position.x - previousX, this.camera.position.z - previousZ);
    }

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

  private sendGuestInputTickPayload(
    tick: number,
    now: number,
    movementX: number,
    movementZ: number,
    crouching: boolean,
    jumpRequested: boolean,
    interacting: boolean,
  ): boolean {
    if (!this.sharedRoom || this.sharedRole !== "guest") {
      return false;
    }

    const actions: string[] = [];
    if (crouching) {
      actions.push("crouch");
    }
    if (jumpRequested) {
      actions.push("jump");
    }
    if (this.reloadEndsAt > now) {
      actions.push("reload");
    }
    if (interacting) {
      actions.push("interact");
    }

    const sequence = this.nextInputSequence++;
    const sent = this.sharedRoom.sendInputTick({
      tick,
      sequence,
      look: [
        Number(this.tempLook.x.toFixed(4)),
        Number(this.tempLook.y.toFixed(4)),
        Number(this.tempLook.z.toFixed(4)),
      ],
      movement: [movementX, movementZ],
      actions,
    });
    if (!sent) {
      return false;
    }

    this.lastSentInputSequence = sequence;
    this.recordLocalInputHistory(sequence, tick, movementX, movementZ, crouching);
    return true;
  }

  private sendLocalInputTick(now: number): void {
    if (!this.sharedRoom || this.sharedRole !== "guest" || this.debugPauseInputTicks) {
      return;
    }

    this.tempLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    const movement = this.currentMovementInputState();
    const reloadActive = this.reloadEndsAt > now;
    const interactActive = this.interactHeld && this.roundState.phase === "active";
    if (movement.active || movement.crouching || movement.jumpRequested || reloadActive || interactActive) {
      this.lastActiveInputAt = now;
    }

    const signature = [
      movement.moveX.toFixed(2),
      movement.moveZ.toFixed(2),
      movement.crouching ? "crouch" : "",
      movement.jumpRequested ? "jump" : "",
      reloadActive ? "reload" : "",
      interactActive ? "interact" : "",
      this.tempLook.x.toFixed(2),
      this.tempLook.y.toFixed(2),
      this.tempLook.z.toFixed(2),
    ].join("|");
    const pulseSeconds =
      movement.active ||
      movement.crouching ||
      movement.jumpRequested ||
      reloadActive ||
      interactActive ||
      now - this.lastActiveInputAt < GUEST_RECENT_ACTIVE_INPUT_SECONDS
        ? GUEST_ACTIVE_INPUT_PULSE_SECONDS
        : GUEST_IDLE_INPUT_PULSE_SECONDS;

    if (signature === this.lastInputSignature && now - this.lastInputSentAt < pulseSeconds) {
      return;
    }

    if (
      !this.sendGuestInputTickPayload(
        Date.now(),
        now,
        movement.moveX,
        movement.moveZ,
        movement.crouching,
        movement.jumpRequested,
        interactActive,
      )
    ) {
      return;
    }

    this.lastInputSignature = signature;
    this.lastInputSentAt = now;
  }

  private recordLocalInputHistory(
    sequence: number,
    tick: number,
    movementX: number,
    movementZ: number,
    crouching: boolean,
  ): void {
    this.localInputHistory.push({
      sequence,
      tick,
      movement: new THREE.Vector2(movementX, movementZ),
      crouching,
    });
    this.pruneLocalPredictionHistory();
  }

  private recordLocalReplayDelta(deltaX: number, deltaZ: number): void {
    if (Math.hypot(deltaX, deltaZ) <= 0.0001 || this.localInputHistory.length === 0) {
      return;
    }

    const sequence = this.localInputHistory[this.localInputHistory.length - 1]?.sequence ?? 0;
    if (sequence <= this.lastAcknowledgedInputSequence) {
      return;
    }

    this.localReplayDeltas.push({
      sequence,
      recordedAt: Date.now(),
      delta: new THREE.Vector3(deltaX, 0, deltaZ),
    });
    this.pruneLocalPredictionHistory();
  }

  private pruneLocalPredictionHistory(nowMs = Date.now()): void {
    while (this.localInputHistory.length > 0) {
      const oldest = this.localInputHistory[0];
      if (
        oldest.sequence <= this.lastAcknowledgedInputSequence ||
        nowMs - oldest.tick > LOCAL_INPUT_HISTORY_MAX_AGE_MS ||
        this.localInputHistory.length > LOCAL_INPUT_HISTORY_MAX_ENTRIES
      ) {
        this.localInputHistory.shift();
        continue;
      }
      break;
    }

    while (this.localReplayDeltas.length > 0) {
      const oldest = this.localReplayDeltas[0];
      if (
        oldest.sequence <= this.lastAcknowledgedInputSequence ||
        nowMs - oldest.recordedAt > LOCAL_REPLAY_DELTA_MAX_AGE_MS ||
        this.localReplayDeltas.length > LOCAL_REPLAY_DELTA_MAX_ENTRIES
      ) {
        this.localReplayDeltas.shift();
        continue;
      }
      break;
    }
  }

  private resetLocalPredictionHistory(acknowledgedSequence = this.lastAcknowledgedInputSequence): void {
    this.lastAcknowledgedInputSequence = Math.max(
      this.lastAcknowledgedInputSequence,
      acknowledgedSequence,
    );
    this.localInputHistory.length = 0;
    this.localReplayDeltas.length = 0;
  }

  private buildReconciledAuthoritativePosition(
    position: HostRoomSnapshot["roster"][number]["position"],
  ): THREE.Vector3 {
    const replayed = new THREE.Vector3(position[0], position[1], position[2]);
    this.pruneLocalPredictionHistory();

    for (const entry of this.localReplayDeltas) {
      if (entry.sequence <= this.lastAcknowledgedInputSequence) {
        continue;
      }

      const next = resolveHorizontalMovement(
        this.collisionWorld,
        replayed,
        entry.delta,
        PLAYER_RADIUS,
        currentBodyHeight(this.movementState),
      );
      replayed.set(next.x, replayed.y, next.z);
    }

    return replayed;
  }

  private reconcileAuthoritativePosition(delta: number): void {
    if (!this.authoritativePosition) {
      return;
    }

    const errorX = this.authoritativePosition.x - this.camera.position.x;
    const errorY = this.authoritativePosition.y - this.camera.position.y;
    const errorZ = this.authoritativePosition.z - this.camera.position.z;
    const distance = Math.hypot(errorX, errorZ);

    if (distance > LOCAL_RECONCILE_SNAP_DISTANCE || this.playerDead) {
      this.camera.position.copy(this.authoritativePosition);
      return;
    }

    if (distance < 0.02 && Math.abs(errorY) < 0.02) {
      return;
    }

    const blend = 1 - Math.exp(-10 * delta);
    this.camera.position.x += errorX * blend;
    this.camera.position.y += errorY * blend;
    this.camera.position.z += errorZ * blend;
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

  private remoteBombActorAtSite(teamId: TeamId, requireInteracting: boolean): RemoteActor | undefined {
    if (!this.bombState) {
      return undefined;
    }

    return [...this.remoteActors.values()]
      .filter(
        (actor) =>
          actor.status === "alive" &&
          actor.teamId === teamId &&
          (!requireInteracting || actor.inputInteracting) &&
          this.distanceToBombSite(actor.displayPosition) <= (this.bombState?.site.radius ?? 0),
      )
      .sort(
        (left, right) =>
          this.distanceToBombSite(left.displayPosition) -
          this.distanceToBombSite(right.displayPosition),
      )[0];
  }

  private tryStartRemoteObjectiveAction(actor: RemoteActor, now: number): void {
    if (actor.status !== "alive" || this.roundState.phase !== "active") {
      return;
    }

    if (this.bombState) {
      if (
        this.bombState.phase === "carried" &&
        this.bombState.carrierId === actor.id &&
        actor.teamId === this.bombState.attackingTeam &&
        this.distanceToBombSite(actor.displayPosition) <= this.bombState.site.radius
      ) {
        this.startBombPlant(now, actor.id, actor.name);
        return;
      }

      if (
        this.bombState.phase === "planted" &&
        actor.teamId === this.bombState.defendingTeam &&
        this.distanceToBombSite(actor.displayPosition) <= this.bombState.site.radius
      ) {
        this.startBombDefuse(now, actor.id, actor.name);
        return;
      }
    }

    if (
      this.hostageState?.phase === "awaiting-rescue" &&
      actor.teamId === this.hostageState.attackingTeam &&
      this.distanceToHostageCluster(actor.displayPosition) <= this.hostageState.cluster.radius
    ) {
      this.startHostageSecure(now, actor.id, actor.name);
    }
  }

  private objectiveEnemyById(combatantId: string | null): EnemyActor | null {
    if (!combatantId) {
      return null;
    }

    return this.enemies.find((enemy) => enemy.id === combatantId && enemy.alive) ?? null;
  }

  private enemyCanCommitObjectiveAction(enemy: EnemyActor): boolean {
    if (!enemy.alive || this.playerDead) {
      return true;
    }

    const tuning = this.botTuning();
    const enemyFeet = enemy.avatar.group.position.clone().setY(0);
    const playerFeet = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    const playerDistance = enemyFeet.distanceTo(playerFeet);
    return (
      !enemy.ai.canSeePlayer ||
      enemy.ai.lastVisibility < tuning.clearShotVisibilityThreshold ||
      playerDistance > tuning.objectiveThreatDistance
    );
  }

  private updateEnemyBombObjectiveActions(now: number): void {
    if (
      !this.bombState ||
      this.activeMode !== "local" ||
      (this.qaInvulnerable && !this.qaAllowEnemyObjectiveActions)
    ) {
      return;
    }

    if (this.bombState.phase === "carried") {
      const carrier = this.objectiveEnemyById(this.bombState.carrierId);
      if (
        carrier &&
        this.distanceToBombSite(carrier.avatar.group.position) <= this.bombState.site.radius &&
        this.enemyCanCommitObjectiveAction(carrier)
      ) {
        this.startBombPlant(now, carrier.id, carrier.name);
      }
      return;
    }

    if (this.bombState.phase === "planted") {
      const defuser = this.enemies
        .filter(
          (enemy) =>
            enemy.alive &&
            enemy.teamId === this.bombState?.defendingTeam &&
            this.distanceToBombSite(enemy.avatar.group.position) <= (this.bombState?.site.radius ?? 0),
        )
        .sort(
          (left, right) =>
            this.distanceToBombSite(left.avatar.group.position) -
            this.distanceToBombSite(right.avatar.group.position),
        )[0];

      if (defuser && this.enemyCanCommitObjectiveAction(defuser)) {
        this.startBombDefuse(now, defuser.id, defuser.name);
      }
    }
  }

  private updateBombObjectiveState(now: number): void {
    if (this.activeMode === "shared" && this.sharedRole === "guest") {
      return;
    }

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
      } else {
        const remoteDefuser = this.remoteBombActorAtSite(this.bombState.defendingTeam, true);
        if (remoteDefuser) {
          this.startBombDefuse(now, remoteDefuser.id, remoteDefuser.name);
        }
      }

      this.updateEnemyBombObjectiveActions(now);

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
    } else if (this.bombState.carrierId) {
      const remoteCarrier = this.remoteActors.get(this.bombState.carrierId);
      if (
        remoteCarrier &&
        remoteCarrier.status === "alive" &&
        remoteCarrier.inputInteracting &&
        this.distanceToBombSite(remoteCarrier.displayPosition) <= this.bombState.site.radius
      ) {
        this.startBombPlant(now, remoteCarrier.id, remoteCarrier.name);
      }
    }

    this.updateEnemyBombObjectiveActions(now);
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

  private remoteHostageActorAtCluster(requireInteracting: boolean): RemoteActor | undefined {
    if (!this.hostageState) {
      return undefined;
    }

    return [...this.remoteActors.values()]
      .filter(
        (actor) =>
          actor.status === "alive" &&
          actor.teamId === this.hostageState?.attackingTeam &&
          (!requireInteracting || actor.inputInteracting) &&
          this.distanceToHostageCluster(actor.displayPosition) <=
            (this.hostageState?.cluster.radius ?? 0),
      )
      .sort(
        (left, right) =>
          this.distanceToHostageCluster(left.displayPosition) -
          this.distanceToHostageCluster(right.displayPosition),
      )[0];
  }

  private updateEnemyHostageObjectiveActions(now: number): void {
    if (
      !this.hostageState ||
      this.activeMode !== "local" ||
      (this.qaInvulnerable && !this.qaAllowEnemyObjectiveActions)
    ) {
      return;
    }

    if (this.hostageState.phase === "awaiting-rescue") {
      const rescuer = this.enemies
        .filter(
          (enemy) =>
            enemy.alive &&
            enemy.teamId === this.hostageState?.attackingTeam &&
            this.distanceToHostageCluster(enemy.avatar.group.position) <=
              (this.hostageState?.cluster.radius ?? 0),
        )
        .sort(
          (left, right) =>
            this.distanceToHostageCluster(left.avatar.group.position) -
            this.distanceToHostageCluster(right.avatar.group.position),
        )[0];

      if (rescuer && this.enemyCanCommitObjectiveAction(rescuer)) {
        this.startHostageSecure(now, rescuer.id, rescuer.name);
      }
      return;
    }

    if (this.hostageState.phase === "escorting") {
      const rescuer = this.objectiveEnemyById(this.hostageState.rescuerId);
      if (
        rescuer &&
        this.allHostagesAtExtraction() &&
        this.distanceToExtractionZone(rescuer.avatar.group.position) <=
          this.hostageState.extraction.radius
      ) {
        this.startHostageExtraction(now, rescuer.id, rescuer.name);
      }
    }
  }

  private hostageObjectiveAuthority(): boolean {
    if (!this.hostageState) {
      return false;
    }

    if (this.activeMode === "local") {
      return true;
    }

    if (this.activeMode === "shared") {
      return this.sharedRole === "host";
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
      } else {
        const remoteRescuer = this.remoteHostageActorAtCluster(true);
        if (remoteRescuer) {
          this.startHostageSecure(now, remoteRescuer.id, remoteRescuer.name);
        }
      }

      this.updateEnemyHostageObjectiveActions(now);

      return;
    }

    this.updateHostageEscortMovement(delta, now);

    if (this.hostageState.phase === "extracting") {
      const rescuer = this.bombCombatantById(this.hostageState.rescuerId);
      const rescuerPosition = this.bombCombatantPosition(this.hostageState.rescuerId);
      const extractionBroken =
        !rescuerPosition ||
        !rescuer?.alive ||
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
    } else if (this.hostageState.rescuerId) {
      const remoteRescuer = this.remoteActors.get(this.hostageState.rescuerId);
      if (
        remoteRescuer &&
        remoteRescuer.status === "alive" &&
        this.allHostagesAtExtraction() &&
        this.distanceToExtractionZone(remoteRescuer.displayPosition) <=
          this.hostageState.extraction.radius
      ) {
        this.startHostageExtraction(now, remoteRescuer.id, remoteRescuer.name);
      }
    }

    this.updateEnemyHostageObjectiveActions(now);
  }

  private startHostageSecure(
    now: number,
    combatantId = this.playerIdentity.id,
    combatantName = this.playerIdentity.name,
  ): void {
    if (!this.hostageState || this.hostageState.phase !== "awaiting-rescue") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "securing",
      actingCombatantId: combatantId,
      actingCombatantName: combatantName,
      secureStartedAt: now,
      secureEndsAt: now + this.hostageState.secureSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Securing ${this.hostageState.cluster.label}...`, 1);
    this.publishHostSnapshot(true);
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
    this.publishHostSnapshot(true);
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
    this.publishHostSnapshot(true);
  }

  private startHostageExtraction(
    now: number,
    combatantId = this.playerIdentity.id,
    combatantName = this.playerIdentity.name,
  ): void {
    if (!this.hostageState || this.hostageState.phase !== "escorting") {
      return;
    }

    this.hostageState = {
      ...this.hostageState,
      phase: "extracting",
      actingCombatantId: combatantId,
      actingCombatantName: combatantName,
      extractStartedAt: now,
      extractEndsAt: now + this.hostageState.extractSeconds,
      updatedAt: now,
    };
    this.roundState = {
      ...this.roundState,
      phaseEndsAt: Math.max(this.roundState.phaseEndsAt, now + this.hostageState.extractSeconds),
    };
    this.pushFeed(`Opening ${this.hostageState.extraction.label}...`, 1.2);
    this.publishHostSnapshot(true);
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
    this.publishHostSnapshot(true);
  }

  private startBombPlant(
    now: number,
    combatantId = this.playerIdentity.id,
    combatantName = this.playerIdentity.name,
  ): void {
    if (!this.bombState || this.bombState.phase !== "carried") {
      return;
    }

    this.bombState = {
      ...this.bombState,
      phase: "planting",
      actingCombatantId: combatantId,
      actingCombatantName: combatantName,
      plantStartedAt: now,
      plantEndsAt: now + this.bombState.plantSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Arming ${this.bombState.site.label}...`, 0.9);
    this.publishHostSnapshot(true);
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

    this.publishHostSnapshot(true);
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
    this.publishHostSnapshot(true);
  }

  private startBombDefuse(
    now: number,
    combatantId = this.playerIdentity.id,
    combatantName = this.playerIdentity.name,
  ): void {
    if (!this.bombState || this.bombState.phase !== "planted") {
      return;
    }

    this.bombState = {
      ...this.bombState,
      phase: "defusing",
      actingCombatantId: combatantId,
      actingCombatantName: combatantName,
      defuseStartedAt: now,
      defuseEndsAt: now + this.bombState.defuseSeconds,
      updatedAt: now,
    };
    this.pushFeed(`Disarming ${this.bombState.site.label}...`, 0.9);
    this.publishHostSnapshot(true);
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

    this.publishHostSnapshot(true);
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

      this.lastSharedShotSentAt = now;
      this.recordShotDebug("shared-sent", now, this.playerIdentity.id);
      if (!remoteTarget) {
        this.broadcastHostShotResult(undefined, now);
        return;
      }

      remoteTarget.hitFlashUntil = now + 0.12;
      remoteTarget.recoil = Math.min(1, remoteTarget.recoil + 0.7);
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();
      this.applyRemoteActorDamage(remoteTarget, PLAYER_DAMAGE, this.playerIdentity.id, now);
      this.broadcastHostShotResult(remoteTarget, now);
      this.pushFeed(
        remoteTarget.status === "alive"
          ? `${remoteTarget.name} tagged for ${PLAYER_DAMAGE}.`
          : `${remoteTarget.name} dropped.`,
        remoteTarget.status === "alive" ? 0.8 : 1.7,
      );
      this.publishHostSnapshot(true);
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

  private broadcastHostShotResult(target: RemoteActor | undefined, now: number): void {
    if (!this.sharedRoom || this.sharedRole !== "host") {
      return;
    }

    const result = {
      claimId: this.localShotSequence,
      shooterId: this.playerIdentity.id,
      targetId: target?.id,
      decision: target ? ("accepted" as const) : ("rejected" as const),
      damage: target ? PLAYER_DAMAGE : 0,
      reason: target ? "hit-confirmed" : "no-target",
      shooterWeapon: this.localWeaponSnapshot(),
      targetHealth: target?.health,
      targetStatus: target?.status,
    };
    this.sharedRoom.sendShotResult(result);
    this.lastShotResult = {
      peerId: this.playerIdentity.id,
      sentAt: Date.now(),
      ...result,
    };
  }

  private localWeaponSnapshot(): WeaponStateSnapshot {
    const now = this.gameNow();
    const reloadEndsAt =
      this.reloadEndsAt > now ? Date.now() + Math.max(0, this.reloadEndsAt - now) * 1000 : 0;

    return {
      ammoInClip: this.ammoInClip,
      reserveAmmo: this.reserveAmmo,
      reloadSequence: this.reloadSequence,
      reloadEndsAt,
      spreadIndex: this.spreadIndex,
    };
  }

  private applyLocalShotEffects(now: number): void {
    this.nextShotAt = now + FIRE_INTERVAL;
    this.ammoInClip -= 1;
    this.spreadIndex += 1;
    this.recoil = Math.min(
      1,
      this.recoil + (this.playerCrouching ? 0.58 : 0.8) + (this.playerGrounded ? 0 : 0.12),
    );
    this.muzzleFlashUntil = now + MUZZLE_FLASH_DURATION;
    this.audio.fire();
    this.registerPlayerNoise(now);
    this.localShotSequence += 1;
    this.lastLocalShotAt = now;
    this.recordShotDebug("local", now, this.playerIdentity.id);
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
      inputSequence: overrides.inputSequence ?? this.lastSentInputSequence,
      weaponId: overrides.weaponId ?? SHARED_WEAPON_ID,
    };
  }

  private sendGuestShotClaim(
    claim: RoomShotClaim | null,
    predictedTarget: RemoteActor | undefined,
    now: number,
  ): void {
    if (!claim || !this.sharedRoom || this.sharedRole !== "guest") {
      return;
    }

    this.lastShotClaim = claim;
    this.lastSharedShotSentAt = now;
    this.pendingShotClaims.set(claim.claimId, {
      claimId: claim.claimId,
      submittedAt: Date.now(),
      targetId: predictedTarget?.id,
    });
    this.recordShotDebug("shared-sent", now, this.playerIdentity.id);

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

    syncWeaponState(weaponState, event.tick, CLIP_SIZE);
    const shooter =
      this.rewindBuffer.sample(event.peerId, event.tick, SHOT_REWIND_DRIFT_MS) ??
      (() => {
        const actor = this.remoteActors.get(event.peerId);
        return actor ? this.buildRemoteRewindFrame(actor, Date.now()) : undefined;
      })();

    if (!shooter) {
      this.sendRejectedShotResult(event, weaponState, "rewind-missing");
      return;
    }

    if (this.roundState.phase !== "active") {
      this.sendRejectedShotResult(event, weaponState, "round-inactive");
      return;
    }

    const spreadBefore = weaponState.spreadIndex;
    const resolution = validateShotClaim({
      claim: event,
      shooter,
      targets: this.collectShotValidationTargets(event.peerId, event.tick),
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
        targetRadius: PLAYER_RADIUS * 0.88,
        targetHeight: STANDING_BODY_HEIGHT + 0.42,
      },
    });

    const now = this.gameNow();
    const shooterActor = this.remoteActors.get(event.peerId);
    if (shooterActor && weaponState.spreadIndex > spreadBefore) {
      this.applyRemoteShotFeedback(shooterActor, now);
    }

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

  private sendRejectedShotResult(
    event: RoomShotClaimEvent,
    weaponState: SharedWeaponState,
    reason: string,
  ): void {
    if (!this.sharedRoom || this.sharedRole !== "host") {
      return;
    }

    const result = {
      claimId: event.claimId,
      shooterId: event.shooterId,
      decision: "rejected" as const,
      damage: 0,
      reason,
      shooterWeapon: snapshotWeaponState(weaponState),
    };
    this.sharedRoom.sendShotResult(result, event.peerId);
    this.lastShotResult = {
      peerId: this.playerIdentity.id,
      sentAt: Date.now(),
      ...result,
    };
  }

  private handleSharedShotResult(event: RoomShotResultEvent): void {
    if (this.sharedRole !== "guest") {
      return;
    }

    const now = this.gameNow();
    this.lastRoomShotReceivedAt = now;
    this.lastShotResult = event;
    this.recentShotResults.push(event);
    if (this.recentShotResults.length > 8) {
      this.recentShotResults.shift();
    }

    if (event.shooterId !== this.playerIdentity.id) {
      this.applyRemoteAuthoritativeShotResult(event, now);
      return;
    }

    const pending = this.pendingShotClaims.get(event.claimId);
    this.pendingShotClaims.delete(event.claimId);
    this.applyAuthoritativeWeaponState(event.shooterWeapon);

    if (event.targetId) {
      const target = this.remoteActors.get(event.targetId);
      if (target) {
        target.health = event.targetHealth ?? target.health;
        target.status = event.targetStatus ?? target.status;
        target.hitFlashUntil = event.damage > 0 ? now + 0.12 : target.hitFlashUntil;
      }
    }

    if (event.damage > 0 && event.targetId) {
      this.hitIndicatorUntil = now + HIT_INDICATOR_DURATION;
      this.audio.hitConfirm();
      this.pushFeed(
        event.targetStatus === "down" ? "Host confirmed elimination." : "Host confirmed hit.",
        event.targetStatus === "down" ? 1.4 : 0.8,
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

  private applyRemoteAuthoritativeShotResult(
    event: RoomShotResultEvent,
    now: number,
  ): void {
    const shooter = this.remoteActors.get(event.shooterId);
    if (shooter) {
      this.applyRemoteShotFeedback(shooter, now);
    }

    if (event.targetId && event.targetId !== this.playerIdentity.id) {
      const target = this.remoteActors.get(event.targetId);
      if (target) {
        target.health = event.targetHealth ?? target.health;
        target.status = event.targetStatus ?? target.status;
        target.hitFlashUntil = event.damage > 0 ? now + 0.12 : target.hitFlashUntil;
      }
      return;
    }

    if (event.targetId !== this.playerIdentity.id || event.damage <= 0) {
      return;
    }

    const attackerName = shooter?.name ?? "Remote operator";
    const previousHealth = this.playerHealth;
    this.applyPlayerDamage(Math.min(event.damage, previousHealth), attackerName, now, event.shooterId);
    if (typeof event.targetHealth === "number") {
      this.playerHealth = event.targetHealth;
    }
    if (event.targetStatus === "down" && !this.playerDead) {
      this.playerDead = true;
    }
  }

  private collectShotValidationTargets(shooterId: string, tickMs: number): Array<CombatantRewindState & { capturedAt: number }> {
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
      team: this.localTeamId,
      status: this.playerDead ? "down" : "alive",
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
    const remoteEyeHeight = currentEyeHeight(actor.movementState);
    return {
      id: actor.id,
      name: actor.name,
      team: actor.teamId,
      status: actor.status,
      health: actor.health,
      capturedAt,
      position: actor.targetPosition.clone().setY(actor.targetPosition.y + remoteEyeHeight),
      look: actor.lookDirection.clone(),
    };
  }

  private applyAuthoritativeWeaponState(state: WeaponStateSnapshot): void {
    this.ammoInClip = state.ammoInClip;
    this.reserveAmmo = state.reserveAmmo;
    this.reloadSequence = state.reloadSequence;
    this.spreadIndex = state.spreadIndex;
    if (state.reloadEndsAt > Date.now()) {
      this.reloadEndsAt = this.gameNow() + (state.reloadEndsAt - Date.now()) / 1000;
      return;
    }
    this.reloadEndsAt = 0;
  }

  private applyRemoteShotFeedback(actor: RemoteActor, now: number): void {
    actor.lastShotAt = now;
    actor.recoil = Math.min(1, actor.recoil + 0.76);
    this.lastRoomShotReceivedAt = now;
    this.recordShotDebug(
      "shared-received",
      now,
      actor.id,
      actor.displayPosition.distanceTo(this.camera.position),
    );
    this.playWorldFireAt(actor.displayPosition.clone().setY(currentEyeHeight(actor.movementState)));
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
    this.reloadEndsAt = this.gameNow() + RELOAD_DURATION;
    this.pushFeed("Reloading...", RELOAD_DURATION);
  }

  private updateAuthoritativeRemoteActors(delta: number, now: number): void {
    for (const actor of this.remoteActors.values()) {
      if (actor.status !== "alive") {
        actor.inputMovement.set(0, 0);
        actor.inputCrouching = false;
        actor.inputInteracting = false;
        actor.pendingJump = false;
        actor.moveBlend = THREE.MathUtils.damp(actor.moveBlend, 0, 9, delta);
        actor.recoil = THREE.MathUtils.damp(actor.recoil, 0, 12, delta);
        actor.avatar.group.position.copy(actor.targetPosition);
        this.syncRemoteActorAim(actor, now);
        continue;
      }

      if (Date.now() - actor.lastInputReceivedAt > REMOTE_INPUT_DEADMAN_MS) {
        actor.inputMovement.set(0, 0);
        actor.inputCrouching = false;
        actor.inputInteracting = false;
      }

      this.tempQuaternion.copy(actor.avatar.group.quaternion).multiply(COMBATANT_MOVEMENT_OFFSET);
      const movement = updateSharedMovement(
        actor.movementState,
        actor.targetPosition,
        this.tempQuaternion,
        "feet",
        this.collisionWorld,
        delta,
        now,
        {
          enabled: true,
          moveX: actor.inputMovement.x,
          moveZ: actor.inputMovement.y,
          crouching: actor.inputCrouching,
          jumpRequested: actor.pendingJump,
        },
        this.tempForward,
        this.tempRight,
        this.tempDelta,
      );
      actor.pendingJump = false;
      actor.lastProcessedInputSequence = actor.lastInputSequence;
      actor.displayPosition.copy(actor.targetPosition);
      actor.avatar.group.position.copy(actor.displayPosition);
      actor.moveBlend = movement.moveBlend;
      actor.recoil = THREE.MathUtils.damp(actor.recoil, 0, 12, delta);
      this.syncRemoteActorAim(actor, now);
    }
  }

  private updateRemoteActors(delta: number, now: number): void {
    for (const actor of this.remoteActors.values()) {
      actor.displayPosition.lerp(actor.targetPosition, 1 - Math.exp(-REMOTE_LERP_SPEED * delta));
      actor.avatar.group.position.copy(actor.displayPosition);
      actor.recoil = THREE.MathUtils.damp(actor.recoil, 0, 12, delta);

      const moving =
        actor.status === "alive" && actor.displayPosition.distanceTo(actor.targetPosition) > 0.06 ? 1 : 0;
      actor.moveBlend = THREE.MathUtils.damp(actor.moveBlend, moving, 9, delta);
      this.syncRemoteActorAim(actor, now);
    }
  }

  private queueEnemyContact(
    sourceEnemy: EnemyActor,
    position: THREE.Vector3,
    now: number,
    kind: "visual" | "sound" | "damage",
  ): void {
    const tuning = this.botTuning();

    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.id === sourceEnemy.id) {
        continue;
      }

      const duplicate = this.enemyContactQueue.some(
        (contact) =>
          contact.targetEnemyId === enemy.id &&
          contact.sourceEnemyId === sourceEnemy.id &&
          contact.kind === kind &&
          contact.position.distanceToSquared(position) <= 1 &&
          Math.abs(contact.deliverAt - (now + tuning.communicationDelaySeconds)) <= 0.15,
      );
      if (duplicate) {
        continue;
      }

      this.enemyContactQueue.push({
        targetEnemyId: enemy.id,
        sourceEnemyId: sourceEnemy.id,
        deliverAt: now + tuning.communicationDelaySeconds,
        position: position.clone(),
        kind,
      });
    }

    if (this.enemyContactQueue.length > 18) {
      this.enemyContactQueue.splice(0, this.enemyContactQueue.length - 18);
    }
  }

  private processEnemyContactQueue(now: number): void {
    const tuning = this.botTuning();

    for (let index = this.enemyContactQueue.length - 1; index >= 0; index -= 1) {
      const contact = this.enemyContactQueue[index];
      if (contact.deliverAt > now) {
        continue;
      }

      this.enemyContactQueue.splice(index, 1);
      const enemy = this.objectiveEnemyById(contact.targetEnemyId);
      if (!enemy || enemy.ai.canSeePlayer) {
        continue;
      }

      enemy.ai.lastSharedContactAt = now;
      enemy.ai.lastHeardAt = now;
      enemy.ai.lastHeardPosition = contact.position.clone();
      if (contact.kind !== "sound") {
        enemy.ai.lastSeenAt = now - Math.max(0, tuning.pursuitSeconds - tuning.communicationMemorySeconds);
        enemy.ai.lastKnownPlayerPosition = contact.position.clone();
      }
    }
  }

  private nextEnemyRandom(enemy: EnemyActor): number {
    const rolled = nextDeterministicRandom(enemy.ai.rngState);
    enemy.ai.rngState = rolled.state;
    return rolled.value;
  }

  private refillEnemyBurst(enemy: EnemyActor): void {
    const tuning = this.botTuning();
    const spread = Math.max(0, tuning.burstMaxShots - tuning.burstMinShots);
    const draw = this.nextEnemyRandom(enemy);
    enemy.ai.burstShotsRemaining =
      tuning.burstMinShots + Math.floor(draw * (spread + 1));
  }

  private setEnemyForcedDirective(
    enemy: EnemyActor,
    now: number,
    behavior: EnemyBehavior,
    stance: EnemyStance,
    targetPosition: THREE.Vector3,
    targetLabel: string,
    duration: number,
  ): void {
    enemy.ai.forcedBehavior = behavior;
    enemy.ai.forcedStance = stance;
    enemy.ai.forcedTargetPosition = targetPosition.clone();
    enemy.ai.forcedTargetLabel = targetLabel;
    enemy.ai.forcedUntil = now + duration;
  }

  private clearEnemyForcedDirective(enemy: EnemyActor, now: number): void {
    if (enemy.ai.forcedUntil > now) {
      return;
    }

    enemy.ai.forcedBehavior = null;
    enemy.ai.forcedStance = null;
    enemy.ai.forcedTargetPosition = null;
    enemy.ai.forcedTargetLabel = null;
    enemy.ai.forcedUntil = Number.NEGATIVE_INFINITY;
  }

  private chooseEnemyRecoveryTarget(
    enemy: EnemyActor,
    blockedTargetPosition: THREE.Vector3,
  ): TacticalAnchor | null {
    const targetVisibilityPoints = buildVisibilityPoints(
      blockedTargetPosition,
      STANDING_EYE_HEIGHT,
      false,
    );
    const recovery = chooseRecoveryAnchor({
      profile: this.tacticalProfile,
      world: this.collisionWorld,
      enemyPosition: enemy.avatar.group.position.clone().setY(0),
      enemyEyeHeight: this.enemyEyeHeight(enemy),
      blockedTargetPosition,
      blockedTargetVisibilityPoints: targetVisibilityPoints,
      objectiveAnchor: enemy.ai.objectiveAnchor,
    });

    return (
      recovery?.anchor ??
      enemy.ai.patrolRoute[(enemy.ai.patrolIndex + 1) % Math.max(enemy.ai.patrolRoute.length, 1)] ??
      null
    );
  }

  private chooseEnemyJumpReason(
    enemy: EnemyActor,
    behavior: EnemyBehavior,
    stance: EnemyStance,
    shouldMove: boolean,
    targetDistance: number,
    now: number,
    tuning: BotDifficultyTuning,
  ): EnemyJumpReason | null {
    if (enemy.qaJumpRequested) {
      return "qa";
    }

    if (!shouldMove || stance === "crouched" || !enemy.movementState.grounded) {
      return null;
    }

    if (
      behavior !== "patrol" &&
      behavior !== "investigate" &&
      behavior !== "pursue" &&
      behavior !== "reposition"
    ) {
      return null;
    }

    if (targetDistance <= 1.4 || enemy.speed > 0.16) {
      return null;
    }

    if (now - enemy.ai.lastJumpAt < 1.15) {
      return null;
    }

    const stalledFor = now - enemy.ai.lastProgressAt;
    const jumpStallSeconds = Math.min(0.46, tuning.stuckSeconds * 0.6);
    if (stalledFor < jumpStallSeconds || stalledFor >= tuning.stuckSeconds) {
      return null;
    }

    return "stuck-recovery";
  }

  private updateEnemies(delta: number, now: number): void {
    const tuning = this.botTuning();
    const playerFeet = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    const playerVisibilityPoints = this.playerVisibilityPoints();
    this.processEnemyContactQueue(now);

    for (const enemy of this.enemies) {
      enemy.recoil = THREE.MathUtils.damp(enemy.recoil, 0, 12, delta);
      this.clearEnemyForcedDirective(enemy, now);

      if (!enemy.alive) {
        enemy.speed = 0;
        enemy.avatar.update(
          now,
          0,
          false,
          0,
          enemy.hitFlashUntil > now ? 1 : 0,
          0,
          enemy.movementState.crouchBlend,
          enemy.movementState.grounded ? 0 : 1,
        );
        continue;
      }

      if (this.roundState.phase !== "active") {
        enemy.speed = 0;
        enemy.moveBlend = THREE.MathUtils.damp(enemy.moveBlend, 0, 8, delta);
        enemy.avatar.update(
          now,
          enemy.moveBlend,
          true,
          enemy.recoil,
          enemy.hitFlashUntil > now ? 1 : 0,
          this.aimPitchFromLook(enemy.lookDirection),
          enemy.movementState.crouchBlend,
          enemy.movementState.grounded ? 0 : 1,
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
      const enemyFeet = new THREE.Vector3(enemyPosition.x, 0, enemyPosition.z);
      const enemyEye = this.enemyEyePosition(enemy);
      const toPlayer = playerFeet.clone().sub(enemyFeet);
      const playerDistance = toPlayer.length();
      const visibility = !this.playerDead
        ? evaluateVisibility(this.collisionWorld, enemyEye, playerVisibilityPoints)
        : 0;
      const canSeePlayer =
        !this.playerDead &&
        playerDistance <= ENEMY_ENGAGE_DISTANCE &&
        visibility >= tuning.engageVisibilityThreshold;
      if (previousVisibility && !canSeePlayer) {
        enemy.ai.lastLostSightAt = now;
      }
      enemy.ai.canSeePlayer = canSeePlayer;
      enemy.ai.lastVisibility = visibility;
      enemy.ai.blockedBy = canSeePlayer
        ? null
        : this.findBlockingGeometryName(enemyEye, this.camera.position.clone());

      const heardPlayer =
        now - this.lastPlayerNoiseAt <= Math.min(1.6, tuning.investigationSeconds) &&
        enemyFeet.distanceTo(this.lastPlayerNoisePosition) <= PLAYER_NOISE_HEARING_RADIUS;
      if (heardPlayer) {
        const heardFresh = now - enemy.ai.lastHeardAt > 0.28;
        enemy.ai.lastHeardAt = now;
        enemy.ai.lastHeardPosition = this.lastPlayerNoisePosition.clone();
        if (heardFresh && !canSeePlayer) {
          this.queueEnemyContact(enemy, this.lastPlayerNoisePosition, now, "sound");
        }
      }

      if (canSeePlayer) {
        if (!previousVisibility) {
          this.queueEnemyContact(enemy, playerFeet, now, "visual");
        }
        enemy.ai.lastSeenAt = now;
        enemy.ai.lastKnownPlayerPosition = playerFeet.clone();
      }

      if (
        enemy.ai.lastKnownPlayerPosition &&
        now - enemy.ai.lastSeenAt > tuning.pursuitSeconds
      ) {
        enemy.ai.lastKnownPlayerPosition = null;
      }
      if (enemy.ai.lastHeardPosition && now - enemy.ai.lastHeardAt > tuning.investigationSeconds) {
        enemy.ai.lastHeardPosition = null;
      }

      let behavior: EnemyBehavior = enemy.ai.role === "anchor" ? "objective" : "patrol";
      let stance: EnemyStance = enemy.ai.role === "anchor" ? "crouched" : "standing";
      let targetPosition = enemy.ai.objectiveAnchor.position.clone();
      let targetLabel = enemy.ai.objectiveAnchor.label;
      let moveTowardTarget = true;
      let shouldShoot = false;
      enemy.ai.repositionReason = null;

      if (
        enemy.ai.forcedBehavior &&
        enemy.ai.forcedTargetPosition &&
        enemy.ai.forcedStance &&
        enemy.ai.forcedUntil > now &&
        !canSeePlayer
      ) {
        behavior = enemy.ai.forcedBehavior;
        stance = enemy.ai.forcedStance;
        targetPosition = enemy.ai.forcedTargetPosition.clone();
        targetLabel = enemy.ai.forcedTargetLabel ?? "Recovery angle";
      } else if (canSeePlayer) {
        const recentlyFinishedBurst =
          enemy.ai.lastShotAt > Number.NEGATIVE_INFINITY &&
          enemy.ai.burstShotsRemaining <= 0 &&
          now - enemy.ai.lastShotAt <= tuning.postContactRepositionSeconds;
        const underPressure =
          now - enemy.ai.lastDamagedAt <= tuning.postContactRepositionSeconds ||
          recentlyFinishedBurst ||
          now - enemy.ai.lastLostSightAt <= tuning.postContactRepositionSeconds;
        const repositionChoice =
          underPressure ||
          visibility < tuning.clearShotVisibilityThreshold ||
          playerDistance < 4.4
            ? chooseRepositionAnchor({
                profile: this.tacticalProfile,
                world: this.collisionWorld,
                bodyHeight: this.enemyBodyHeight(enemy),
                enemyPosition: enemyFeet,
                enemyEyeHeight: this.enemyEyeHeight(enemy),
                playerPosition: playerFeet,
                playerVisibilityPoints,
                objectiveAnchor: enemy.ai.objectiveAnchor,
                tuning: {
                  minimumScore: tuning.repositionMinimumScore,
                  coverWeight: this.botDifficulty === "hard" ? 1.1 : this.botDifficulty === "easy" ? 0.9 : 1,
                  angleWeight: this.botDifficulty === "hard" ? 1.08 : 1,
                },
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
          enemy.ai.repositionReason = repositionChoice?.reason ?? "angle";
          shouldShoot = visibility >= tuning.engageVisibilityThreshold;
        } else if (repositionChoice) {
          behavior = "reposition";
          stance = repositionChoice.reason === "cover" ? "crouched" : "standing";
          targetPosition = repositionChoice.anchor.position.clone();
          targetLabel = repositionChoice.anchor.label;
          enemy.ai.repositionReason = repositionChoice.reason;
          shouldShoot = visibility >= tuning.engageVisibilityThreshold;
        } else if (playerDistance > 11.5) {
          behavior = "pursue";
          stance = "standing";
          targetPosition = playerFeet.clone();
          targetLabel = "Last seen angle";
          shouldShoot = visibility >= tuning.engageVisibilityThreshold;
        } else {
          behavior = "engage";
          stance = visibility < tuning.clearShotVisibilityThreshold ? "crouched" : "standing";
          targetPosition = playerDistance > 6.2 ? playerFeet.clone() : enemyFeet.clone();
          targetLabel =
            visibility >= tuning.clearShotVisibilityThreshold ? "Clear shot" : "Partial angle";
          moveTowardTarget = playerDistance > 6.2;
          shouldShoot = visibility >= tuning.engageVisibilityThreshold;
        }
      } else if (
        enemy.ai.lastKnownPlayerPosition &&
        now - enemy.ai.lastSeenAt <= tuning.pursuitSeconds
      ) {
        behavior = "pursue";
        stance = "standing";
        targetPosition = enemy.ai.lastKnownPlayerPosition.clone();
        targetLabel = "Last known position";
      } else if (
        enemy.ai.lastHeardPosition &&
        now - enemy.ai.lastHeardAt <= tuning.investigationSeconds
      ) {
        behavior = "investigate";
        stance = "standing";
        targetPosition = enemy.ai.lastHeardPosition.clone();
        targetLabel = "Sound contact";
      } else if (enemy.ai.role === "anchor") {
        behavior = "objective";
        stance = enemy.ai.role === "anchor" ? "crouched" : "standing";
        targetPosition = enemy.ai.objectiveAnchor.position.clone();
        targetLabel = enemy.ai.objectiveAnchor.label;
      } else {
        behavior = "patrol";
        stance = "standing";
        const routeTarget =
          enemy.ai.patrolRoute[enemy.ai.patrolIndex] ?? enemy.ai.objectiveAnchor;
        targetPosition = routeTarget.position.clone();
        targetLabel = routeTarget.label;
      }

      const urgentBehaviorChange =
        canSeePlayer || behavior === "reposition" || enemy.ai.behavior === "reposition";
      if (
        behavior !== enemy.ai.behavior &&
        !urgentBehaviorChange &&
        now < enemy.ai.behaviorHoldUntil
      ) {
        behavior = enemy.ai.behavior;
        stance = enemy.ai.stance;
        targetPosition = enemy.ai.targetPosition.clone();
        targetLabel = enemy.ai.targetLabel;
        moveTowardTarget = behavior !== "engage" || targetPosition.distanceTo(enemyFeet) > 0.8;
        shouldShoot =
          canSeePlayer && (behavior === "engage" || behavior === "reposition") && visibility >= tuning.engageVisibilityThreshold;
      }

      const toTarget = targetPosition.clone().sub(enemyFeet);
      toTarget.y = 0;
      const targetDistance = toTarget.length();
      if (behavior === "patrol" && targetDistance < 0.9 && enemy.ai.patrolRoute.length > 0) {
        enemy.ai.patrolIndex = (enemy.ai.patrolIndex + 1) % enemy.ai.patrolRoute.length;
        const nextPatrol = enemy.ai.patrolRoute[enemy.ai.patrolIndex] ?? enemy.ai.objectiveAnchor;
        targetPosition = nextPatrol.position.clone();
        targetLabel = nextPatrol.label;
      }

      const lookTargetBeforeMove = canSeePlayer
        ? this.camera.position
        : targetPosition.clone().setY(enemyEye.y);
      this.faceCombatantAt(enemy.avatar.group, enemyPosition, lookTargetBeforeMove);

      const desiredMoveDirection = targetPosition.clone().sub(enemyFeet).setY(0);
      const shouldMove = moveTowardTarget && desiredMoveDirection.length() > 0.5;
      let moveX = 0;
      let moveZ = 0;

      if (shouldMove) {
        desiredMoveDirection.normalize();
        this.tempQuaternion
          .copy(enemy.avatar.group.quaternion)
          .multiply(COMBATANT_MOVEMENT_OFFSET);
        this.tempWorldForward.set(0, 0, -1).applyQuaternion(this.tempQuaternion);
        this.tempWorldForward.y = 0;
        this.tempWorldForward.normalize();
        this.tempLook.crossVectors(this.tempWorldForward, new THREE.Vector3(0, 1, 0)).normalize();

        moveZ = desiredMoveDirection.dot(this.tempWorldForward);
        moveX = desiredMoveDirection.dot(this.tempLook);
        const inputLength = Math.hypot(moveX, moveZ);
        if (inputLength > 0.001) {
          moveX /= inputLength;
          moveZ /= inputLength;
        } else {
          moveX = 0;
          moveZ = 0;
        }
      }

      const jumpReason = this.chooseEnemyJumpReason(
        enemy,
        behavior,
        stance,
        shouldMove,
        targetDistance,
        now,
        tuning,
      );
      const previousX = enemyPosition.x;
      const previousZ = enemyPosition.z;
      this.tempQuaternion
        .copy(enemy.avatar.group.quaternion)
        .multiply(COMBATANT_MOVEMENT_OFFSET);
      const movement = updateSharedMovement(
        enemy.movementState,
        enemyPosition,
        this.tempQuaternion,
        "feet",
        this.collisionWorld,
        delta,
        now,
        {
          enabled: true,
          moveX,
          moveZ,
          crouching: stance === "crouched",
          jumpRequested: jumpReason !== null,
        },
        this.tempForward,
        this.tempRight,
        this.tempEnemyMove,
        PLAYER_RADIUS,
      );
      enemy.qaJumpRequested = false;
      enemy.speed =
        delta > 0
          ? Math.hypot(enemyPosition.x - previousX, enemyPosition.z - previousZ) / delta
          : 0;
      const movedEnemyFeet = new THREE.Vector3(enemyPosition.x, 0, enemyPosition.z);

      if (movement.jumped && jumpReason) {
        enemy.ai.lastJumpReason = jumpReason;
        enemy.ai.jumpCount += 1;
        enemy.ai.lastJumpAt = now;
        if (jumpReason === "stuck-recovery") {
          enemy.ai.lastProgressAt = now;
          enemy.ai.lastProgressPosition.copy(movedEnemyFeet);
        }
      }

      const movedEnough =
        movedEnemyFeet.distanceToSquared(enemy.ai.lastProgressPosition) > 0.08 ||
        enemy.speed > 0.42;
      if (!moveTowardTarget || targetDistance <= 1.1 || movedEnough) {
        enemy.ai.lastProgressAt = now;
        enemy.ai.lastProgressPosition.copy(movedEnemyFeet);
      } else if (now - enemy.ai.lastProgressAt >= tuning.stuckSeconds) {
        const recoveryTarget = this.chooseEnemyRecoveryTarget(enemy, targetPosition);
        if (recoveryTarget) {
          enemy.ai.lastRecoveryReason = "repath";
          enemy.ai.recoveryCount += 1;
          enemy.ai.lastProgressAt = now;
          enemy.ai.lastProgressPosition.copy(movedEnemyFeet);
          this.setEnemyForcedDirective(
            enemy,
            now,
            "reposition",
            "standing",
            recoveryTarget.position,
            recoveryTarget.label,
            tuning.recoveryCommitSeconds,
          );
        } else {
          enemy.ai.lastProgressAt = now;
        }
      }

      if (behavior !== enemy.ai.behavior) {
        enemy.ai.behaviorEnteredAt = now;
        enemy.ai.behaviorHoldUntil = now + tuning.behaviorHoldSeconds;
      }
      enemy.ai.behavior = behavior;
      enemy.ai.stance = stance;
      enemy.ai.targetLabel = targetLabel;
      enemy.ai.targetPosition.copy(targetPosition);

      const currentEnemyEye = this.enemyEyePosition(enemy);
      const lookTarget = canSeePlayer
        ? this.camera.position
        : targetPosition.clone().setY(currentEnemyEye.y);
      const aimPitch = this.aimPitchBetween(currentEnemyEye, lookTarget);
      this.faceCombatantAt(enemy.avatar.group, enemyPosition, lookTarget);
      this.tempLook.copy(lookTarget).sub(currentEnemyEye);
      if (this.tempLook.lengthSq() <= 0.0001) {
        enemy.lookDirection.set(0, 0, 1);
      } else {
        enemy.lookDirection.copy(this.tempLook.normalize());
      }

      const shotProfile =
        canSeePlayer
          ? evaluateEnemyShotProfile({
              distance: playerDistance,
              visibility,
              shooterSpeed: enemy.speed,
              targetSpeed: this.playerSpeed,
              targetCrouching: this.playerCrouching,
              shooterCrouching: movement.crouching,
            }, tuning)
          : null;

      if (canSeePlayer && shotProfile && !previousVisibility) {
        enemy.ai.burstShotsRemaining = 0;
        enemy.nextFireAt = Math.max(enemy.nextFireAt, now + shotProfile.reactionSeconds);
      }

      if (
        canSeePlayer &&
        shouldShoot &&
        shotProfile &&
        enemy.ai.burstShotsRemaining <= 0 &&
        now >= enemy.ai.burstCooldownUntil
      ) {
        this.refillEnemyBurst(enemy);
      }

      if (canSeePlayer && shouldShoot && shotProfile && now >= enemy.nextFireAt) {
        const rolled = rollEnemyShot(enemy.ai.rngState, shotProfile);
        enemy.ai.rngState = rolled.state;
        enemy.ai.shotsFired += 1;
        enemy.ai.burstShotsRemaining = Math.max(0, enemy.ai.burstShotsRemaining - 1);
        enemy.ai.lastShotAt = now;
        enemy.ai.lastShotProfile = shotProfile;
        enemy.ai.lastShotOutcome = rolled.result.hit ? "hit" : "miss";
        enemy.nextFireAt =
          now +
          ENEMY_FIRE_INTERVAL * tuning.fireIntervalMultiplier +
          shotProfile.missChance * 0.16 +
          Math.abs(rolled.result.offsetYawDegrees) * 0.01;
        if (enemy.ai.burstShotsRemaining <= 0) {
          enemy.ai.burstCooldownUntil = now + tuning.burstCooldownSeconds;
        }
        enemy.recoil = 0.8;
        this.recordShotDebug(
          "enemy",
          now,
          enemy.id,
          currentEnemyEye.distanceTo(this.camera.position),
        );
        this.playWorldFireAt(currentEnemyEye);

        if (rolled.result.hit) {
          enemy.ai.shotHits += 1;
          this.applyPlayerDamage(ENEMY_DAMAGE, enemy.name, now);
        } else {
          enemy.ai.shotMisses += 1;
        }
      }

      enemy.moveBlend = THREE.MathUtils.damp(
        enemy.moveBlend,
        enemy.speed > 0.05 ? THREE.MathUtils.lerp(1, 0.72, enemy.movementState.crouchBlend) : 0,
        8,
        delta,
      );
      enemy.avatar.update(
        now,
        enemy.moveBlend,
        true,
        enemy.recoil,
        enemy.hitFlashUntil > now ? 1 : 0,
        aimPitch,
        enemy.movementState.crouchBlend,
        movement.airborne ? 1 : 0,
      );
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
    this.publishHostSnapshot(true);

    if (this.playerHealth <= 0) {
      this.playerDead = true;
      this.playerDeaths += 1;

      if (this.activeMode === "shared" && attackerId) {
        this.awardElimination(attackerId);
      } else {
        const killer = this.enemies.find((enemy) => enemy.name === attacker);
        if (killer) {
          killer.eliminations += 1;
        }
      }

      this.audio.death();
      this.pushFeed(`${attacker} dropped you. Hold for the next round reset.`, 2.6);
      this.publishHostSnapshot(true);
      return;
    }

    this.pushFeed(`${attacker} hit you for ${amount}.`, 0.9);
  }

  private applyRemoteActorDamage(
    actor: RemoteActor,
    amount: number,
    attackerId: string,
    now: number,
  ): void {
    if (actor.status !== "alive") {
      return;
    }

    actor.health = Math.max(0, actor.health - amount);
    actor.hitFlashUntil = now + 0.12;
    actor.lastShotAt = now;

    if (actor.health <= 0) {
      actor.health = 0;
      actor.status = "down";
      actor.deaths += 1;
      actor.inputMovement.set(0, 0);
      actor.inputCrouching = false;
      actor.inputInteracting = false;
      actor.pendingJump = false;
      actor.moveBlend = 0;
      this.awardElimination(attackerId);
    }
  }

  private awardElimination(attackerId: string): void {
    if (attackerId === this.playerIdentity.id) {
      this.playerEliminations += 1;
      return;
    }

    const attacker = this.remoteActors.get(attackerId);
    if (attacker) {
      attacker.eliminations += 1;
    }
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
    if (this.fullscreenNotice && this.fullscreenNotice.expiresAt <= now) {
      this.fullscreenNotice = undefined;
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
          : this.fullscreenNotice?.text ?? this.feedMessage?.text ?? this.defaultStatusLine();

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
      fullscreenActive: document.fullscreenElement === this.fullscreenTarget(),
      fullscreenAvailable: this.fullscreenAvailable(),
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
      const roomTitle = this.sharedRoom?.uiSnapshot.title ?? "Room";
      const roomDetail = this.sharedRoom?.uiSnapshot.detail ?? "";
      if (roomDetail.startsWith("Relay idle warning:")) {
        return roomDetail;
      }
      return this.remoteActors.size > 0
        ? `${roomTitle} live on ${this.map.name}: host-authoritative positions, roster, and round state are syncing.`
        : this.sharedRole === "host"
          ? `${roomTitle} live on ${this.map.name}. Another operator can join and enter the arena.`
          : `${roomTitle} live on ${this.map.name}. Waiting for host snapshots.`;
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

  private publishHostSnapshot(force = false): void {
    if (this.activeMode !== "shared" || this.sharedRole !== "host" || !this.sharedRoom) {
      return;
    }

    this.sharedRoom.publishHostSnapshot(this.buildHostSnapshot(), force);
  }

  private buildHostSnapshot(): HostRoomSnapshot {
    const now = Date.now();
    const roundNow = this.roundNow();
    const objectiveHud = this.objectiveHudSnapshot(roundNow);
    const objectiveDetail =
      this.roundState.phase === "resolution"
        ? this.roundState.resolutionLabel
        : objectiveHud.progressLabel ||
          objectiveHud.status ||
          this.roundState.activeMission.summary;
    const phase =
      this.roundState.phase === "resolution"
        ? "ended"
        : this.remoteActors.size > 0
          ? "active"
          : "waiting";
    const roundPhase =
      this.roundState.phase === "briefing"
        ? "staging"
        : this.roundState.phase === "active"
          ? "live"
          : "reset";

    return {
      snapshotId: this.nextHostSnapshotId++,
      hostPeerId: this.playerIdentity.id,
      phase,
      roundPhase,
      objective: {
        objectiveId: `${this.roundState.activeMission.missionType}:${this.roundState.activeMission.objectiveLabel}`,
        phase: objectiveHud.status || this.roundState.phase,
        value: Number(objectiveHud.progress.toFixed(4)),
        detail: objectiveDetail,
        state: {
          round: serializeRoundState(this.roundState),
          bomb: serializeBombRuntimeState(this.bombState),
          hostage: serializeHostageRuntimeState(this.hostageState),
        },
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
      team: this.localTeamId,
      joinedAt: localParticipant?.joinedAt ?? now,
      health: this.playerHealth,
      eliminations: this.playerEliminations,
      deaths: this.playerDeaths,
      status: this.playerDead ? "down" : "alive",
      position: [
        Number(this.camera.position.x.toFixed(3)),
        Number(this.camera.position.y.toFixed(3)),
        Number(this.camera.position.z.toFixed(3)),
      ],
      look: [
        Number(this.tempLook.x.toFixed(4)),
        Number(this.tempLook.y.toFixed(4)),
        Number(this.tempLook.z.toFixed(4)),
      ],
      respawnAt: 0,
      lastProcessedInputSequence: 0,
      updatedAt: now,
    };
  }

  private buildRemotePresenceSnapshot(
    actor: RemoteActor,
    now: number,
  ): HostRoomSnapshot["roster"][number] {
    const remoteEyeHeight = currentEyeHeight(actor.movementState);
    return {
      id: actor.id,
      name: actor.name,
      accentColor: actor.accentColor,
      team: actor.teamId,
      joinedAt: actor.joinedAt,
      health: actor.health,
      eliminations: actor.eliminations,
      deaths: actor.deaths,
      status: actor.status,
      position: [
        Number(actor.targetPosition.x.toFixed(3)),
        Number((actor.targetPosition.y + remoteEyeHeight).toFixed(3)),
        Number(actor.targetPosition.z.toFixed(3)),
      ],
      look: [
        Number(actor.lookDirection.x.toFixed(4)),
        Number(actor.lookDirection.y.toFixed(4)),
        Number(actor.lookDirection.z.toFixed(4)),
      ],
      respawnAt: 0,
      lastProcessedInputSequence: actor.lastProcessedInputSequence,
      updatedAt: now,
    };
  }

  private inputCaptured(): boolean {
    return this.controls.isLocked || this.fallbackLookEnabled;
  }

  private fullscreenTarget(): HTMLElement | null {
    return this.host.closest<HTMLElement>("[data-world-shell]");
  }

  private fullscreenAvailable(): boolean {
    const target = this.fullscreenTarget();
    return Boolean(
      target?.isConnected &&
        document.fullscreenEnabled &&
        typeof target.requestFullscreen === "function" &&
        typeof document.exitFullscreen === "function",
    );
  }

  private pushFullscreenNotice(text: string): void {
    this.fullscreenNotice = {
      text,
      expiresAt: this.gameNow() + 2,
    };
    this.emitSnapshot();
  }

  private crouchHeld(): boolean {
    return (
      hasAnyKey(this.movementKeys, CROUCH_KEY_CODES) ||
      (this.classicCrouchAlias && hasAnyKey(this.movementKeys, CLASSIC_CROUCH_KEY_CODES))
    );
  }

  private shotDebugSnapshot(): Record<string, unknown> {
    const now = this.gameNow();
    const ago = (at: number): number | null =>
      at > Number.NEGATIVE_INFINITY ? Number((now - at).toFixed(2)) : null;

    return {
      localSequence: this.localShotSequence,
      lastLocalShotAgo: ago(this.lastLocalShotAt),
      lastSharedShotSentAgo: ago(this.lastSharedShotSentAt),
      lastRoomShotReceivedAgo: ago(this.lastRoomShotReceivedAt),
      events: this.shotDebugEvents.map((event) => ({ ...event })),
    };
  }

  private recordShotDebug(
    type: ShotDebugEvent["type"],
    at: number,
    sourceId: string | null,
    distance: number | null = null,
  ): void {
    this.shotDebugEvents.push({
      type,
      at: Number(at.toFixed(3)),
      sourceId,
      distance: distance === null ? null : Number(distance.toFixed(2)),
    });

    if (this.shotDebugEvents.length > 32) {
      this.shotDebugEvents.splice(0, this.shotDebugEvents.length - 32);
    }
  }

  private applyRemoteLook(actor: RemoteActor, look: [number, number, number]): void {
    this.tempLook.set(look[0], look[1], look[2]);
    if (this.tempLook.lengthSq() <= 0.0001) {
      return;
    }

    actor.lookDirection.copy(this.tempLook.normalize());
    actor.aimPitch = this.aimPitchFromLook(actor.lookDirection);

    this.tempLook.set(actor.lookDirection.x, 0, actor.lookDirection.z);
    if (this.tempLook.lengthSq() > 0.0001) {
      actor.forward.copy(this.tempLook.normalize());
    }

    this.syncRemoteActorAim(actor, this.gameNow());
  }

  private syncRemoteActorAim(actor: RemoteActor, now: number): void {
    const facing = actor.forward.lengthSq() > 0.01 ? actor.forward : this.tempLook.set(0, 0, 1);
    this.setCombatantYawFromDirection(actor.avatar.group, facing.x, facing.z);
    actor.avatar.update(
      now,
      actor.moveBlend,
      actor.status === "alive",
      actor.recoil,
      actor.hitFlashUntil > now ? 1 : 0,
      actor.aimPitch,
      actor.movementState.crouchBlend,
      actor.movementState.grounded ? 0 : 1,
    );
  }

  private aimPitchFromLook(look: THREE.Vector3): number {
    return THREE.MathUtils.clamp(
      Math.asin(THREE.MathUtils.clamp(look.y, -1, 1)),
      -COMBATANT_AIM_PITCH_LIMIT,
      COMBATANT_AIM_PITCH_LIMIT,
    );
  }

  private aimPitchBetween(origin: THREE.Vector3, target: THREE.Vector3): number {
    this.tempLook.copy(target).sub(origin);
    if (this.tempLook.lengthSq() <= 0.0001) {
      return 0;
    }

    return this.aimPitchFromLook(this.tempLook.normalize());
  }

  private playWorldFireAt(position: THREE.Vector3): void {
    this.tempAudioOffset.copy(position).sub(this.camera.position);
    const distance = this.tempAudioOffset.length();
    let pan = 0;

    if (distance > 0.001) {
      this.tempWorldForward.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
      pan = THREE.MathUtils.clamp(
        this.tempAudioOffset.normalize().dot(this.tempWorldForward),
        -0.85,
        0.85,
      );
    }

    this.audio.worldFire(distance, pan);
  }

  private setCombatantYawFromDirection(
    group: THREE.Object3D,
    directionX: number,
    directionZ: number,
  ): void {
    if (directionX * directionX + directionZ * directionZ <= 0.0001) {
      group.rotation.x = 0;
      group.rotation.z = 0;
      return;
    }

    // Combatant bodies are authored with their readable front and rifle on local +Z.
    group.rotation.set(0, Math.atan2(directionX, directionZ), 0);
  }

  private faceCombatantAt(
    group: THREE.Object3D,
    origin: THREE.Vector3,
    target: THREE.Vector3,
  ): void {
    this.setCombatantYawFromDirection(group, target.x - origin.x, target.z - origin.z);
  }

  private weaponViewSnapshot(): Record<string, unknown> {
    this.camera.updateMatrixWorld(true);
    this.weaponRig.muzzle.updateWorldMatrix(true, false);

    const muzzleCameraPosition = this.weaponRig.muzzle.getWorldPosition(new THREE.Vector3());
    this.camera.worldToLocal(muzzleCameraPosition);

    const barrelForward = new THREE.Vector3(0, 0, -1)
      .applyEuler(this.weaponRig.group.rotation)
      .normalize();
    const rootPosition = this.weaponRig.group.position;

    return {
      rootPosition: this.toPoint(rootPosition),
      rootRotation: this.toRotation(this.weaponRig.group.rotation),
      barrelForward: this.toPoint(barrelForward),
      muzzleCameraPosition: this.toPoint(muzzleCameraPosition),
      lowRight: rootPosition.x > 0.28 && rootPosition.y < -0.25 && rootPosition.z < -0.35,
      forwardAligned: barrelForward.z < -0.94,
      muzzleAheadOfRoot: muzzleCameraPosition.z < rootPosition.z - 0.18,
      muzzleFlashActive: this.muzzleFlashUntil > this.gameNow(),
      muzzleFlashRecent: this.muzzleFlashUntil > 0 && this.gameNow() <= this.muzzleFlashUntil + 0.35,
      flashVisible: this.weaponRig.flash.visible,
    };
  }

  private combatantPostureSnapshot(
    group: THREE.Object3D,
    alive: boolean,
  ): Record<string, unknown> {
    const feetY = Number(group.position.y.toFixed(3));
    const rootPitch = Number(group.rotation.x.toFixed(4));
    const rootRoll = Number(group.rotation.z.toFixed(4));

    return {
      rotation: this.toRotation(group.rotation),
      feetY,
      upright: !alive || (Math.abs(rootPitch) <= 0.01 && Math.abs(rootRoll) <= 0.08),
      aboveGround: !alive || feetY >= -0.01,
    };
  }

  private combatantVisualSnapshot(avatar: CombatantAvatar): Record<string, unknown> {
    return {
      teamId: avatar.style.teamId,
      jacketColor: avatar.style.jacketColor,
      vestColor: avatar.style.vestColor,
      trouserColor: avatar.style.trouserColor,
      detailColor: avatar.style.detailColor,
      hasDominoMask: avatar.style.hasDominoMask,
    };
  }

  private combatantAimSnapshot(
    avatar: CombatantAvatar,
    expectedLook: THREE.Vector3,
  ): Record<string, unknown> {
    this.scene.updateMatrixWorld(true);

    const expected = expectedLook.clone();
    if (expected.lengthSq() <= 0.0001) {
      expected.set(0, 0, 1);
    } else {
      expected.normalize();
    }

    const expectedHorizontal = expected.clone().setY(0);
    if (expectedHorizontal.lengthSq() <= 0.0001) {
      expectedHorizontal.set(0, 0, 1);
    } else {
      expectedHorizontal.normalize();
    }

    const bodyForward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(avatar.group.getWorldQuaternion(this.tempQuaternion))
      .normalize();
    const weaponForward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(avatar.weaponAimPivot.getWorldQuaternion(this.tempQuaternion))
      .normalize();

    return {
      expectedLook: this.toPoint(expected),
      bodyForward: this.toPoint(bodyForward),
      weaponForward: this.toPoint(weaponForward),
      bodyDot: Number(bodyForward.dot(expectedHorizontal).toFixed(3)),
      weaponDot: Number(weaponForward.dot(expected).toFixed(3)),
      weaponTracksPitch: Math.abs(weaponForward.y - expected.y) <= 0.05,
    };
  }

  private enemyEyeHeight(enemy: EnemyActor, stance = enemy.ai.stance): number {
    if (stance === enemy.ai.stance) {
      return currentEyeHeight(enemy.movementState);
    }

    return stance === "crouched" ? CROUCH_EYE_HEIGHT : STANDING_EYE_HEIGHT;
  }

  private enemyEyePosition(enemy: EnemyActor, stance = enemy.ai.stance): THREE.Vector3 {
    return enemy.avatar.group.position.clone().setY(this.enemyEyeHeight(enemy, stance));
  }

  private enemyBodyHeight(enemy: EnemyActor, stance = enemy.ai.stance): number {
    if (stance === enemy.ai.stance) {
      return currentBodyHeight(enemy.movementState);
    }

    return stance === "crouched" ? CROUCH_BODY_HEIGHT : STANDING_BODY_HEIGHT;
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
    this.queueEnemyContact(enemy, enemy.ai.lastKnownPlayerPosition, now, "damage");
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

  private findAiCommunicationCase():
    | {
        observerEnemyId: string;
        receiverEnemyId: string;
        observerPosition: THREE.Vector3;
        receiverPosition: THREE.Vector3;
        playerPosition: THREE.Vector3;
        blockerName: string;
      }
    | null {
    if (this.enemies.length < 2) {
      return null;
    }

    const sightlineCase = this.findAiSightlineCase();
    if (!sightlineCase) {
      return null;
    }

    const observer = this.objectiveEnemyById(sightlineCase.enemyId);
    const receiver = this.enemies.find(
      (enemy) => enemy.alive && enemy.id !== sightlineCase.enemyId,
    );
    if (!observer || !receiver) {
      return null;
    }

    const playerEyeHeight = currentEyeHeight(this.movementState);
    const playerVisibilityPoints = buildVisibilityPoints(
      sightlineCase.clearPlayerPosition,
      playerEyeHeight,
      false,
    );
    const receiverAnchor = [...this.tacticalProfile.anchors]
      .filter((anchor) => {
        if (anchor.position.distanceTo(sightlineCase.clearPlayerPosition) <= PLAYER_NOISE_HEARING_RADIUS + 1.2) {
          return false;
        }

        if (anchor.position.distanceTo(sightlineCase.enemyPosition) < 5) {
          return false;
        }

        const visibility = evaluateVisibility(
          this.collisionWorld,
          anchor.position.clone().setY(STANDING_EYE_HEIGHT),
          playerVisibilityPoints,
        );
        return visibility <= 0.05;
      })
      .sort(
        (left, right) =>
          left.position.distanceToSquared(sightlineCase.clearPlayerPosition) -
          right.position.distanceToSquared(sightlineCase.clearPlayerPosition),
      )[0];

    if (!receiverAnchor) {
      return null;
    }

    return {
      observerEnemyId: observer.id,
      receiverEnemyId: receiver.id,
      observerPosition: sightlineCase.enemyPosition.clone(),
      receiverPosition: receiverAnchor.position.clone(),
      playerPosition: sightlineCase.clearPlayerPosition.clone(),
      blockerName: sightlineCase.blockerName,
    };
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

      const enemyEye = enemyAnchor.position.clone().setY(STANDING_EYE_HEIGHT);

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
    return this.findDebugPair(true);
  }

  private findDebugPair(requireLineOfSight: boolean): [THREE.Vector3, THREE.Vector3] | null {
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
        const minDistance = requireLineOfSight ? 6 : 4;
        const maxDistance = requireLineOfSight ? 20 : 28;

        if (distance < minDistance || distance > maxDistance) {
          continue;
        }

        const eyeHeight = currentEyeHeight(this.movementState);
        const startView = start.clone().setY(eyeHeight);
        const endView = end.clone().setY(eyeHeight);
        const visible = hasLineOfSight(this.collisionWorld, startView, endView);
        if (visible !== requireLineOfSight) {
          continue;
        }

        if (requireLineOfSight && !this.hasDebugSightline(startView, endView)) {
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
          currentBodyHeight(this.movementState),
        ),
        findOpenGroundPosition(
          this.collisionWorld,
          new THREE.Vector3(15, 0, 3),
          PLAYER_RADIUS,
          currentBodyHeight(this.movementState),
        ),
      ];
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

  private toRotation(euler: THREE.Euler): { x: number; y: number; z: number } {
    return {
      x: Number(euler.x.toFixed(4)),
      y: Number(euler.y.toFixed(4)),
      z: Number(euler.z.toFixed(4)),
    };
  }
}
