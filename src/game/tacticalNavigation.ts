import * as THREE from "three";

import type { MapDefinition } from "../types";
import { findOpenGroundPosition, isBlocked, type CollisionWorld } from "./collision";
import type { TacticalAnchor, TacticalProfile } from "./tacticalAi";

export type TacticalNavNodeKind =
  | "spawn"
  | "route"
  | "focus"
  | "objective"
  | "offset";

export interface TacticalNavNode {
  id: string;
  label: string;
  kind: TacticalNavNodeKind;
  focusId: string | null;
  position: THREE.Vector3;
}

export interface TacticalNavEdge {
  to: number;
  cost: number;
}

export interface TacticalRouteGraph {
  nodes: TacticalNavNode[];
  edges: TacticalNavEdge[][];
  edgeCount: number;
}

export interface TacticalRoutePlan {
  destinationLabel: string;
  destination: THREE.Vector3;
  direct: boolean;
  reachable: boolean;
  usesGraph: boolean;
  reason: "direct-clear" | "graph-route" | "partial-route" | "unreachable";
  waypoint: THREE.Vector3;
  waypointLabel: string;
  waypointNodeId: string | null;
  pathNodeIds: string[];
  pathLabels: string[];
  cost: number;
}

export type TacticalStuckClassification =
  | "arrived"
  | "holding"
  | "moving"
  | "blocked_geometry"
  | "blocked_tactical"
  | "temporarily_slowed";

export type TacticalRecoveryAction =
  | "none"
  | "rotate"
  | "strafe"
  | "backout"
  | "replan"
  | "jump"
  | "jump-suppressed";

export interface TacticalStuckInput {
  shouldMove: boolean;
  finalTargetDistance: number;
  waypointDistance: number;
  speed: number;
  movedDistance: number;
  targetDistanceImprovement: number;
  stalledSeconds: number;
  stuckSeconds: number;
  grounded: boolean;
  crouching: boolean;
  holding: boolean;
  objectiveAction: boolean;
  recoveryAction: TacticalRecoveryAction;
}

const SEGMENT_SAMPLE_STEP = 0.85;
const MAX_GRAPH_EDGE_DISTANCE = 17.5;
const MAX_VIRTUAL_LINK_DISTANCE = 19.5;
const FALLBACK_VIRTUAL_LINKS = 8;
const WAYPOINT_REACHED_RADIUS = 0.82;
const CONNECTOR_GRID_STEP = 4.2;
const OFFSET_RADII = [3.4, 6.2] as const;
const OFFSET_DIRECTIONS = [
  new THREE.Vector2(1, 0),
  new THREE.Vector2(-1, 0),
  new THREE.Vector2(0, 1),
  new THREE.Vector2(0, -1),
  new THREE.Vector2(1, 1).normalize(),
  new THREE.Vector2(1, -1).normalize(),
  new THREE.Vector2(-1, 1).normalize(),
  new THREE.Vector2(-1, -1).normalize(),
] as const;

function flatPosition(position: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(position.x, 0, position.z);
}

function vectorFromFocus(map: MapDefinition, focusId: string): THREE.Vector3 | null {
  const focusPoint = map.scene.focusPoints.find((focus) => focus.id === focusId);
  if (!focusPoint) {
    return null;
  }

  return new THREE.Vector3(focusPoint.target[0], 0, focusPoint.target[2]);
}

function positionKey(position: THREE.Vector3): string {
  return `${Math.round(position.x * 3)}:${Math.round(position.z * 3)}`;
}

function addNode(
  nodes: TacticalNavNode[],
  occupied: Set<string>,
  world: CollisionWorld,
  radius: number,
  bodyHeight: number,
  node: TacticalNavNode,
): TacticalNavNode | null {
  const position = findOpenGroundPosition(world, flatPosition(node.position), radius, bodyHeight);
  if (isBlocked(world, position.x, position.z, radius, bodyHeight)) {
    return null;
  }

  const key = positionKey(position);
  if (occupied.has(key)) {
    return null;
  }

  occupied.add(key);
  const resolved = {
    ...node,
    position,
  };
  nodes.push(resolved);
  return resolved;
}

