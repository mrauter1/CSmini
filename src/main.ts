import "./styles.css";

import type { BotDifficulty } from "./game/botDifficulty";
import type {
  LatestStateQaConfig,
  LatestStateQaDirection,
  RelayIdleQaConfig,
  RoomConnectionKind,
} from "./net/matchRoomConnection";
import { TacticalShellApp } from "./ui/app";
import type { TeamPreference } from "./types";

declare global {
  interface Window {
    __dustlineQa__?: {
      openMap: (mapId: string, mode: "shared" | "local") => void;
      openRoomSetup: (mapId: string, kind?: RoomConnectionKind) => void;
      getRoomCode: () => string | null;
      joinSignalingRoom: (roomCode: string) => boolean;
      sendRawRoomMessage: (raw: string, toPeerId?: string) => boolean;
      configureLatestStateQa: (
        direction: LatestStateQaDirection,
        config?: LatestStateQaConfig | null,
      ) => boolean;
      configureRelayIdleQa: (config?: RelayIdleQaConfig | null) => boolean;
      sendSignalingPayload: (payload: Record<string, unknown>) => boolean;
      injectSignalingMessage: (raw: string) => boolean;
      createRoomOffer: () => Promise<string | null>;
      applyRoomAnswer: (answer: string) => Promise<boolean>;
      generateRoomAnswer: (offer: string) => Promise<string | null>;
      enterArena: () => boolean;
      setTeamPreference: (teamPreference: TeamPreference) => void;
      setBotDifficulty: (botDifficulty: BotDifficulty) => void;
      returnToCatalog: () => void;
      getState: () => Record<string, unknown> | null;
      engageControls: () => void;
      setPose: (x: number, z: number, yaw: number, pitch?: number) => void;
      setCameraPose: (
        x: number,
        y: number,
        z: number,
        yaw: number,
        pitch?: number,
      ) => void;
      stageSharedRemotePose: (
        peerId: string,
        x: number,
        y: number,
        z: number,
        yaw?: number,
      ) => boolean;
      startSharedRemoteObjectiveAction: (peerId: string) => boolean;
      completeSharedRemoteObjectiveAction: (peerId: string) => boolean;
      setView: (
        x: number,
        y: number,
        z: number,
        targetX: number,
        targetY: number,
        targetZ: number,
      ) => void;
      stageSharedDuel: (
        slot: 0 | 1,
        aimOffsetY?: number,
      ) =>
        | {
            self: { x: number; y: number; z: number };
            target: { x: number; y: number; z: number };
          }
        | null;
      stageAuthoritativeSharedPair: (
        kind: "clear" | "blocked",
      ) =>
        | {
            host: { x: number; y: number; z: number };
            guest: { x: number; y: number; z: number };
            guestId: string;
          }
        | null;
      aimAt: (combatantId: string) => boolean;
      probeShot: () => {
        direction: { x: number; y: number; z: number };
        hits: Array<{ combatantId: string | null; objectName: string; distance: number }>;
      } | null;
      sharedTarget: () => string | null;
      stageAiSightlineCase: () =>
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
        | null;
      stageAiCommunicationCase: () =>
        | {
            observerEnemyId: string;
            receiverEnemyId: string;
            playerPosition: { x: number; y: number; z: number };
            observerPosition: { x: number; y: number; z: number };
            receiverPosition: { x: number; y: number; z: number };
            blockerName: string;
          }
        | null;
      stageAiRecoveryCase: () =>
        | {
            enemyId: string;
            enemyLabel: string;
            blockerName: string;
            targetLabel: string;
            enemyPosition: { x: number; y: number; z: number };
            blockedTargetPosition: { x: number; y: number; z: number };
          }
        | null;
      stageEnemyBombPlantCase: () =>
        | {
            carrierEnemyId: string;
            siteLabel: string;
            sitePosition: { x: number; y: number; z: number };
          }
        | null;
      stageEnemyRelayRouteCase: () =>
        | {
            carrierEnemyId: string;
            supportEnemyIds: string[];
            siteLabel: string;
            sitePosition: { x: number; y: number; z: number };
          }
        | null;
      stageEnemyRelayDefuseCase: () =>
        | {
            defuserEnemyId: string;
            siteLabel: string;
            sitePosition: { x: number; y: number; z: number };
          }
        | null;
      stageEnemyHostageEscortCase: () =>
        | {
            rescuerEnemyId: string;
            supportEnemyIds: string[];
            clusterLabel: string;
            extractionLabel: string;
            routeLabels: string[];
            clusterPosition: { x: number; y: number; z: number };
            extractionPosition: { x: number; y: number; z: number };
          }
        | null;
      evaluateEnemyShot: (
        combatantId: string,
        overrides?: Partial<{
          distance: number;
          visibility: number;
          targetSpeed: number;
          shooterSpeed: number;
          targetCrouching: boolean;
          shooterCrouching: boolean;
        }>,
      ) =>
        | {
            distance: number;
            visibility: number;
            shooterSpeed: number;
            targetSpeed: number;
            targetCrouching: boolean;
            shooterCrouching: boolean;
            reactionSeconds: number;
            spreadDegrees: number;
            hitChance: number;
            missChance: number;
          }
        | null;
      fire: () => void;
      forcePlayerDeath: (attackerName?: string) => void;
      setInputState: (
        movementX: number,
        movementZ: number,
        crouching?: boolean,
        jumpRequested?: boolean,
      ) => void;
      setInputTickPaused: (paused: boolean) => void;
      sendInputTick: (
        movementX: number,
        movementZ: number,
        crouching?: boolean,
        jumpRequested?: boolean,
      ) => boolean;
      submitShotClaim: (overrides?: {
        tick?: number;
        origin?: { x: number; y: number; z: number };
        direction?: { x: number; y: number; z: number };
        ammoInClip?: number;
        reserveAmmo?: number;
        reloadSequence?: number;
        spreadIndex?: number;
        inputSequence?: number;
        weaponId?: string;
      }) => boolean;
      clearInputState: () => void;
      forceNextRound: () => void;
      forceRoundActive: () => void;
      setInvulnerable: (enabled: boolean) => void;
      startObjectiveAction: () => boolean;
      setKey: (code: string, active: boolean) => void;
      jump: () => void;
      jumpSample: () =>
        | {
            peakY: number;
            landedY: number;
            landed: boolean;
            airborneSeconds: number;
          }
        | null;
      requestEnemyJump: (combatantId: string) => boolean;
      enemyMovementSample: (
        combatantId: string,
      ) =>
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
        | null;
    };
  }
}

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root");
}

