import * as THREE from "three";

import type { MapDefinition, Primitive, TeamId, Vec3 } from "../types";
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
  labelMount?: "ground-stencil";
  floatingLabel?: boolean;
  objectiveCue?: "floor-zone";
  surfaceY?: number;
  surfaceSource?: string;
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
  zoneMaterial: THREE.MeshStandardMaterial;
  ringMaterial: THREE.MeshStandardMaterial;
  plateMaterial: THREE.MeshStandardMaterial;
  labelMaterial: THREE.MeshBasicMaterial;
  cueMaterial: THREE.MeshStandardMaterial;
  statePanelMaterial: THREE.MeshStandardMaterial;
  statePanel: THREE.Mesh;
}

interface MarkerSurface {
  y: number;
  source: string;
}

export interface ObjectiveMarkerSet {
  group: THREE.Group;
  records: MarkerRecord[];
}

const RELAY_COLOR = "#B88B45";
const HOSTAGE_COLOR = "#6F8A5E";
const EXTRACTION_COLOR = "#5F8195";
const ROUTE_COLOR = "#8B7B5C";
const GROUND_MARKER_Y = 0.026;
const MARKER_SURFACE_MAX_HEIGHT = 1.25;
const MARKER_SURFACE_MIN_FOOTPRINT = 14;
const MARKER_SURFACE_FOCUS_Y_TOLERANCE = 1.8;

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

function focusTargetY(map: MapDefinition, focusId: string): number | null {
  const focus = map.scene.focusPoints.find((entry) => entry.id === focusId);
  return focus?.target[1] ?? null;
}

function isMarkerSurface(primitive: Primitive, targetY: number | null): boolean {
  if (primitive.shape !== "box") {
    return false;
  }

  if (primitive.name?.toLowerCase().includes("beacon")) {
    return false;
  }

  const [width, height, depth] = primitive.size;
  const topY = primitive.position[1] + height / 2;

  return (
    height <= MARKER_SURFACE_MAX_HEIGHT &&
    width * depth >= MARKER_SURFACE_MIN_FOOTPRINT &&
    (targetY === null || topY <= targetY + MARKER_SURFACE_FOCUS_Y_TOLERANCE)
  );
}

function containsSurfacePoint(primitive: Primitive & { shape: "box" }, position: Vec3): boolean {
  const [x, , z] = position;
  const [width, , depth] = primitive.size;
  const [centerX, , centerZ] = primitive.position;
  return (
    x >= centerX - width / 2 &&
    x <= centerX + width / 2 &&
    z >= centerZ - depth / 2 &&
    z <= centerZ + depth / 2
  );
}

function markerSurfaceAt(map: MapDefinition, position: Vec3, focusId: string): MarkerSurface {
  let surface: MarkerSurface = { y: 0, source: "ground" };
  const targetY = focusTargetY(map, focusId);

  for (const primitive of map.scene.primitives) {
    if (
      primitive.shape === "box" &&
      isMarkerSurface(primitive, targetY) &&
      containsSurfacePoint(primitive, position)
    ) {
      const [, height] = primitive.size;
      const y = primitive.position[1] + height / 2;
      if (y > surface.y) {
        surface = { y, source: primitive.name ?? "unnamed surface" };
      }
    }
  }

  return surface;
}

function makeMaterial(color: string, opacity: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  return material;
}

function makeGroundLabelMaterial(
  label: string,
  color: string,
  kind: ObjectiveMarkerKind,
): THREE.MeshBasicMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  if (context) {
    const role =
      kind === "relay-site"
        ? "RELAY"
        : kind === "hostage-cluster"
          ? "SECURE"
          : kind === "extraction-zone"
            ? "EVAC"
            : "ROUTE";

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(24, 21, 15, 0.68)";
    context.fillRect(12, 18, canvas.width - 24, canvas.height - 36);
    context.strokeStyle = color;
    context.lineWidth = 9;
    context.strokeRect(18, 24, canvas.width - 36, canvas.height - 48);

    context.fillStyle = color;
    context.font = "bold 24px monospace";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(role, 40, 55, 132);

    context.fillStyle = "#E5D2A5";
    context.font = "bold 34px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.toUpperCase(), canvas.width / 2, 102, canvas.width - 62);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -3;
  material.polygonOffsetUnits = -3;
  return material;
}

function groundPlane(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  yOffset = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = GROUND_MARKER_Y + yOffset;
  mesh.receiveShadow = true;
  return mesh;
}

function createGroundStripe(
  width: number,
  depth: number,
  material: THREE.Material,
  position: THREE.Vector3,
  rotationY = 0,
): THREE.Mesh {
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(width, 0.035, depth), material);
  stripe.position.copy(position);
  stripe.rotation.y = rotationY;
  stripe.receiveShadow = true;
  return stripe;
}