function objectiveNodes(map: MapDefinition): TacticalNavNode[] {
  const nodes: TacticalNavNode[] = [];

  for (const site of map.objectives.bomb?.sites ?? []) {
    const position = vectorFromFocus(map, site.focusId);
    if (!position) {
      continue;
    }

    nodes.push({
      id: `objective:bomb:${site.id}`,
      label: site.label,
      kind: "objective",
      focusId: site.focusId,
      position,
    });
  }

  for (const cluster of map.objectives.hostage?.hostageClusters ?? []) {
    const position = vectorFromFocus(map, cluster.focusId);
    if (!position) {
      continue;
    }

    nodes.push({
      id: `objective:hostage:${cluster.id}`,
      label: cluster.label,
      kind: "objective",
      focusId: cluster.focusId,
      position,
    });
  }

  const extraction = map.objectives.hostage?.extractionZone;
  if (extraction) {
    const position = vectorFromFocus(map, extraction.focusId);
    if (position) {
      nodes.push({
        id: "objective:hostage:extraction",
        label: extraction.label,
        kind: "objective",
        focusId: extraction.focusId,
        position,
      });
    }
  }

  return nodes;
}

function anchorToNode(anchor: TacticalAnchor): TacticalNavNode {
  return {
    id: `anchor:${anchor.id}`,
    label: anchor.label,
    kind: anchor.kind === "objective" ? "objective" : anchor.kind,
    focusId: anchor.focusId,
    position: anchor.position.clone(),
  };
}

function addOffsetNodes(
  nodes: TacticalNavNode[],
  occupied: Set<string>,
  world: CollisionWorld,
  radius: number,
  bodyHeight: number,
  baseNodes: TacticalNavNode[],
): void {
  for (const base of baseNodes) {
    for (let directionIndex = 0; directionIndex < OFFSET_DIRECTIONS.length; directionIndex += 1) {
      const direction = OFFSET_DIRECTIONS[directionIndex];
      for (const offsetRadius of OFFSET_RADII) {
        const preferred = new THREE.Vector3(
          base.position.x + direction.x * offsetRadius,
          0,
          base.position.z + direction.y * offsetRadius,
        );
        const open = findOpenGroundPosition(world, preferred, radius, bodyHeight);
        if (open.distanceTo(base.position) < 1.2) {
          continue;
        }

        addNode(nodes, occupied, world, radius, bodyHeight, {
          id: `offset:${base.id}:${directionIndex}:${offsetRadius.toFixed(1)}`,
          label: `${base.label} route offset`,
          kind: "offset",
          focusId: base.focusId,
          position: open,
        });
      }
    }
  }
}

function addConnectorNodes(
  nodes: TacticalNavNode[],
  occupied: Set<string>,
  world: CollisionWorld,
  radius: number,
  bodyHeight: number,
): void {
  let connectorIndex = 0;
  for (let x = world.bounds.minX + radius; x <= world.bounds.maxX - radius; x += CONNECTOR_GRID_STEP) {
    for (let z = world.bounds.minZ + radius; z <= world.bounds.maxZ - radius; z += CONNECTOR_GRID_STEP) {
      if (isBlocked(world, x, z, radius, bodyHeight)) {
        continue;
      }

      addNode(nodes, occupied, world, radius, bodyHeight, {
        id: `connector:${connectorIndex}`,
        label: "Tactical connector",
        kind: "offset",
        focusId: null,
        position: new THREE.Vector3(x, 0, z),
      });
      connectorIndex += 1;
    }
  }
}