const app = new TacticalShellApp(root);
app.mount();

if (navigator.webdriver || new URLSearchParams(window.location.search).has("qa")) {
  window.__dustlineQa__ = {
    openMap: (mapId, mode) => app.debugOpenMap(mapId, mode),
    openRoomSetup: (mapId, kind) => app.debugOpenRoomSetup(mapId, kind),
    getRoomCode: () => app.debugGetRoomCode(),
    joinSignalingRoom: (roomCode) => app.debugJoinSignalingRoom(roomCode),
    sendRawRoomMessage: (raw, toPeerId) => app.debugSendRawRoomMessage(raw, toPeerId),
    configureLatestStateQa: (direction, config) => app.debugConfigureLatestStateQa(direction, config),
    configureRelayIdleQa: (config) => app.debugConfigureRelayIdleQa(config),
    sendSignalingPayload: (payload) => app.debugSendSignalingPayload(payload),
    injectSignalingMessage: (raw) => app.debugInjectSignalingMessage(raw),
    createRoomOffer: () => app.debugCreateRoomOffer(),
    applyRoomAnswer: (answer) => app.debugApplyRoomAnswer(answer),
    generateRoomAnswer: (offer) => app.debugGenerateRoomAnswer(offer),
    enterArena: () => app.debugEnterArena(),
    setTeamPreference: (teamPreference) => app.debugSetTeamPreference(teamPreference),
    setBotDifficulty: (botDifficulty) => app.debugSetBotDifficulty(botDifficulty),
    returnToCatalog: () => app.debugReturnToCatalog(),
    getState: () => app.debugGetState(),
    engageControls: () => app.debugEngageControls(),
    setPose: (x, z, yaw, pitch) => app.debugSetPose(x, z, yaw, pitch),
    setCameraPose: (x, y, z, yaw, pitch) => app.debugSetCameraPose(x, y, z, yaw, pitch),
    stageSharedRemotePose: (peerId, x, y, z, yaw) =>
      app.debugStageSharedRemotePose(peerId, x, y, z, yaw),
    startSharedRemoteObjectiveAction: (peerId) =>
      app.debugStartSharedRemoteObjectiveAction(peerId),
    completeSharedRemoteObjectiveAction: (peerId) =>
      app.debugCompleteSharedRemoteObjectiveAction(peerId),
    setView: (x, y, z, targetX, targetY, targetZ) =>
      app.debugSetView(x, y, z, targetX, targetY, targetZ),
    stageSharedDuel: (slot, aimOffsetY) => app.debugStageSharedDuel(slot, aimOffsetY),
    stageAuthoritativeSharedPair: (kind) => app.debugStageAuthoritativeSharedPair(kind),
    aimAt: (combatantId) => app.debugAimAt(combatantId),
    probeShot: () => app.debugProbeShot(),
    sharedTarget: () => app.debugSharedTarget(),
    stageAiSightlineCase: () => app.debugStageAiSightlineCase(),
    stageAiCommunicationCase: () => app.debugStageAiCommunicationCase(),
    stageAiRecoveryCase: () => app.debugStageAiRecoveryCase(),
    stageEnemyBombPlantCase: () => app.debugStageEnemyBombPlantCase(),
    stageEnemyRelayRouteCase: () => app.debugStageEnemyRelayRouteCase(),
    stageEnemyRelayDefuseCase: () => app.debugStageEnemyRelayDefuseCase(),
    stageEnemyHostageEscortCase: () => app.debugStageEnemyHostageEscortCase(),
    evaluateEnemyShot: (combatantId, overrides) => app.debugEvaluateEnemyShot(combatantId, overrides),
    fire: () => app.debugFire(),
    forcePlayerDeath: (attackerName) => app.debugForcePlayerDeath(attackerName),
    setInputState: (movementX, movementZ, crouching, jumpRequested) =>
      app.debugSetInputState(movementX, movementZ, crouching, jumpRequested),
    setInputTickPaused: (paused) => app.debugSetInputTickPaused(paused),
    sendInputTick: (movementX, movementZ, crouching, jumpRequested) =>
      app.debugSendInputTick(movementX, movementZ, crouching, jumpRequested),
    submitShotClaim: (overrides) => app.debugSubmitShotClaim(overrides),
    clearInputState: () => app.debugClearInputState(),
    forceNextRound: () => app.debugForceNextRound(),
    forceRoundActive: () => app.debugForceRoundActive(),
    setInvulnerable: (enabled) => app.debugSetInvulnerable(enabled),
    startObjectiveAction: () => app.debugStartObjectiveAction(),
    setKey: (code, active) => app.debugSetKey(code, active),
    jump: () => app.debugJump(),
    jumpSample: () => app.debugJumpSample(),
    requestEnemyJump: (combatantId) => app.debugRequestEnemyJump(combatantId),
    enemyMovementSample: (combatantId) => app.debugEnemyMovementSample(combatantId),
  };
}

window.addEventListener("beforeunload", () => {
  app.dispose();
});
