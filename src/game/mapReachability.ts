import * as THREE from "three";

import type { MapDefinition, TeamId } from "../types";
import { buildCollisionWorld, findOpenGroundPosition, isBlocked, type CollisionWorld } from "./collision";
import { buildTacticalProfile } from "./tacticalAi";
import { PLAYER_RADIUS, STANDING_BODY_HEIGHT } from "./playerMovement";
import {
  buildTacticalRouteGraph,
  isSegmentTraversable,
  planTacticalRoute,
  type TacticalRouteGraph,
  type TacticalRoutePlan,
} from "./tacticalNavigation";

export interface ReachabilityPointEvidence {
  id: string;
  label: string;
  kind: "spawn" | "route" | "focus" | "objective" | "offset";
  focusId: string | null;
  position: { x: number; y: number; z: number };
  graphDegree: number;
}

export interface RouteCompletionEvidence {
  destinationLabel: string;
  reachable: boolean;
  direct: boolean;
  usesGraph: boolean;
  reason: TacticalRoutePlan["reason"];
  waypointLabel: string;
  waypointNodeId: string | null;
  waypoint: { x: number; y: number; z: number };
  pathNodeIds: string[];
  pathLabels: string[];
  cost: number;
}

export interface MapReachabilityDebugState {
  mapId: string;
  graph: {
    nodeCount: number;
    edgeCount: number;
    objectiveNodeCount: number;
    routeNodeCount: number;
    spawnNodeCount: number;
  };
  objectiveFocusIds: string[];
  points: ReachabilityPointEvidence[];
  report: MapReachabilityReport;
}

export type ReachabilityCheckKind =
  | "spawn-route"
  | "route-link"
  | "spawn-focus"
  | "bomb-site"
  | "hostage-cluster"
  | "extraction"
  | "hostage-route";

export interface ReachabilityCheckEvidence {
  id: string;
  kind: ReachabilityCheckKind;
  label: string;
  fromLabel: string;
  toLabel: string;
  reachable: boolean;
  graphReachable: boolean;
  collisionReachable: boolean;
  direct: boolean;
  reason: TacticalRoutePlan["reason"] | "collision-grid-route";
  pathLabels: string[];
  pathNodeIds: string[];
  cost: number;
  start: { x: number; y: number; z: number };
  destination: { x: number; y: number; z: number };
}

export interface MapReachabilityReport {
  mapId: string;
  mapName: string;
  playerEquivalent: {
    radius: number;
    bodyHeight: number;
  };
  graph: MapReachabilityDebugState["graph"];
  totals: {
    checks: number;
    reachable: number;
    blocked: number;
  };
  checks: ReachabilityCheckEvidence[];
  blocked: ReachabilityCheckEvidence[];
  sandlineWestRoute?: {
    amberToGeneratorHall: ReachabilityCheckEvidence | null;
    generatorHallToCentralYard: ReachabilityCheckEvidence | null;
    cobaltToGeneratorHall: ReachabilityCheckEvidence | null;
    cobaltToShutterGap: ReachabilityCheckEvidence | null;
    shutterGapToGeneratorHall: ReachabilityCheckEvidence | null;
    drainUnderpassToKilnYard: ReachabilityCheckEvidence | null;
    amberDirectSegmentClear: boolean | null;
    generatorToCentralDirectSegmentClear: boolean | null;
  };
}

function point(position: THREE.Vector3): { x: number; y: number; z: number } {
  return {
    x: Number(position.x.toFixed(2)),
    y: Number(position.y.toFixed(2)),
    z: Number(position.z.toFixed(2)),
  };
}

export function buildMapReachabilityDebugState(
  map: MapDefinition,
  graph: TacticalRouteGraph,
): MapReachabilityDebugState {
  const objectiveFocusIds = new Set<string>();

  for (const site of map.objectives.bomb?.sites ?? []) {
    objectiveFocusIds.add(site.focusId);
  }

  for (const cluster of map.objectives.hostage?.hostageClusters ?? []) {
    objectiveFocusIds.add(cluster.focusId);
  }

  if (map.objectives.hostage?.extractionZone) {
    objectiveFocusIds.add(map.objectives.hostage.extractionZone.focusId);
  }

  const points = graph.nodes.map((node, index) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    focusId: node.focusId,
    position: point(node.position),
    graphDegree: graph.edges[index]?.length ?? 0,
  }));

  return {
    mapId: map.id,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edgeCount,
      objectiveNodeCount: graph.nodes.filter((node) => node.kind === "objective").length,
      routeNodeCount: graph.nodes.filter((node) => node.kind === "route").length,
      spawnNodeCount: graph.nodes.filter((node) => node.kind === "spawn").length,
    },
    objectiveFocusIds: [...objectiveFocusIds],
    points,
    report: buildMapReachabilityReport(map),
  };
}