export function isSegmentTraversable(
  world: CollisionWorld,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  bodyHeight: number,
): boolean {
  const startFlat = flatPosition(start);
  const endFlat = flatPosition(end);

  if (
    isBlocked(world, startFlat.x, startFlat.z, radius, bodyHeight) ||
    isBlocked(world, endFlat.x, endFlat.z, radius, bodyHeight)
  ) {
    return false;
  }

  const delta = endFlat.clone().sub(startFlat);
  const distance = delta.length();
  if (distance <= 0.05) {
    return true;
  }

  const samples = Math.max(1, Math.ceil(distance / SEGMENT_SAMPLE_STEP));
  for (let index = 1; index < samples; index += 1) {
    const t = index / samples;
    const x = THREE.MathUtils.lerp(startFlat.x, endFlat.x, t);
    const z = THREE.MathUtils.lerp(startFlat.z, endFlat.z, t);
    if (isBlocked(world, x, z, radius, bodyHeight)) {
      return false;
    }
  }

  return true;
}

function edgeCost(left: TacticalNavNode, right: TacticalNavNode): number {
  const distance = left.position.distanceTo(right.position);
  const offsetPenalty = (left.kind === "offset" ? 0.18 : 0) + (right.kind === "offset" ? 0.18 : 0);
  const routeBias = left.focusId === right.focusId ? -0.12 : 0;
  return Math.max(0.1, distance + offsetPenalty + routeBias);
}

export function buildTacticalRouteGraph(input: {
  map: MapDefinition;
  profile: TacticalProfile;
  world: CollisionWorld;
  radius: number;
  bodyHeight: number;
}): TacticalRouteGraph {
  const nodes: TacticalNavNode[] = [];
  const occupied = new Set<string>();
  const baseNodes = [
    ...input.profile.anchors.map(anchorToNode),
    ...objectiveNodes(input.map),
  ];

  for (const node of baseNodes) {
    addNode(nodes, occupied, input.world, input.radius, input.bodyHeight, node);
  }

  addOffsetNodes(
    nodes,
    occupied,
    input.world,
    input.radius,
    input.bodyHeight,
    nodes.filter((node) => node.kind !== "offset"),
  );
  addConnectorNodes(nodes, occupied, input.world, input.radius, input.bodyHeight);

  const edges: TacticalNavEdge[][] = nodes.map(() => []);
  let edgeCount = 0;
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const distance = left.position.distanceTo(right.position);
      if (distance < 0.35 || distance > MAX_GRAPH_EDGE_DISTANCE) {
        continue;
      }

      if (
        !isSegmentTraversable(
          input.world,
          left.position,
          right.position,
          input.radius,
          input.bodyHeight,
        )
      ) {
        continue;
      }

      const cost = edgeCost(left, right);
      edges[leftIndex].push({ to: rightIndex, cost });
      edges[rightIndex].push({ to: leftIndex, cost });
      edgeCount += 1;
    }
  }

  return {
    nodes,
    edges,
    edgeCount,
  };
}

function virtualLinks(input: {
  graph: TacticalRouteGraph;
  world: CollisionWorld;
  position: THREE.Vector3;
  radius: number;
  bodyHeight: number;
}): TacticalNavEdge[] {
  const traversable = input.graph.nodes
    .map((node, index) => ({
      to: index,
      cost: input.position.distanceTo(node.position),
      closeEnough: input.position.distanceTo(node.position) <= MAX_VIRTUAL_LINK_DISTANCE,
      traversable: isSegmentTraversable(
        input.world,
        input.position,
        node.position,
        input.radius,
        input.bodyHeight,
      ),
    }))
    .filter((entry) => entry.traversable)
    .sort((left, right) => left.cost - right.cost);

  const preferred = traversable.filter((entry) => entry.closeEnough);
  const selected = preferred.length > 0 ? preferred : traversable.slice(0, FALLBACK_VIRTUAL_LINKS);
  return selected.slice(0, FALLBACK_VIRTUAL_LINKS).map((entry) => ({
    to: entry.to,
    cost: entry.cost,
  }));
}

