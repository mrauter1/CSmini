import "./styles.css";

import { TacticalShellApp } from "./ui/app";
import type { RoomConnectionKind } from "./net/matchRoomConnection";

declare global {
  interface Window {
    __dustlineQa__?: {
      openMap: (mapId: string, mode: "shared" | "local") => void;
      openRoomSetup: (mapId: string, kind?: RoomConnectionKind) => void;
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
      aimAt: (combatantId: string) => boolean;
      probeShot: () => {
        direction: { x: number; y: number; z: number };
        hits: Array<{ combatantId: string | null; objectName: string; distance: number }>;
      } | null;
      sharedTarget: () => string | null;
      fire: () => void;
      forcePlayerDeath: (attackerName?: string) => void;
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
    aimAt: (combatantId) => app.debugAimAt(combatantId),
    probeShot: () => app.debugProbeShot(),
    sharedTarget: () => app.debugSharedTarget(),
    fire: () => app.debugFire(),
    forcePlayerDeath: (attackerName) => app.debugForcePlayerDeath(attackerName),
  };
}

window.addEventListener("beforeunload", () => {
  app.dispose();
});