function createMarkerRecord(map: MapDefinition, input: {
  id: string;
  kind: ObjectiveMarkerKind;
  label: string;
  focusId: string;
  radius: number;
  position: Vec3;
}): MarkerRecord {
  const color = markerColor(input.kind);
  const group = new THREE.Group();
  const surface = markerSurfaceAt(map, input.position, input.focusId);
  group.name = `objective marker ${input.label}`;
  group.position.set(
    input.position[0],
    surface.y,
    input.position[2],
  );

  const zoneMaterial = makeMaterial(color, 0.18);
  const zone = groundPlane(new THREE.CircleGeometry(input.radius * 0.94, 36), zoneMaterial, 0.002);
  group.add(zone);

  const ringMaterial = makeMaterial(color, 0.36);
  const ring = groundPlane(
    new THREE.RingGeometry(Math.max(0.7, input.radius - 0.42), input.radius, 36),
    ringMaterial,
    0.006,
  );
  group.add(ring);

  const plateMaterial = makeMaterial(color, 0.58);
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(5.2, input.radius * 1.32), 0.075, 0.62),
    plateMaterial,
  );
  plate.position.y = 0.046;
  plate.rotation.y = input.kind === "extraction-zone" ? Math.PI / 2 : 0;
  plate.receiveShadow = true;
  group.add(plate);

  const cueMaterial = makeMaterial("#DCC17A", 0.62);
  const bracketLength = Math.min(3.8, Math.max(2.2, input.radius * 0.86));
  const bracketOffset = Math.max(1.1, input.radius * 0.58);
  const frontBracket = createGroundStripe(
    bracketLength,
    0.16,
    cueMaterial,
    new THREE.Vector3(0, 0.044, bracketOffset),
  );
  const backBracket = createGroundStripe(
    bracketLength,
    0.16,
    cueMaterial,
    new THREE.Vector3(0, 0.044, -bracketOffset),
  );
  const leftBracket = createGroundStripe(
    0.16,
    bracketLength,
    cueMaterial,
    new THREE.Vector3(-bracketOffset, 0.044, 0),
  );
  const rightBracket = createGroundStripe(
    0.16,
    bracketLength,
    cueMaterial,
    new THREE.Vector3(bracketOffset, 0.044, 0),
  );
  group.add(frontBracket, backBracket, leftBracket, rightBracket);

  const statePanelMaterial = makeMaterial("#4C4236", 0.86);
  const statePanel = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.55, 0.16),
    statePanelMaterial,
  );
  statePanel.position.set(input.radius * 0.54, 0.31, -input.radius * 0.35);
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

  const labelMaterial = makeGroundLabelMaterial(input.label, color, input.kind);
  const labelWidth = Math.min(4.9, Math.max(3.4, input.radius * 1.24));
  const labelDepth = Math.min(1.34, Math.max(0.92, input.radius * 0.34));
  const label = groundPlane(
    new THREE.PlaneGeometry(labelWidth, labelDepth),
    labelMaterial,
    0.012,
  );
  label.name = `ground stencil ${input.label}`;
  label.position.z = input.kind === "extraction-zone" ? -input.radius * 0.34 : input.radius * 0.34;
  label.renderOrder = 2;
  group.add(label);

  return {
    ...input,
    group,
    zoneMaterial,
    ringMaterial,
    plateMaterial,
    labelMaterial,
    cueMaterial,
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
      createMarkerRecord(map, {
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
      createMarkerRecord(map, {
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
      createMarkerRecord(map, {
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
    const opacityBoost = active ? 0.28 : 0;
    record.group.visible = entry?.visible ?? true;
    record.zoneMaterial.opacity = active ? 0.34 : 0.08;
    record.ringMaterial.opacity = active ? 0.78 : 0.2;
    record.plateMaterial.opacity = Math.min(0.92, 0.36 + opacityBoost);
    record.cueMaterial.opacity = active ? 0.74 : 0.16;
    record.labelMaterial.opacity = active ? 0.98 : 0.38;
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

function markerPresentation(): Pick<
  ObjectiveMarkerDebugEntry,
  "labelMount" | "floatingLabel" | "objectiveCue"
> {
  return {
    labelMount: "ground-stencil",
    floatingLabel: false,
    objectiveCue: "floor-zone",
  };
}

function markerSurfacePresentation(
  map: MapDefinition,
  position: Vec3,
  focusId: string,
): Pick<ObjectiveMarkerDebugEntry, "surfaceY" | "surfaceSource"> {
  const surface = markerSurfaceAt(map, position, focusId);
  return {
    surfaceY: Number(surface.y.toFixed(3)),
    surfaceSource: surface.source,
  };
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
      ...markerPresentation(),
      ...markerSurfacePresentation(
        input.map,
        isLiveSite && input.bombState ? input.bombState.site.position : focusPosition(input.map, site.focusId),
        site.focusId,
      ),
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
      ...markerPresentation(),
      ...markerSurfacePresentation(
        input.map,
        isLiveCluster && input.hostageState ? input.hostageState.cluster.position : focusPosition(input.map, cluster.focusId),
        cluster.focusId,
      ),
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
      ...markerPresentation(),
      ...markerSurfacePresentation(
        input.map,
        input.hostageState ? input.hostageState.extraction.position : focusPosition(input.map, extraction.focusId),
        extraction.focusId,
      ),
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
