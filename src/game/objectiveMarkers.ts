import * as THREE from "three";

import type { MapDefinition, TeamId, Vec3 } from "../types";
import type { BombRuntimeState } from "./bombState";
import type { HostageRuntimeState } from "./hostageState";
import type { RoundState } from "./rounds";

export type ObjectiveMarkerKind =
  | "relay-site"
  | "hostage-cluster"
  | "extraction-zone"
  | "escort-route";

export interface ObjectiveMarkerDebugEntry {
  id: string;
  kind: ObjectiveMarkerKind;
  label: string;
  focusId: string;
  position: Vec3;
  radius: number;
  active: boolean;
  visible: boolean;
  phase: string;
  teamRole: "attacker" | "defender" | "neutral";
  stateHint: string;
  hudLabelMatch: boolean;
}

export interface ObjectiveMarkerDebugState {
  readyForWorldMarkers: boolean;
  activeMissionType: RoundState["activeMission"]["missionType"];
  activeObjectiveLabel: string;
  entries: ObjectiveMarkerDebugEntry[];
}

interface MarkerRecord {
  id: string;
  kind: ObjectiveMarkerKind;
  label: string;
  focusId: string;
  radius: number;
  group: THREE.Group;
  ringMaterial: THREE.MeshStandardMaterial;
  plateMaterial: THREE.MeshStandardMaterial;
  signMaterial: THREE.MeshBasicMaterial;
  statePanelMaterial: THREE.MeshStandardMaterial;
  statePanel: THREE.Mesh;
}

export interface ObjectiveMarkerSet {
  group: THREE.Group;
  records: MarkerRecord[];
}

const RELAY_COLOR = "#B88B45";
const HOSTAGE_COLOR = "#6F8A5E";
const EXTRACTION_COLOR = "#5F8195";
const ROUTE_COLOR = "#8B7B5C";

function markerColor(kind: ObjectiveMarkerKind): string {
  if (kind === "relay-site") {
    return RELAY_COLOR;
  }
  if (kind === "hostage-cluster") {
    return HOSTAGE_COLOR;
  }
  if (kind === "extraction-zone") {
    return EXTRACTION_COLOR;
  }
  return ROUTE_COLOR;
}

function focusPosition(map: MapDefinition, focusId: string): Vec3 {
  const focus = map.scene.focusPoints.find((entry) => entry.id === focusId);
  if (!focus) {
    return [0, 0, 0];
  }

  return [focus.target[0], 0, focus.target[2]];
}

function makeMaterial(color: string, opacity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
}

function makeLabelMaterial(label: string, color: string): THREE.MeshBasicMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "rgba(20, 18, 14, 0.86)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = color;
    context.lineWidth = 6;
    context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
    context.fillStyle = "#E5D2A5";
    context.font = "bold 24px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.toUpperCase(), canvas.width / 2, canvas.height / 2, canvas.width - 28);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
  });
}

function createMarkerRecord(input: {
  id: string;
  kind: ObjectiveMarkerKind;
  label: string;
  focusId: string;
  radius: number;
  position: Vec3;
}): MarkerRecord {
  const color = markerColor(input.kind);
  const group = new THREE.Group();
  group.name = `objective marker ${input.label}`;
  group.position.set(input.position[0], 0, input.position[2]);

  const ringMaterial = makeMaterial(color, 0.36);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.7, input.radius - 0.42), input.radius, 36),
    ringMaterial,
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.045;
  ring.receiveShadow = true;
  group.add(ring);

  const plateMaterial = makeMaterial(color, 0.58);
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(4.8, input.radius * 1.25), 0.08, 0.62),
    plateMaterial,
  );
  plate.position.y = 0.08;
  plate.rotation.y = input.kind === "extraction-zone" ? Math.PI / 2 : 0;
  plate.receiveShadow = true;
  group.add(plate);

  const statePanelMaterial = makeMaterial("#4C4236", 0.86);
  const statePanel = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.55, 0.16),
    statePanelMaterial,
  );
  statePanel.position.set(input.radius * 0.54, 0.36, -input.radius * 0.35);
  statePanel.castShadow = true;
  group.add(statePanel);

  if (input.kind === "hostage-cluster") {
    for (const offset of [-0.85, 0.85]) {
      const barrier = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.42, 0.28),
        makeMaterial("#6B5E49", 1),
      );
      barrier.position.set(offset, 0.21, input.radius * 0.42);
      barrier.castShadow = true;
      group.add(barrier);
    }
  }

  if (input.kind === "extraction-zone") {
    const threshold = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.16, Math.max(3.2, input.radius * 1.2)),
      makeMaterial("#C3A967", 0.82),
    );
    threshold.position.set(-input.radius * 0.38, 0.1, 0);
    threshold.receiveShadow = true;
    group.add(threshold);
  }

  const signMaterial = makeLabelMaterial(input.label, color);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.05), signMaterial);
  sign.position.set(-input.radius * 0.48, 1.02, input.radius * 0.44);
  sign.rotation.y = Math.PI * 0.18;
  sign.castShadow = false;
  group.add(sign);

  const reverseSign = sign.clone();
  reverseSign.position.set(input.radius * 0.48, 1.02, -input.radius * 0.44);
  reverseSign.rotation.y = Math.PI + Math.PI * 0.18;
  group.add(reverseSign);

  return {
    ...input,
    group,
    ringMaterial,
    plateMaterial,
    signMaterial,
    statePanelMaterial,
    statePanel,
  };
}