export function summarizeRouteCompletion(
  plan: TacticalRoutePlan | null,
): RouteCompletionEvidence | null {
  if (!plan) {
    return null;
  }

  return {
    destinationLabel: plan.destinationLabel,
    reachable: plan.reachable,
    direct: plan.direct,
    usesGraph: plan.usesGraph,
    reason: plan.reason,
    waypointLabel: plan.waypointLabel,
    waypointNodeId: plan.waypointNodeId,
    waypoint: point(plan.waypoint),
    pathNodeIds: [...plan.pathNodeIds],
    pathLabels: [...plan.pathLabels],
    cost: Number(plan.cost.toFixed(2)),
  };
}

function graphStats(graph: TacticalRouteGraph): MapReachabilityDebugState["graph"] {
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edgeCount,
    objectiveNodeCount: graph.nodes.filter((node) => node.kind === "objective").length,
    routeNodeCount: graph.nodes.filter((node) => node.kind === "route").length,
    spawnNodeCount: graph.nodes.filter((node) => node.kind === "spawn").length,
  };
}

function focusPosition(map: MapDefinition, focusId: string): THREE.Vector3 | null {
  const focus = map.scene.focusPoints.find((candidate) => candidate.id === focusId);
  if (!focus) {
    return null;
  }

  return new THREE.Vector3(focus.target[0], 0, focus.target[2]);
}

function focusLabel(map: MapDefinition, focusId: string): string {
  return map.scene.focusPoints.find((focus) => focus.id === focusId)?.label ?? focusId;
}

function routeById(map: MapDefinition, routeId: string) {
  return map.tacticalRoutes.find((route) => route.id === routeId) ?? null;
}

function toCheck(input: {
  id: string;
  kind: ReachabilityCheckKind;
  label: string;
  fromLabel: string;
  start: THREE.Vector3;
  toLabel: string;
  destination: THREE.Vector3;
  plan: TacticalRoutePlan;
  collisionReachable: boolean;
}): ReachabilityCheckEvidence {
  const reachable = input.plan.reachable || input.collisionReachable;
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    fromLabel: input.fromLabel,
    toLabel: input.toLabel,
    reachable,
    graphReachable: input.plan.reachable,
    collisionReachable: input.collisionReachable,
    direct: input.plan.direct,
    reason: input.plan.reachable ? input.plan.reason : "collision-grid-route",
    pathLabels: [...input.plan.pathLabels],
    pathNodeIds: [...input.plan.pathNodeIds],
    cost: Number(input.plan.cost.toFixed(2)),
    start: point(input.start),
    destination: point(input.destination),
  };
}

function gridKey(x: number, z: number): string {
  return `${x}:${z}`;
}

function isCollisionReachable(input: {
  world: CollisionWorld;
  start: THREE.Vector3;
  destination: THREE.Vector3;
  radius: number;
  bodyHeight: number;
}): boolean {
  if (
    isSegmentTraversable(
      input.world,
      input.start,
      input.destination,
      input.radius,
      input.bodyHeight,
    )
  ) {
    return true;
  }

  const step = 1.1;
  const minX = Math.ceil(input.world.bounds.minX / step);
  const maxX = Math.floor(input.world.bounds.maxX / step);
  const minZ = Math.ceil(input.world.bounds.minZ / step);
  const maxZ = Math.floor(input.world.bounds.maxZ / step);
  const cellFor = (position: THREE.Vector3) => ({
    x: Math.round(position.x / step),
    z: Math.round(position.z / step),
  });
  const positionFor = (cell: { x: number; z: number }) =>
    new THREE.Vector3(cell.x * step, 0, cell.z * step);
  const openCell = (cell: { x: number; z: number }) => {
    if (cell.x < minX || cell.x > maxX || cell.z < minZ || cell.z > maxZ) {
      return false;
    }

    const position = positionFor(cell);
    return !isBlocked(input.world, position.x, position.z, input.radius, input.bodyHeight);
  };
  const nearestOpenCell = (position: THREE.Vector3) => {
    const base = cellFor(position);
    for (let ring = 0; ring <= 4; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dz = -ring; dz <= ring; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) {
            continue;
          }

          const candidate = { x: base.x + dx, z: base.z + dz };
          if (!openCell(candidate)) {
            continue;
          }

          const candidatePosition = positionFor(candidate);
          if (
            isSegmentTraversable(
              input.world,
              position,
              candidatePosition,
              input.radius,
              input.bodyHeight,
            )
          ) {
            return candidate;
          }
        }
      }
    }

    return null;
  };
  const startCell = nearestOpenCell(input.start);
  const destinationCell = nearestOpenCell(input.destination);
  if (!startCell || !destinationCell) {
    return false;
  }

  const destinationKey = gridKey(destinationCell.x, destinationCell.z);
  const queue = [startCell];
  const visited = new Set([gridKey(startCell.x, startCell.z)]);
  const directions = [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
    { x: 1, z: 1 },
    { x: 1, z: -1 },
    { x: -1, z: 1 },
    { x: -1, z: -1 },
  ];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (gridKey(current.x, current.z) === destinationKey) {
      return true;
    }

    for (const direction of directions) {
      const next = { x: current.x + direction.x, z: current.z + direction.z };
      const key = gridKey(next.x, next.z);
      if (visited.has(key) || !openCell(next)) {
        continue;
      }

      if (
        !isSegmentTraversable(
          input.world,
          positionFor(current),
          positionFor(next),
          input.radius,
          input.bodyHeight,
        )
      ) {
        continue;
      }

      visited.add(key);
      queue.push(next);
    }
  }

  return false;
}

