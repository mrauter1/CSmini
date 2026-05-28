export type Vec3 = [number, number, number];
export type TeamId = "amber" | "cobalt";
export type TeamPreference = TeamId | "auto";
export type MissionType = "bomb" | "hostage";

export type RouteKind = "main" | "corridor" | "flank" | "spawn" | "landmark";

type PreviewBase = {
  opacity?: number;
};

export type PreviewElement =
  | (PreviewBase & {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      stroke?: string;
      strokeWidth?: number;
      radius?: number;
    })
  | (PreviewBase & {
      kind: "circle";
      cx: number;
      cy: number;
      r: number;
      fill: string;
      stroke?: string;
      strokeWidth?: number;
    })
  | (PreviewBase & {
      kind: "polyline";
      points: string;
      stroke: string;
      strokeWidth: number;
      dashed?: boolean;
    })
  | (PreviewBase & {
      kind: "text";
      x: number;
      y: number;
      text: string;
      fill?: string;
      anchor?: "start" | "middle" | "end";
      className?: string;
    });

export interface PreviewSpec {
  viewBox: string;
  background: string;
  elements: PreviewElement[];
  legend: Array<{
    label: string;
    swatch: string;
  }>;
}

type PrimitiveBase = {
  name?: string;
  position: Vec3;
  rotation?: Vec3;
  color: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
};

export type Primitive =
  | (PrimitiveBase & {
      shape: "box";
      size: Vec3;
    })
  | (PrimitiveBase & {
      shape: "cylinder";
      radiusTop: number;
      radiusBottom: number;
      height: number;
      radialSegments?: number;
    });

export interface FocusPoint {
  id: string;
  label: string;
  description: string;
  cameraPosition: Vec3;
  target: Vec3;
}

export interface SceneBlueprint {
  environment: {
    background: string;
    fog: string;
    ground: string;
    sun: string;
    fill: string;
  };
  groundSize: [number, number];
  primitives: Primitive[];
  focusPoints: FocusPoint[];
  defaultFocusId: string;
}

export interface SpawnNote {
  name: string;
  description: string;
  focusId: string;
}

export interface RouteNote {
  id: string;
  kind: Exclude<RouteKind, "spawn" | "landmark">;
  name: string;
  description: string;
  focusId: string;
}

export interface LandmarkNote {
  name: string;
  description: string;
  focusId: string;
}

export interface TeamSpawnZone {
  teamId: TeamId;
  label: string;
  description: string;
  focusId: string;
}

export interface BombSiteDefinition {
  id: string;
  label: string;
  description: string;
  focusId: string;
  routeIds: string[];
  radius: number;
}

export interface BombMissionDefinition {
  label: string;
  briefing: string;
  deliveryTeam: TeamId;
  holdTeam: TeamId;
  sites: BombSiteDefinition[];
  plantSeconds: number;
  defuseSeconds: number;
  fuseSeconds: number;
}

export interface HostageClusterDefinition {
  id: string;
  label: string;
  description: string;
  focusId: string;
  routeIds: string[];
  hostages: number;
}

export interface ExtractionZoneDefinition {
  label: string;
  description: string;
  focusId: string;
  routeIds: string[];
  radius: number;
}

export interface HostageMissionDefinition {
  label: string;
  briefing: string;
  rescueTeam: TeamId;
  holdTeam: TeamId;
  hostageClusters: HostageClusterDefinition[];
  extractionZone: ExtractionZoneDefinition;
}

export interface MapMissionSet {
  bomb?: BombMissionDefinition;
  hostage?: HostageMissionDefinition;
}

export interface MapDefinition {
  id: string;
  name: string;
  shortDescription: string;
  visualTheme: string;
  spawnSetup: string;
  cover: string;
  chokePoints: string;
  landmark: string;
  tacticalSummary: string;
  mainMap: boolean;
  preview: PreviewSpec;
  scene: SceneBlueprint;
  spawnNotes: SpawnNote[];
  teamSpawns: Record<TeamId, TeamSpawnZone>;
  tacticalRoutes: RouteNote[];
  supportedMissions: MissionType[];
  objectives: MapMissionSet;
  landmarks: LandmarkNote[];
}