function shortestPath(
  adjacency: TacticalNavEdge[][],
  startIndex: number,
  endIndex: number,
): { indices: number[]; cost: number } | null {
  const distances = adjacency.map(() => Number.POSITIVE_INFINITY);
  const previous = adjacency.map(() => -1);
  const visited = adjacency.map(() => false);
  distances[startIndex] = 0;

  for (let step = 0; step < adjacency.length; step += 1) {
    let current = -1;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < adjacency.length; index += 1) {
      if (!visited[index] && distances[index] < currentDistance) {
        current = index;
        currentDistance = distances[index];
      }
    }

    if (current === -1 || current === endIndex) {
      break;
    }

    visited[current] = true;
    for (const edge of adjacency[current]) {
      const nextDistance = distances[current] + edge.cost;
      if (nextDistance >= distances[edge.to]) {
        continue;
      }

      distances[edge.to] = nextDistance;
      previous[edge.to] = current;
    }
  }

  if (!Number.isFinite(distances[endIndex])) {
    return null;
  }

  const indices: number[] = [];
  for (let cursor = endIndex; cursor !== -1; cursor = previous[cursor]) {
    indices.push(cursor);
    if (cursor === startIndex) {
      break;
    }
  }

  indices.reverse();
  return {
    indices,
    cost: distances[endIndex],
  };
}

function chooseWaypoint(
  start: THREE.Vector3,
  positions: THREE.Vector3[],
  labels: string[],
  nodeIds: Array<string | null>,
): { waypoint: THREE.Vector3; label: string; nodeId: string | null } {
  for (let index = 0; index < positions.length; index += 1) {
    if (positions[index].distanceTo(start) > WAYPOINT_REACHED_RADIUS) {
      return {
        waypoint: positions[index].clone(),
        label: labels[index] ?? "Route waypoint",
        nodeId: nodeIds[index] ?? null,
      };
    }
  }

  const fallbackIndex = Math.max(0, positions.length - 1);
  return {
    waypoint: (positions[fallbackIndex] ?? start).clone(),
    label: labels[fallbackIndex] ?? "Route waypoint",
    nodeId: nodeIds[fallbackIndex] ?? null,
  };
}

function partialRoutePlan(input: {
  graph: TacticalRouteGraph;
  world: CollisionWorld;
  start: THREE.Vector3;
  destination: THREE.Vector3;
  destinationLabel: string;
  radius: number;
  bodyHeight: number;
}): TacticalRoutePlan {
  const reachable = input.graph.nodes
    .map((node, index) => ({
      node,
      index,
      startDistance: input.start.distanceTo(node.position),
      targetDistance: input.destination.distanceTo(node.position),
      traversable: isSegmentTraversable(
        input.world,
        input.start,
        node.position,
        input.radius,
        input.bodyHeight,
      ),
    }))
    .filter((entry) => entry.traversable)
    .sort(
      (left, right) =>
        left.targetDistance + left.startDistance * 0.25 -
        (right.targetDistance + right.startDistance * 0.25),
    );

  const fallback = reachable[0];
  if (!fallback) {
    return {
      destinationLabel: input.destinationLabel,
      destination: input.destination.clone(),
      direct: false,
      reachable: false,
      usesGraph: false,
      reason: "unreachable",
      waypoint: input.destination.clone(),
      waypointLabel: input.destinationLabel,
      waypointNodeId: null,
      pathNodeIds: [],
      pathLabels: [],
      cost: Number.POSITIVE_INFINITY,
    };
  }

  return {
    destinationLabel: input.destinationLabel,
    destination: input.destination.clone(),
    direct: false,
    reachable: false,
    usesGraph: true,
    reason: "partial-route",
    waypoint: fallback.node.position.clone(),
    waypointLabel: fallback.node.label,
    waypointNodeId: fallback.node.id,
    pathNodeIds: [fallback.node.id],
    pathLabels: [fallback.node.label],
    cost: fallback.startDistance + fallback.targetDistance,
  };
}