export function createObjectiveMarkerSet(map: MapDefinition): ObjectiveMarkerSet {
  const group = new THREE.Group();
  group.name = "objective markers";
  const records: MarkerRecord[] = [];

  for (const site of map.objectives.bomb?.sites ?? []) {
    records.push(
      createMarkerRecord({
        id: `relay-site:${site.id}`,
        kind: "relay-site",
        label: site.label,
        focusId: site.focusId,
        radius: site.radius,
        position: focusPosition(map, site.focusId),
      }),
    );
  }

  for (const cluster of map.objectives.hostage?.hostageClusters ?? []) {
    records.push(
      createMarkerRecord({
        id: `hostage-cluster:${cluster.id}`,
        kind: "hostage-cluster",
        label: cluster.label,
        focusId: cluster.focusId,
        radius: 4.6,
        position: focusPosition(map, cluster.focusId),
      }),
    );
  }

  const extraction = map.objectives.hostage?.extractionZone;
  if (extraction) {
    records.push(
      createMarkerRecord({
        id: `extraction:${extraction.focusId}`,
        kind: "extraction-zone",
        label: extraction.label,
        focusId: extraction.focusId,
        radius: extraction.radius,
        position: focusPosition(map, extraction.focusId),
      }),
    );
  }

  for (const record of records) {
    group.add(record.group);
  }

  return { group, records };
}

export function updateObjectiveMarkerSet(
  markerSet: ObjectiveMarkerSet,
  debugState: ObjectiveMarkerDebugState,
): void {
  const debugById = new Map(debugState.entries.map((entry) => [entry.id, entry]));

  for (const record of markerSet.records) {
    const entry = debugById.get(record.id);
    const active = entry?.active ?? false;
    const action =
      entry?.stateHint === "site-action" ||
      entry?.stateHint === "site-armed" ||
      entry?.stateHint === "secure-zone" ||
      entry?.stateHint === "extracting";
    const opacityBoost = active ? 0.22 : 0;
    record.group.visible = entry?.visible ?? true;
    record.ringMaterial.opacity = active ? 0.58 : 0.32;
    record.plateMaterial.opacity = Math.min(0.86, 0.5 + opacityBoost);
    record.signMaterial.opacity = active ? 0.98 : 0.78;
    record.statePanelMaterial.color.set(action ? "#9C5A3D" : active ? "#8B7247" : "#4C4236");
    record.statePanel.scale.setScalar(action ? 1.18 : active ? 1.05 : 0.92);
  }
}

function markerPosition(position: Vec3): Vec3 {
  return [
    Number(position[0].toFixed(2)),
    Number(position[1].toFixed(2)),
    Number(position[2].toFixed(2)),
  ];
}

function teamRole(teamId: TeamId, attackingTeam: TeamId, defendingTeam: TeamId): "attacker" | "defender" | "neutral" {
  if (teamId === attackingTeam) {
    return "attacker";
  }

  if (teamId === defendingTeam) {
    return "defender";
  }

  return "neutral";
}

