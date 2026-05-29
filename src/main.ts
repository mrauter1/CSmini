import "./styles.css";

import { TacticalShellApp } from "./ui/app";
import type { RoomConnectionKind } from "./net/matchRoomConnection";

declare global {
  interface Window {
    __dustlineQa__?: {
      openMap: (mapId: string, mode: "shared" | "local") => void;
      openRoomSetup: (mapId: string, kind?: RoomConnectionKind) => void;
      getRoomCode: () => string | null;
      joinSignalingRoom: (roomCode: string) => boolean;
      sendRawRoomMessage: (raw: string, toPeerId?: string) => boolean;
      sendSignalingPayload: (payload: Record<string, unknown>) => boolean;
      injectSignalingMessage: (raw: string) => boolean;
      createRoomOffer: () => Promise<string | null>;
      applyRoomAnswer: (answer: string) => Promise<boolean>;
      generateRoomAnswer: (offer: string) => Promise<string | null>;
      enterArena: () => boolean;
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
      ) =>
        | {
            self: { x: number; y: number; z: number };
            target: { x: number; y: number; z: number };
          }
        | null;
      stageBlockedSharedShot: (
        slot: 0 | 1,
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
      fire: () => void;
      submitShotClaim: (overrides?: {
        tick?: number;
        ammoInClip?: number;
        reserveAmmo?: number;
        reloadSequence?: number;
        spreadIndex?: number;
        inputSequence?: number;
        weaponId?: string;
        origin?: { x: number; y: number; z: number };
        direction?: { x: number; y: number; z: number };
      }) => boolean;
      startReload: () => void;
      forcePlayerDeath: (attackerName?: string) => void;
      setInputState: (movementX: number, movementZ: number, sprint?: boolean) => void;
      setInputTickPaused: (paused: boolean) => void;
      sendInputTick: (movementX: number, movementZ: number, sprint?: boolean) => boolean;
      clearInputState: () => void;
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
    sendSignalingPayload: (payload) => app.debugSendSignalingPayload(payload),
    injectSignalingMessage: (raw) => app.debugInjectSignalingMessage(raw),
    createRoomOffer: () => app.debugCreateRoomOffer(),
    applyRoomAnswer: (answer) => app.debugApplyRoomAnswer(answer),
    generateRoomAnswer: (offer) => app.debugGenerateRoomAnswer(offer),
    enterArena: () => app.debugEnterArena(),
    returnToCatalog: () => app.debugReturnToCatalog(),
    getState: () => app.debugGetState(),
    engageControls: () => app.debugEngageControls(),
    setPose: (x, z, yaw, pitch) => app.debugSetPose(x, z, yaw, pitch),
    setCameraPose: (x, y, z, yaw, pitch) => app.debugSetCameraPose(x, y, z, yaw, pitch),
    setView: (x, y, z, targetX, targetY, targetZ) =>
      app.debugSetView(x, y, z, targetX, targetY, targetZ),
    stageSharedDuel: (slot) => app.debugStageSharedDuel(slot),
    stageBlockedSharedShot: (slot) => app.debugStageBlockedSharedShot(slot),
    stageAuthoritativeSharedPair: (kind) => app.debugStageAuthoritativeSharedPair(kind),
    aimAt: (combatantId) => app.debugAimAt(combatantId),
    probeShot: () => app.debugProbeShot(),
    sharedTarget: () => app.debugSharedTarget(),
    fire: () => app.debugFire(),
    submitShotClaim: (overrides) => app.debugSubmitShotClaim(overrides),
    startReload: () => app.debugStartReload(),
    forcePlayerDeath: (attackerName) => app.debugForcePlayerDeath(attackerName),
    setInputState: (movementX, movementZ, sprint) =>
      app.debugSetInputState(movementX, movementZ, sprint),
    setInputTickPaused: (paused) => app.debugSetInputTickPaused(paused),
    sendInputTick: (movementX, movementZ, sprint) =>
      app.debugSendInputTick(movementX, movementZ, sprint),
    clearInputState: () => app.debugClearInputState(),
  };
}

window.addEventListener("beforeunload", () => {
  app.dispose();
});