export function planTacticalRoute(input: {
  graph: TacticalRouteGraph;
  world: CollisionWorld;
  start: THREE.Vector3;
  destination: THREE.Vector3;
  destinationLabel: string;
  radius: number;
  bodyHeight: number;
  allowDirect?: boolean;
}): TacticalRoutePlan {
  const start = flatPosition(input.start);
  const destination = flatPosition(input.destination);
  const allowDirect = input.allowDirect ?? true;

  if (
    allowDirect &&
    isSegmentTraversable(input.world, start, destination, input.radius, input.bodyHeight)
  ) {
    return {
      destinationLabel: input.destinationLabel,
      destination,
      direct: true,
      reachable: true,
      usesGraph: false,
      reason: "direct-clear",
      waypoint: destination.clone(),
      waypointLabel: input.destinationLabel,
      waypointNodeId: null,
      pathNodeIds: [],
      pathLabels: [input.destinationLabel],
      cost: start.distanceTo(destination),
    };
  }

  const startIndex = input.graph.nodes.length;
  const endIndex = input.graph.nodes.length + 1;
  const adjacency = input.graph.edges.map((edges) => [...edges]);
  adjacency.push([]);
  adjacency.push([]);

  for (const edge of virtualLinks({
    graph: input.graph,
    world: input.world,
    position: start,
    radius: input.radius,
    bodyHeight: input.bodyHeight,
  })) {
    adjacency[startIndex].push(edge);
    adjacency[edge.to].push({ to: startIndex, cost: edge.cost });
  }

  for (const edge of virtualLinks({
    graph: input.graph,
    world: input.world,
    position: destination,
    radius: input.radius,
    bodyHeight: input.bodyHeight,
  })) {
    adjacency[endIndex].push(edge);
    adjacency[edge.to].push({ to: endIndex, cost: edge.cost });
  }

  const path = shortestPath(adjacency, startIndex, endIndex);
  if (!path) {
    return partialRoutePlan({
      graph: input.graph,
      world: input.world,
      start,
      destination,
      destinationLabel: input.destinationLabel,
      radius: input.radius,
      bodyHeight: input.bodyHeight,
    });
  }

  const graphIndices = path.indices.filter(
    (index) => index !== startIndex && index !== endIndex,
  );
  const pathPositions = [
    ...graphIndices.map((index) => input.graph.nodes[index].position.clone()),
    destination.clone(),
  ];
  const pathLabels = [
    ...graphIndices.map((index) => input.graph.nodes[index].label),
    input.destinationLabel,
  ];
  const pathNodeIds = graphIndices.map((index) => input.graph.nodes[index].id);
  const waypoint = chooseWaypoint(
    start,
    pathPositions,
    pathLabels,
    [...pathNodeIds, null],
  );

  return {
    destinationLabel: input.destinationLabel,
    destination,
    direct: false,
    reachable: true,
    usesGraph: graphIndices.length > 0,
    reason: "graph-route",
    waypoint: waypoint.waypoint,
    waypointLabel: waypoint.label,
    waypointNodeId: waypoint.nodeId,
    pathNodeIds,
    pathLabels,
    cost: path.cost,
  };
}

export function classifyTacticalStuck(input: TacticalStuckInput): TacticalStuckClassification {
  if (input.finalTargetDistance <= 1.1 || input.waypointDistance <= 0.74) {
    return "arrived";
  }

  if (!input.shouldMove || input.holding || input.objectiveAction) {
    return "holding";
  }

  if (!input.grounded || (input.crouching && input.stalledSeconds < input.stuckSeconds * 0.85)) {
    return "temporarily_slowed";
  }

  if (
    input.speed > 0.38 ||
    input.movedDistance > 0.08 ||
    input.targetDistanceImprovement > 0.12
  ) {
    return "moving";
  }

  if (input.recoveryAction !== "none" && input.recoveryAction !== "jump-suppressed") {
    return "blocked_tactical";
  }

  if (input.stalledSeconds >= input.stuckSeconds * 0.48) {
    return "blocked_geometry";
  }

  return "moving";
}