export function buildMapReachabilityReport(map: MapDefinition): MapReachabilityReport {
  const world = buildCollisionWorld(map);
  const profile = buildTacticalProfile(map, world, STANDING_BODY_HEIGHT);
  const graph = buildTacticalRouteGraph({
    map,
    profile,
    world,
    radius: PLAYER_RADIUS,
    bodyHeight: STANDING_BODY_HEIGHT,
  });
  const checks: ReachabilityCheckEvidence[] = [];
  const resolvedFocus = (focusId: string) => {
    const preferred = focusPosition(map, focusId);
    return preferred
      ? findOpenGroundPosition(world, preferred, PLAYER_RADIUS, STANDING_BODY_HEIGHT)
      : null;
  };
  const addPlan = (input: {
    id: string;
    kind: ReachabilityCheckKind;
    label: string;
    fromLabel: string;
    start: THREE.Vector3 | null;
    toLabel: string;
    destination: THREE.Vector3 | null;
    allowDirect?: boolean;
  }) => {
    if (!input.start || !input.destination) {
      return;
    }

    const plan = planTacticalRoute({
      graph,
      world,
      start: input.start,
      destination: input.destination,
      destinationLabel: input.toLabel,
      radius: PLAYER_RADIUS,
      bodyHeight: STANDING_BODY_HEIGHT,
      allowDirect: input.allowDirect,
    });
    const collisionReachable = isCollisionReachable({
      world,
      start: input.start,
      destination: input.destination,
      radius: PLAYER_RADIUS,
      bodyHeight: STANDING_BODY_HEIGHT,
    });
    checks.push(
      toCheck({
        id: input.id,
        kind: input.kind,
        label: input.label,
        fromLabel: input.fromLabel,
        start: input.start,
        toLabel: input.toLabel,
        destination: input.destination,
        plan,
        collisionReachable,
      }),
    );
  };

  const spawnPositions: Record<TeamId, THREE.Vector3 | null> = {
    amber: resolvedFocus(map.teamSpawns.amber.focusId),
    cobalt: resolvedFocus(map.teamSpawns.cobalt.focusId),
  };
  const addRouteLinkCheck = (input: {
    id: string;
    label: string;
    fromLabel: string;
    start: THREE.Vector3 | null;
    toLabel: string;
    destination: THREE.Vector3 | null;
  }): ReachabilityCheckEvidence | null => {
    if (!input.start || !input.destination) {
      return null;
    }

    const plan = planTacticalRoute({
      graph,
      world,
      start: input.start,
      destination: input.destination,
      destinationLabel: input.toLabel,
      radius: PLAYER_RADIUS,
      bodyHeight: STANDING_BODY_HEIGHT,
      allowDirect: false,
    });
    const check = toCheck({
      id: input.id,
      kind: "route-link",
      label: input.label,
      fromLabel: input.fromLabel,
      start: input.start,
      toLabel: input.toLabel,
      destination: input.destination,
      plan,
      collisionReachable: isCollisionReachable({
        world,
        start: input.start,
        destination: input.destination,
        radius: PLAYER_RADIUS,
        bodyHeight: STANDING_BODY_HEIGHT,
      }),
    });
    checks.push(check);
    return check;
  };

  for (const route of map.tacticalRoutes) {
    const destination = resolvedFocus(route.focusId);
    for (const team of Object.keys(spawnPositions) as TeamId[]) {
      addPlan({
        id: `${team}:route:${route.id}`,
        kind: "spawn-route",
        label: `${map.teamSpawns[team].label} to ${route.name}`,
        fromLabel: map.teamSpawns[team].label,
        start: spawnPositions[team],
        toLabel: route.name,
        destination,
      });
    }
  }

  for (const focus of map.scene.focusPoints) {
    const destination = resolvedFocus(focus.id);
    for (const team of Object.keys(spawnPositions) as TeamId[]) {
      addPlan({
        id: `${team}:focus:${focus.id}`,
        kind: "spawn-focus",
        label: `${map.teamSpawns[team].label} to ${focus.label}`,
        fromLabel: map.teamSpawns[team].label,
        start: spawnPositions[team],
        toLabel: focus.label,
        destination,
      });
    }
  }

  const bombMission = map.objectives.bomb;
  if (bombMission) {
    for (const site of bombMission.sites) {
      const destination = resolvedFocus(site.focusId);
      for (const team of [bombMission.deliveryTeam, bombMission.holdTeam]) {
        addPlan({
          id: `${team}:bomb:${site.id}`,
          kind: "bomb-site",
          label: `${map.teamSpawns[team].label} to ${site.label}`,
          fromLabel: map.teamSpawns[team].label,
          start: spawnPositions[team],
          toLabel: site.label,
          destination,
        });
      }

      let previousRoute = null as ReturnType<typeof routeById>;
      for (const routeId of site.routeIds) {
        const route = routeById(map, routeId);
        if (previousRoute && route) {
          addPlan({
            id: `bomb:${site.id}:route:${previousRoute.id}->${route.id}`,
            kind: "route-link",
            label: `${site.label} route ${previousRoute.name} to ${route.name}`,
            fromLabel: previousRoute.name,
            start: resolvedFocus(previousRoute.focusId),
            toLabel: route.name,
            destination: resolvedFocus(route.focusId),
            allowDirect: false,
          });
        }
        previousRoute = route;
      }
    }
  }

  const hostageMission = map.objectives.hostage;
  if (hostageMission) {
    for (const cluster of hostageMission.hostageClusters) {
      const destination = resolvedFocus(cluster.focusId);
      for (const team of [hostageMission.rescueTeam, hostageMission.holdTeam]) {
        addPlan({
          id: `${team}:hostage:${cluster.id}`,
          kind: "hostage-cluster",
          label: `${map.teamSpawns[team].label} to ${cluster.label}`,
          fromLabel: map.teamSpawns[team].label,
          start: spawnPositions[team],
          toLabel: cluster.label,
          destination,
        });
      }

      let previousPosition = destination;
      let previousLabel = cluster.label;
      for (const routeId of cluster.routeIds) {
        const route = routeById(map, routeId);
        if (!route) {
          continue;
        }

        const routePosition = resolvedFocus(route.focusId);
        addPlan({
          id: `hostage:${cluster.id}:route:${route.id}`,
          kind: "hostage-route",
          label: `${cluster.label} route to ${route.name}`,
          fromLabel: previousLabel,
          start: previousPosition,
          toLabel: route.name,
          destination: routePosition,
          allowDirect: false,
        });
        previousPosition = routePosition;
        previousLabel = route.name;
      }

      addPlan({
        id: `hostage:${cluster.id}:extract`,
        kind: "hostage-route",
        label: `${cluster.label} route to ${hostageMission.extractionZone.label}`,
        fromLabel: previousLabel,
        start: previousPosition,
        toLabel: hostageMission.extractionZone.label,
        destination: resolvedFocus(hostageMission.extractionZone.focusId),
        allowDirect: false,
      });
    }

    const extractionDestination = resolvedFocus(hostageMission.extractionZone.focusId);
    for (const team of [hostageMission.rescueTeam, hostageMission.holdTeam]) {
      addPlan({
        id: `${team}:extraction:${hostageMission.extractionZone.focusId}`,
        kind: "extraction",
        label: `${map.teamSpawns[team].label} to ${hostageMission.extractionZone.label}`,
        fromLabel: map.teamSpawns[team].label,
        start: spawnPositions[team],
        toLabel: hostageMission.extractionZone.label,
        destination: extractionDestination,
      });
    }
  }

  const sandlineExactRoutes =
    map.id === "sandline-foundry"
      ? {
          cobaltToShutterGap: addRouteLinkCheck({
            id: "sandline:cobalt->shutter-gap",
            label: "Blue Shutter Bay reaches Shutter Gap",
            fromLabel: map.teamSpawns.cobalt.label,
            start: spawnPositions.cobalt,
            toLabel: focusLabel(map, "shutter-gap"),
            destination: resolvedFocus("shutter-gap"),
          }),
          shutterGapToGeneratorHall: addRouteLinkCheck({
            id: "sandline:shutter-gap->generator-hall",
            label: "Shutter Gap opens into Generator Hall",
            fromLabel: focusLabel(map, "shutter-gap"),
            start: resolvedFocus("shutter-gap"),
            toLabel: focusLabel(map, "corridor"),
            destination: resolvedFocus("corridor"),
          }),
          drainUnderpassToKilnYard: addRouteLinkCheck({
            id: "sandline:drain-underpass->kiln-yard",
            label: "Drain Underpass cut reaches Kiln Yard",
            fromLabel: focusLabel(map, "underpass"),
            start: resolvedFocus("underpass"),
            toLabel: focusLabel(map, "courtyard"),
            destination: resolvedFocus("courtyard"),
          }),
        }
      : null;

  const blocked = checks.filter((check) => !check.reachable);
  const sandlineWestRoute =
    map.id === "sandline-foundry"
      ? {
          amberToGeneratorHall:
            checks.find((check) => check.id === "amber:route:generator-hall") ?? null,
          generatorHallToCentralYard:
            (() => {
              const generator = routeById(map, "generator-hall");
              const central = routeById(map, "main-yard");
              if (!generator || !central) {
                return null;
              }

              const start = resolvedFocus(generator.focusId);
              const destination = resolvedFocus(central.focusId);
              if (!start || !destination) {
                return null;
              }

              const plan = planTacticalRoute({
                graph,
                world,
                start,
                destination,
                destinationLabel: central.name,
                radius: PLAYER_RADIUS,
                bodyHeight: STANDING_BODY_HEIGHT,
                allowDirect: false,
              });
              return toCheck({
                id: "sandline:generator-hall->main-yard",
                kind: "route-link",
                label: "Generator Hall reconnects to Central Yard",
                fromLabel: generator.name,
                start,
                toLabel: central.name,
                destination,
                plan,
                collisionReachable: isCollisionReachable({
                  world,
                  start,
                  destination,
                  radius: PLAYER_RADIUS,
                  bodyHeight: STANDING_BODY_HEIGHT,
                }),
              });
            })(),
          cobaltToGeneratorHall:
            checks.find((check) => check.id === "cobalt:route:generator-hall") ?? null,
          cobaltToShutterGap: sandlineExactRoutes?.cobaltToShutterGap ?? null,
          shutterGapToGeneratorHall: sandlineExactRoutes?.shutterGapToGeneratorHall ?? null,
          drainUnderpassToKilnYard: sandlineExactRoutes?.drainUnderpassToKilnYard ?? null,
          amberDirectSegmentClear: (() => {
            const generator = routeById(map, "generator-hall");
            const destination = generator ? resolvedFocus(generator.focusId) : null;
            return spawnPositions.amber && destination
              ? isSegmentTraversable(
                  world,
                  spawnPositions.amber,
                  destination,
                  PLAYER_RADIUS,
                  STANDING_BODY_HEIGHT,
                )
              : null;
          })(),
          generatorToCentralDirectSegmentClear: (() => {
            const generator = routeById(map, "generator-hall");
            const central = routeById(map, "main-yard");
            const start = generator ? resolvedFocus(generator.focusId) : null;
            const destination = central ? resolvedFocus(central.focusId) : null;
            return start && destination
              ? isSegmentTraversable(world, start, destination, PLAYER_RADIUS, STANDING_BODY_HEIGHT)
              : null;
          })(),
        }
      : undefined;

  return {
    mapId: map.id,
    mapName: map.name,
    playerEquivalent: {
      radius: PLAYER_RADIUS,
      bodyHeight: STANDING_BODY_HEIGHT,
    },
    graph: graphStats(graph),
    totals: {
      checks: checks.length,
      reachable: checks.length - blocked.length,
      blocked: blocked.length,
    },
    checks,
    blocked,
    sandlineWestRoute,
  };
}