export function buildObjectiveMarkerDebugState(input: {
  map: MapDefinition;
  roundState: RoundState;
  localTeamId: TeamId;
  bombState: BombRuntimeState | null;
  hostageState: HostageRuntimeState | null;
}): ObjectiveMarkerDebugState {
  const entries: ObjectiveMarkerDebugEntry[] = [];
  const activeObjectiveLabel = input.roundState.activeMission.objectiveLabel;

  const bombActive = input.roundState.activeMission.missionType === "bomb";
  for (const site of input.map.objectives.bomb?.sites ?? []) {
    const isLiveSite = input.bombState?.site.id === site.id;
    const phase = isLiveSite ? input.bombState?.phase ?? "inactive" : "inactive";
    entries.push({
      id: `relay-site:${site.id}`,
      kind: "relay-site",
      label: site.label,
      focusId: site.focusId,
      position: markerPosition(isLiveSite && input.bombState ? input.bombState.site.position : focusPosition(input.map, site.focusId)),
      radius: site.radius,
      active: bombActive && isLiveSite,
      visible: true,
      phase,
      teamRole: input.bombState
        ? teamRole(input.localTeamId, input.bombState.attackingTeam, input.bombState.defendingTeam)
        : "neutral",
      stateHint:
        phase === "inactive"
          ? "inactive-site"
          : phase === "carried"
          ? "site-available"
          : phase === "planted" || phase === "defusing"
            ? "site-armed"
            : "site-action",
      hudLabelMatch: !bombActive || site.label === activeObjectiveLabel,
    });
  }

  const hostageActive = input.roundState.activeMission.missionType === "hostage";
  for (const cluster of input.map.objectives.hostage?.hostageClusters ?? []) {
    const isLiveCluster = input.hostageState?.cluster.id === cluster.id;
    const phase = isLiveCluster ? input.hostageState?.phase ?? "inactive" : "inactive";
    entries.push({
      id: `hostage-cluster:${cluster.id}`,
      kind: "hostage-cluster",
      label: cluster.label,
      focusId: cluster.focusId,
      position: markerPosition(isLiveCluster && input.hostageState ? input.hostageState.cluster.position : focusPosition(input.map, cluster.focusId)),
      radius: isLiveCluster && input.hostageState ? input.hostageState.cluster.radius : 4.6,
      active: hostageActive && isLiveCluster,
      visible: true,
      phase,
      teamRole: input.hostageState
        ? teamRole(input.localTeamId, input.hostageState.attackingTeam, input.hostageState.defendingTeam)
        : "neutral",
      stateHint:
        phase === "inactive"
          ? "inactive-cluster"
          : phase === "awaiting-rescue" || phase === "securing"
          ? "secure-zone"
          : "escort-origin",
      hudLabelMatch: !hostageActive || activeObjectiveLabel.startsWith(cluster.label),
    });
  }

  if (input.map.objectives.hostage?.extractionZone) {
    const extraction = input.map.objectives.hostage.extractionZone;
    const phase = input.hostageState?.phase ?? "inactive";
    entries.push({
      id: `extraction:${extraction.focusId}`,
      kind: "extraction-zone",
      label: extraction.label,
      focusId: extraction.focusId,
      position: markerPosition(input.hostageState ? input.hostageState.extraction.position : focusPosition(input.map, extraction.focusId)),
      radius: extraction.radius,
      active: hostageActive,
      visible: true,
      phase,
      teamRole: input.hostageState
        ? teamRole(input.localTeamId, input.hostageState.attackingTeam, input.hostageState.defendingTeam)
        : "neutral",
      stateHint: phase === "extracting" ? "extracting" : "extract-threshold",
      hudLabelMatch: !hostageActive || activeObjectiveLabel.endsWith(extraction.label),
    });
  }

  if (input.hostageState) {
    for (const [index, point] of input.hostageState.route.entries()) {
      entries.push({
        id: `escort-route:${index}:${point.focusId}`,
        kind: "escort-route",
        label: point.label,
        focusId: point.focusId,
        position: markerPosition(point.position),
        radius: 1.2,
        active: hostageActive,
        visible: hostageActive,
        phase: input.hostageState.phase,
        teamRole: "neutral",
        stateHint: "route-landmark",
        hudLabelMatch: true,
      });
    }
  }

  return {
    readyForWorldMarkers: entries.length > 0,
    activeMissionType: input.roundState.activeMission.missionType,
    activeObjectiveLabel,
    entries,
  };
}
