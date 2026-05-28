import type {
  BombSiteDefinition,
  ExtractionZoneDefinition,
  HostageClusterDefinition,
  LandmarkNote,
  MapDefinition,
  MapMissionSet,
  MissionType,
  PreviewElement,
  PreviewSpec,
  Primitive,
  RouteNote,
  SceneBlueprint,
  SpawnNote,
  TeamId,
  TeamSpawnZone,
  Vec3,
} from "../types";

const ROUTE_COLORS = {
  main: "#C9A062",
  corridor: "#5F8BA9",
  flank: "#7A9154",
  spawn: "#E2D3B3",
  landmark: "#E25F4C",
};

const DEFAULT_LEGEND = [
  { label: "Main lane", swatch: ROUTE_COLORS.main },
  { label: "Corridor route", swatch: ROUTE_COLORS.corridor },
  { label: "Flank route", swatch: ROUTE_COLORS.flank },
];

const v = (x: number, y: number, z: number): Vec3 => [x, y, z];

const box = (
  name: string,
  size: Vec3,
  position: Vec3,
  color: string,
  rotation?: Vec3,
  opacity?: number,
): Primitive => ({
  shape: "box",
  name,
  size,
  position,
  color,
  rotation,
  opacity,
});

const cylinder = (
  name: string,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: Vec3,
  color: string,
  radialSegments = 8,
): Primitive => ({
  shape: "cylinder",
  name,
  radiusTop,
  radiusBottom,
  height,
  radialSegments,
  position,
  color,
});

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke = "#0D1210",
  opacity?: number,
): PreviewElement => ({
  kind: "rect",
  x,
  y,
  width,
  height,
  fill,
  stroke,
  strokeWidth: 2,
  radius: 6,
  opacity,
});

const circle = (
  cx: number,
  cy: number,
  r: number,
  fill: string,
  stroke = "#0D1210",
): PreviewElement => ({
  kind: "circle",
  cx,
  cy,
  r,
  fill,
  stroke,
  strokeWidth: 2,
});

const route = (
  points: string,
  stroke: string,
  dashed = false,
): PreviewElement => ({
  kind: "polyline",
  points,
  stroke,
  strokeWidth: 7,
  dashed,
});

const text = (
  x: number,
  y: number,
  value: string,
  className = "preview__label",
  anchor: "start" | "middle" | "end" = "middle",
): PreviewElement => ({
  kind: "text",
  x,
  y,
  text: value,
  className,
  anchor,
});

const preview = (
  background: string,
  elements: PreviewElement[],
  legend = DEFAULT_LEGEND,
): PreviewSpec => ({
  viewBox: "0 0 260 200",
  background,
  elements,
  legend,
});

const sandlineFoundryScene: SceneBlueprint = {
  environment: {
    background: "#B7A078",
    fog: "#A48A64",
    ground: "#72624E",
    sun: "#F1D7AF",
    fill: "#C5B696",
  },
  groundSize: [62, 48],
  defaultFocusId: "courtyard",
  focusPoints: [
    {
      id: "south-spawn",
      label: "Water Tower Court",
      description: "South spawn with two early route exits.",
      cameraPosition: v(-2, 6.5, 27),
      target: v(-1, 2, 16),
    },
    {
      id: "north-spawn",
      label: "Blue Shutter Bay",
      description: "North spawn with loading-bay cover and a catwalk option.",
      cameraPosition: v(12, 7, -28),
      target: v(7, 2, -17),
    },
    {
      id: "courtyard",
      label: "Central Yard",
      description: "Open courtyard with broken sightlines and crate cover.",
      cameraPosition: v(18, 12, 19),
      target: v(0, 2, 0),
    },
    {
      id: "corridor",
      label: "Generator Hall",
      description: "Tighter west-side route for close engagements.",
      cameraPosition: v(-30, 7, 6),
      target: v(-16, 2, 1),
    },
    {
      id: "underpass",
      label: "Drain Underpass",
      description: "Covered flank route with side cover and a stair exit.",
      cameraPosition: v(26, 6, 14),
      target: v(15, 2, 3),
    },
    {
      id: "catwalk",
      label: "East Catwalk",
      description: "Semi-elevated overlook into mid and the loading bay.",
      cameraPosition: v(30, 10, -3),
      target: v(17, 4, -9),
    },
    {
      id: "loading-bay",
      label: "Loading Bay",
      description: "North-side landmark anchoring the main lane finish.",
      cameraPosition: v(16, 6, -5),
      target: v(8, 2, -13),
    },
  ],
  primitives: [
    box("West perimeter", v(2, 9, 42), v(-30, 4.5, 0), "#5F564A"),
    box("East perimeter", v(2, 9, 42), v(30, 4.5, 0), "#5F564A"),
    box("North perimeter", v(58, 9, 2), v(0, 4.5, -22), "#5B5146"),
    box("South perimeter", v(58, 9, 2), v(0, 4.5, 22), "#5B5146"),
    box("Main yard slab", v(18, 0.4, 31), v(0, 0.2, 0), "#8A7962"),
    box("South spawn slab", v(18, 0.4, 10), v(-1, 0.22, 16.5), "#927A5D"),
    box("North spawn slab", v(20, 0.4, 11), v(1, 0.22, -16), "#80715D"),
    box("Generator hall slab", v(11, 0.4, 30), v(-16, 0.22, 1), "#72665A"),
    box("Underpass slab", v(10, 0.4, 24), v(15, 0.22, 3), "#74614B"),
    box("Generator hall outer wall", v(2, 6, 30), v(-21, 3, 1), "#6F665C"),
    box("Generator hall inner north", v(2, 6, 12), v(-11, 3, -7), "#7C7163"),
    box("Generator hall inner south", v(2, 6, 10), v(-11, 3, 10), "#7C7163"),
    box("Generator hall north cap", v(10, 5, 2), v(-16, 2.5, -14), "#756B5D"),
    box("Generator hall south cap", v(10, 5, 2), v(-16, 2.5, 16), "#756B5D"),
    box("Generator core", v(4, 4, 4), v(-16, 2, 1), "#4A5457"),
    box("South shed", v(11, 5, 6), v(-10, 2.5, 18), "#6F7651"),
    box("South low building", v(13, 4, 4), v(11, 2, 19), "#8A5E44"),
    box("South divider wall", v(6, 2.2, 1), v(4, 1.1, 11), "#756253"),
    box("Crate island base", v(8, 2.2, 5), v(0, 1.1, 0), "#7F6039"),
    box("Crate stack west", v(3, 3, 3), v(-5, 1.5, 4), "#6F4F31"),
    box("Crate stack east", v(3, 3, 3), v(6, 1.5, -3), "#876241"),
    box("Low wall west", v(6, 2.2, 1), v(-8, 1.1, 6), "#6A6257"),
    box("Low wall east", v(6, 2.2, 1), v(8, 1.1, -5), "#6A6257"),
    box("Broken arch pillar west", v(2, 6, 2), v(-4, 3, -8), "#8D7C67"),
    box("Broken arch pillar east", v(2, 6, 2), v(4, 3, -8), "#8D7C67"),
    box("Broken arch lintel", v(10, 2, 2), v(0, 7, -8), "#7A6856"),
    box("North bay hall", v(18, 7, 8), v(8, 3.5, -17), "#627487"),
    box("North side stack", v(8, 6, 6), v(-13, 3, -18), "#6A6255"),
    box("Loading awning", v(10, 1, 4), v(8, 5.5, -11), "#8B503A"),
    box("Loading barrier", v(8, 2, 1), v(11, 1, -9), "#67615A"),
    box("Tunnel wall west", v(2, 5, 18), v(10, 2.5, 3), "#695A48"),
    box("Tunnel wall east", v(2, 5, 18), v(20, 2.5, 3), "#695A48"),
    box("Tunnel roof", v(10, 1.4, 18), v(15, 5.7, 3), "#50483F"),
    box("Tunnel cover left", v(3, 3, 3), v(12.5, 1.5, 7), "#7F6039"),
    box("Tunnel cover right", v(3, 3, 3), v(17.5, 1.5, -2), "#7F6039"),
    box("Catwalk deck", v(12, 0.8, 4), v(17, 5, -9), "#5C6164"),
    box("Catwalk rail west", v(12, 1, 0.6), v(17, 5.7, -11.2), "#3D4245"),
    box("Catwalk rail east", v(12, 1, 0.6), v(17, 5.7, -6.8), "#3D4245"),
    box("Catwalk support north", v(0.8, 5, 0.8), v(12, 2.5, -9), "#4A4E50"),
    box("Catwalk support south", v(0.8, 5, 0.8), v(22, 2.5, -9), "#4A4E50"),
    box("Catwalk stair 1", v(4, 0.8, 4), v(17, 0.5, -3), "#7C6B57"),
    box("Catwalk stair 2", v(4, 0.8, 4), v(17, 1.3, -5), "#7C6B57"),
    box("Catwalk stair 3", v(4, 0.8, 4), v(17, 2.1, -7), "#7C6B57"),
    box("Catwalk stair 4", v(4, 0.8, 4), v(17, 2.9, -9), "#7C6B57"),
    cylinder("Water tower tank", 2.7, 2.7, 4.4, v(-12, 7.2, 16), "#7E878B"),
    box("Water tower leg A", v(0.7, 6.4, 0.7), v(-13.7, 3.2, 14.3), "#505A5E"),
    box("Water tower leg B", v(0.7, 6.4, 0.7), v(-10.3, 3.2, 14.3), "#505A5E"),
    box("Water tower leg C", v(0.7, 6.4, 0.7), v(-13.7, 3.2, 17.7), "#505A5E"),
    box("Water tower leg D", v(0.7, 6.4, 0.7), v(-10.3, 3.2, 17.7), "#505A5E"),
    cylinder("South spawn beacon", 1.2, 1.2, 1.2, v(0, 0.8, 16), "#A7C673"),
    cylinder("North spawn beacon", 1.2, 1.2, 1.2, v(0, 0.8, -16), "#D38A68"),
  ],
};

const transitCratesScene: SceneBlueprint = {
  environment: {
    background: "#A18F74",
    fog: "#8A775F",
    ground: "#5D564F",
    sun: "#EED6B2",
    fill: "#CBB79E",
  },
  groundSize: [62, 48],
  defaultFocusId: "yard",
  focusPoints: [
    {
      id: "south-depot",
      label: "South Depot Apron",
      description: "South spawn buffered by a shed block and short cover before the lane opens.",
      cameraPosition: v(-2, 6.5, 25),
      target: v(-2, 2, 15),
    },
    {
      id: "north-wagon",
      label: "North Wagon Bay",
      description: "North spawn tucked behind the wagons and depot hall edge.",
      cameraPosition: v(10, 6.5, -26),
      target: v(3, 2, -15),
    },
    {
      id: "yard",
      label: "Container Lane",
      description: "Main cargo lane framed by crate stacks and a gantry.",
      cameraPosition: v(16, 11, 18),
      target: v(0, 2, 0),
    },
    {
      id: "shutter",
      label: "Shutter Alley",
      description: "Close-range corridor between depot walls.",
      cameraPosition: v(-27, 7, 8),
      target: v(-14, 2, 2),
    },
    {
      id: "rail",
      label: "Rail Flank",
      description: "Outer route behind the flatbed wagons.",
      cameraPosition: v(28, 7, -6),
      target: v(16, 2, -10),
    },
  ],
  primitives: [
    box("West wall", v(2, 8, 40), v(-30, 4, 0), "#59504A"),
    box("East wall", v(2, 8, 40), v(30, 4, 0), "#59504A"),
    box("North wall", v(56, 8, 2), v(0, 4, -20), "#544B45"),
    box("South wall", v(56, 8, 2), v(0, 4, 20), "#544B45"),
    box("Main pad", v(22, 0.4, 28), v(0, 0.2, 0), "#7E725F"),
    box("Shutter alley floor", v(10, 0.4, 26), v(-16, 0.2, 2), "#6A6257"),
    box("Rail floor", v(10, 0.4, 26), v(16, 0.2, -2), "#675D52"),
    box("Depot hall west", v(12, 6, 6), v(-14, 3, 16), "#6E7656"),
    box("Depot hall east", v(14, 6, 7), v(12, 3, -15), "#68788B"),
    box("Gantry tower west", v(2, 8, 2), v(-5, 4, 0), "#515A5E"),
    box("Gantry tower east", v(2, 8, 2), v(5, 4, 0), "#515A5E"),
    box("Gantry beam", v(14, 1.2, 2), v(0, 8.2, 0), "#465055"),
    box("Crate stack A", v(4, 3, 4), v(-8, 1.5, 6), "#7A593A"),
    box("Crate stack B", v(4, 3, 4), v(8, 1.5, -5), "#7A593A"),
    box("Crate stack C", v(3, 2, 5), v(2, 1, 8), "#8A6441"),
    box("Wagon A", v(8, 2.5, 3), v(16, 1.25, -10), "#7B4B3A"),
    box("Wagon B", v(8, 2.5, 3), v(16, 1.25, -2), "#7B4B3A"),
    box("Shutter wall outer", v(2, 6, 26), v(-21, 3, 2), "#645A50"),
    box("Shutter wall inner", v(2, 6, 18), v(-11, 3, -2), "#756A5D"),
    box("Shutter cap", v(10, 5, 2), v(-16, 2.5, -11), "#716657"),
    box("Forklift pad", v(6, 2, 1), v(10, 1, 9), "#66605A"),
    cylinder("Spawn beacon south", 1.1, 1.1, 1.1, v(-2, 0.7, 15), "#ABC873"),
    cylinder("Spawn beacon north", 1.1, 1.1, 1.1, v(3, 0.7, -15), "#D7986E"),
  ],
};

const breakerVaultScene: SceneBlueprint = {
  environment: {
    background: "#8A8E90",
    fog: "#72777B",
    ground: "#52585D",
    sun: "#D8DDE1",
    fill: "#C2C8CD",
  },
  groundSize: [58, 46],
  defaultFocusId: "pit",
  focusPoints: [
    {
      id: "south-apron",
      label: "South Bunker Apron",
      description: "South spawn with quick access into the pit rim or drain route.",
      cameraPosition: v(-4, 6.5, 23),
      target: v(-1, 2, 14),
    },
    {
      id: "north-apron",
      label: "North Bunker Apron",
      description: "North spawn protected by the bunker lip before the first peek.",
      cameraPosition: v(6, 6.5, -24),
      target: v(2, 2, -14),
    },
    {
      id: "pit",
      label: "Turbine Pit",
      description: "Sunken center with split sightlines and short ramps.",
      cameraPosition: v(17, 11, 20),
      target: v(0, 1, 0),
    },
    {
      id: "blast-door",
      label: "Blast Door Hall",
      description: "Tight bunker corridor with hard cover corners.",
      cameraPosition: v(-26, 7, 6),
      target: v(-14, 2, -1),
    },
    {
      id: "drain-flank",
      label: "Drain Flank",
      description: "Concrete drain route looping back into the pit.",
      cameraPosition: v(27, 6, -2),
      target: v(14, 2, -7),
    },
  ],
  primitives: [
    box("Outer wall west", v(2, 8, 38), v(-28, 4, 0), "#52585E"),
    box("Outer wall east", v(2, 8, 38), v(28, 4, 0), "#52585E"),
    box("Outer wall north", v(54, 8, 2), v(0, 4, -19), "#474E53"),
    box("Outer wall south", v(54, 8, 2), v(0, 4, 19), "#474E53"),
    box("Main bunker floor", v(22, 0.4, 26), v(0, 0.2, 0), "#70757A"),
    box("Blast hall floor", v(10, 0.4, 24), v(-15, 0.2, 0), "#646B71"),
    box("Drain flank floor", v(10, 0.4, 24), v(15, 0.2, -2), "#5B6469"),
    box("Pit rim", v(12, 1.4, 12), v(0, 0.7, 0), "#7B8086"),
    box("Pit core", v(8, 1, 8), v(0, 0.5, 0), "#43484D"),
    box("Blast hall outer", v(2, 6, 24), v(-20, 3, 0), "#596066"),
    box("Blast hall inner north", v(2, 6, 10), v(-10, 3, -7), "#6C7379"),
    box("Blast hall inner south", v(2, 6, 10), v(-10, 3, 7), "#6C7379"),
    box("Blast door north", v(8, 5, 1.4), v(-15, 2.5, -12), "#69757D"),
    box("Blast door south", v(8, 5, 1.4), v(-15, 2.5, 12), "#69757D"),
    box("Drain wall west", v(2, 4.5, 20), v(10, 2.25, -2), "#5D6468"),
    box("Drain wall east", v(2, 4.5, 20), v(20, 2.25, -2), "#5D6468"),
    box("Drain bridge", v(10, 1, 4), v(15, 3.8, -9), "#4A5054"),
    box("Drain stair 1", v(4, 0.8, 4), v(15, 0.5, 3), "#72787D"),
    box("Drain stair 2", v(4, 0.8, 4), v(15, 1.3, 0), "#72787D"),
    box("Drain stair 3", v(4, 0.8, 4), v(15, 2.1, -3), "#72787D"),
    box("Barrier A", v(6, 2, 1), v(-6, 1, 6), "#5B6065"),
    box("Barrier B", v(6, 2, 1), v(8, 1, -5), "#5B6065"),
    cylinder("Spawn beacon south", 1.1, 1.1, 1.1, v(-1, 0.7, 14), "#9CC46E"),
    cylinder("Spawn beacon north", 1.1, 1.1, 1.1, v(2, 0.7, -14), "#D89A73"),
  ],
};

const quarrySlipScene: SceneBlueprint = {
  environment: {
    background: "#8F968E",
    fog: "#767E75",
    ground: "#575C56",
    sun: "#D8DCCF",
    fill: "#BCC6BB",
  },
  groundSize: [60, 48],
  defaultFocusId: "slip-yard",
  focusPoints: [
    {
      id: "south-pocket",
      label: "South Loading Pocket",
      description: "South spawn behind the concrete berms before the yard opens.",
      cameraPosition: v(-4, 6.5, 24),
      target: v(-1, 2, 14),
    },
    {
      id: "north-slip",
      label: "North Cargo Slip",
      description: "North spawn tucked by the cargo shed and slip edge.",
      cameraPosition: v(8, 6.5, -25),
      target: v(1, 2, -14),
    },
    {
      id: "slip-yard",
      label: "Slip Yard",
      description: "Open dock lane broken by concrete berms and container cover.",
      cameraPosition: v(17, 11, 18),
      target: v(0, 2, 0),
    },
    {
      id: "office-run",
      label: "Harbor Office Run",
      description: "Indoor lane with short cover and blind corners.",
      cameraPosition: v(-26, 7, 8),
      target: v(-14, 2, 1),
    },
    {
      id: "pier-catwalk",
      label: "Pier Catwalk",
      description: "Raised flank above the water-side edge.",
      cameraPosition: v(28, 9, -4),
      target: v(16, 4, -8),
    },
  ],
  primitives: [
    box("West quay wall", v(2, 8, 40), v(-29, 4, 0), "#505750"),
    box("East seawall", v(2, 8, 40), v(29, 4, 0), "#4A514B"),
    box("North wall", v(54, 8, 2), v(0, 4, -20), "#4D534E"),
    box("South wall", v(54, 8, 2), v(0, 4, 20), "#4D534E"),
    box("Slip lane floor", v(20, 0.4, 28), v(0, 0.2, 0), "#70756D"),
    box("Office run floor", v(10, 0.4, 25), v(-15, 0.2, 1), "#666D66"),
    box("Pier floor", v(10, 0.4, 23), v(15, 0.2, -2), "#686E68"),
    box("Harbor office", v(12, 6, 8), v(-14, 3, 15), "#667562"),
    box("Cargo shed", v(14, 6, 8), v(11, 3, -15), "#657585"),
    box("Concrete berm A", v(7, 2, 1), v(-6, 1, 5), "#6E736D"),
    box("Concrete berm B", v(7, 2, 1), v(7, 1, -5), "#6E736D"),
    box("Container A", v(8, 3, 4), v(-8, 1.5, -2), "#7C5644"),
    box("Container B", v(8, 3, 4), v(8, 1.5, 4), "#7C5644"),
    box("Office wall outer", v(2, 6, 25), v(-20, 3, 1), "#59605A"),
    box("Office wall inner", v(2, 6, 17), v(-10, 3, -3), "#6B726C"),
    box("Pier catwalk", v(12, 0.8, 4), v(17, 4.8, -8), "#505759"),
    box("Pier rail A", v(12, 1, 0.6), v(17, 5.4, -10.2), "#3E4445"),
    box("Pier rail B", v(12, 1, 0.6), v(17, 5.4, -5.8), "#3E4445"),
    box("Pier support A", v(0.8, 4.8, 0.8), v(12, 2.4, -8), "#43494A"),
    box("Pier support B", v(0.8, 4.8, 0.8), v(22, 2.4, -8), "#43494A"),
    box("Mooring crane mast", v(2, 10, 2), v(4, 5, -10), "#646C6D"),
    box("Mooring crane beam", v(10, 1.2, 2), v(8, 9.4, -10), "#535B5D"),
    cylinder("Spawn beacon south", 1.1, 1.1, 1.1, v(-1, 0.7, 14), "#A7C874"),
    cylinder("Spawn beacon north", 1.1, 1.1, 1.1, v(1, 0.7, -14), "#D89A72"),
  ],
};

const ledgerAnnexScene: SceneBlueprint = {
  environment: {
    background: "#A7A393",
    fog: "#8C8776",
    ground: "#5E5B53",
    sun: "#E5DEC9",
    fill: "#C8C0AA",
  },
  groundSize: [58, 46],
  defaultFocusId: "archive-court",
  focusPoints: [
    {
      id: "south-admin",
      label: "South Admin Entry",
      description: "South spawn screened by shelves before the court opens.",
      cameraPosition: v(-4, 6.5, 24),
      target: v(-1, 2, 14),
    },
    {
      id: "north-wing",
      label: "North Archive Wing",
      description: "North spawn buffered by the archive block and backline pillars.",
      cameraPosition: v(8, 6.5, -24),
      target: v(2, 2, -14),
    },
    {
      id: "archive-court",
      label: "Archive Court",
      description: "Central admin court with shelves, low walls, and fast crossfire.",
      cameraPosition: v(18, 11, 18),
      target: v(0, 2, 0),
    },
    {
      id: "records-run",
      label: "Records Run",
      description: "Interior lane between boxed archives and concrete pillars.",
      cameraPosition: v(-27, 7, 7),
      target: v(-14, 2, 0),
    },
    {
      id: "bridge-flank",
      label: "Archive Bridge",
      description: "Raised flank above the side storage lane.",
      cameraPosition: v(28, 9, -4),
      target: v(16, 4, -8),
    },
  ],
  primitives: [
    box("West wall", v(2, 8, 38), v(-28, 4, 0), "#56524B"),
    box("East wall", v(2, 8, 38), v(28, 4, 0), "#56524B"),
    box("North wall", v(54, 8, 2), v(0, 4, -19), "#514C45"),
    box("South wall", v(54, 8, 2), v(0, 4, 19), "#514C45"),
    box("Court floor", v(20, 0.4, 28), v(0, 0.2, 0), "#777262"),
    box("Records floor", v(10, 0.4, 24), v(-15, 0.2, 0), "#6B665D"),
    box("Storage floor", v(10, 0.4, 24), v(15, 0.2, -2), "#6A665C"),
    box("Admin block", v(12, 6, 7), v(-14, 3, 15), "#677056"),
    box("Archive wing", v(14, 6, 8), v(11, 3, -15), "#706B86"),
    box("Shelf stack A", v(5, 3, 2), v(-7, 1.5, 4), "#7B5A38"),
    box("Shelf stack B", v(5, 3, 2), v(7, 1.5, -4), "#7B5A38"),
    box("Low divider west", v(7, 2, 1), v(-6, 1, -5), "#626056"),
    box("Low divider east", v(7, 2, 1), v(7, 1, 5), "#626056"),
    box("Records outer wall", v(2, 6, 24), v(-20, 3, 0), "#5B5750"),
    box("Records inner wall", v(2, 6, 16), v(-10, 3, -3), "#6E695E"),
    box("Archive bridge", v(12, 0.8, 4), v(17, 4.8, -8), "#56595F"),
    box("Archive bridge rail A", v(12, 1, 0.6), v(17, 5.4, -10.2), "#43464A"),
    box("Archive bridge rail B", v(12, 1, 0.6), v(17, 5.4, -5.8), "#43464A"),
    box("Bridge support A", v(0.8, 4.8, 0.8), v(12, 2.4, -8), "#43464A"),
    box("Bridge support B", v(0.8, 4.8, 0.8), v(22, 2.4, -8), "#43464A"),
    box("Pillar A", v(2, 6, 2), v(-1, 3, 1), "#605C53"),
    box("Pillar B", v(2, 6, 2), v(5, 3, -2), "#605C53"),
    cylinder("Spawn beacon south", 1.1, 1.1, 1.1, v(-1, 0.7, 14), "#A8C874"),
    cylinder("Spawn beacon north", 1.1, 1.1, 1.1, v(2, 0.7, -14), "#D89A72"),
  ],
};

function spawnZone(teamId: TeamId, label: string, description: string, focusId: string): TeamSpawnZone {
  return {
    teamId,
    label,
    description,
    focusId,
  };
}

function spawnNotesFromTeams(teamSpawns: Record<TeamId, TeamSpawnZone>): SpawnNote[] {
  return Object.values(teamSpawns).map((spawn) => ({
    name: spawn.label,
    description: spawn.description,
    focusId: spawn.focusId,
  }));
}

function bombSite(
  id: string,
  label: string,
  description: string,
  focusId: string,
  routeIds: string[],
  radius = 4.8,
): BombSiteDefinition {
  return {
    id,
    label,
    description,
    focusId,
    routeIds,
    radius,
  };
}

function hostageCluster(
  id: string,
  label: string,
  description: string,
  focusId: string,
  routeIds: string[],
  hostages = 2,
): HostageClusterDefinition {
  return {
    id,
    label,
    description,
    focusId,
    routeIds,
    hostages,
  };
}

function extractionZone(
  label: string,
  description: string,
  focusId: string,
  routeIds: string[],
  radius = 5.4,
): ExtractionZoneDefinition {
  return {
    label,
    description,
    focusId,
    routeIds,
    radius,
  };
}

function mapDetails(
  teamSpawns: Record<TeamId, TeamSpawnZone>,
  tacticalRoutes: RouteNote[],
  landmarks: LandmarkNote[],
  objectives: MapMissionSet,
  supportedMissions: MissionType[] = ["bomb", "hostage"],
): {
  spawnNotes: SpawnNote[];
  teamSpawns: Record<TeamId, TeamSpawnZone>;
  tacticalRoutes: RouteNote[];
  landmarks: LandmarkNote[];
  objectives: MapMissionSet;
  supportedMissions: MissionType[];
} {
  return {
    spawnNotes: spawnNotesFromTeams(teamSpawns),
    teamSpawns,
    tacticalRoutes,
    landmarks,
    objectives,
    supportedMissions,
  };
}

export const mapCatalog: MapDefinition[] = [
  {
    id: "sandline-foundry",
    name: "Sandline Foundry",
    shortDescription:
      "A sun-baked industrial compound with a central yard, a west generator corridor, and an east underpass-catwalk flank.",
    visualTheme:
      "Dusty plaster walls, rusted shutters, blue loading metal, and a muted tan industrial yard.",
    spawnSetup:
      "Water Tower Court in the south and Blue Shutter Bay in the north, each with two immediate route choices.",
    cover:
      "Crate island cover, low walls, tunnel boxes, loading barriers, and corridor corners.",
    chokePoints:
      "Broken Arch mid-crossing, Generator Hall elbows, and the catwalk stair exit.",
    landmark:
      "The east catwalk over the underpass defines the flank and overlooks both the central yard and loading bay.",
    tacticalSummary:
      "Main lane pushes through Central Yard, a tighter Generator Hall route hugs the west wall, and a Drain Underpass flank rises into the East Catwalk before reconnecting near Blue Shutter Bay.",
    mainMap: true,
    preview: preview("#11140F", [
      rect(22, 22, 42, 44, "#586149"),
      rect(180, 22, 50, 48, "#5C6D7F"),
      rect(36, 70, 36, 94, "#494E4B"),
      rect(184, 76, 34, 76, "#514539"),
      rect(94, 74, 70, 54, "#7A6243"),
      rect(114, 84, 34, 22, "#9D825A"),
      route("129,168 129,132 129,116 129,92 129,56 129,28", ROUTE_COLORS.main),
      route("54,158 54,132 54,104 54,78 54,50 96,50", ROUTE_COLORS.corridor),
      route("208,150 208,126 208,104 208,80 194,60 164,60", ROUTE_COLORS.flank),
      circle(129, 164, 8, ROUTE_COLORS.spawn),
      circle(129, 32, 8, ROUTE_COLORS.spawn),
      circle(94, 30, 6, ROUTE_COLORS.landmark),
      circle(129, 100, 6, ROUTE_COLORS.landmark),
      circle(206, 60, 6, ROUTE_COLORS.landmark),
      text(129, 18, "Blue Shutter Bay"),
      text(129, 190, "Water Tower Court"),
      text(129, 114, "Central Yard"),
      text(54, 176, "Generator Hall", "preview__sub"),
      text(208, 168, "Drain Underpass", "preview__sub"),
    ]),
    scene: sandlineFoundryScene,
    ...mapDetails(
      {
        amber: spawnZone(
          "amber",
          "Water Tower Court",
          "Amber Vanguard stages in the south court behind the water tower legs and divider wall.",
          "south-spawn",
        ),
        cobalt: spawnZone(
          "cobalt",
          "Blue Shutter Bay",
          "Cobalt Reach stages in the north bay behind the loading awning and stack offset.",
          "north-spawn",
        ),
      },
      [
        {
          id: "main-yard",
          kind: "main",
          name: "Central Yard",
          description:
            "Medium-length mid lane with the Broken Arch and crate island breaking the longest sightline.",
          focusId: "courtyard",
        },
        {
          id: "generator-hall",
          kind: "corridor",
          name: "Generator Hall",
          description:
            "Roofless interior-feel corridor with tight turns, close cover, and quick rotations into mid.",
          focusId: "corridor",
        },
        {
          id: "drain-underpass",
          kind: "flank",
          name: "Drain Underpass",
          description:
            "Covered east route that reconnects through the catwalk and the loading-bay edge.",
          focusId: "underpass",
        },
      ],
      [
        {
          name: "Water Tower",
          description: "Tall south-side silhouette that anchors the spawn court.",
          focusId: "south-spawn",
        },
        {
          name: "Broken Arch",
          description:
            "Mid-lane arch that creates a recognizable choke without exposing the whole yard.",
          focusId: "courtyard",
        },
        {
          name: "Crate Island",
          description:
            "Central cover cluster that supports peeking, crossing, and recovering after a duel.",
          focusId: "courtyard",
        },
        {
          name: "Blue Shutter Loading Bay",
          description:
            "Northern landmark that marks the end of the main lane and a catwalk reconnection point.",
          focusId: "loading-bay",
        },
        {
          name: "East Catwalk",
          description:
            "Semi-elevated platform that adds readable verticality without turning the arena into a parkour map.",
          focusId: "catwalk",
        },
      ],
      {
        bomb: {
          label: "Relay Charge",
          briefing:
            "Amber Vanguard can arm either the Kiln Yard relay or the Shutter Lift panel while Cobalt Reach hold the clock.",
          deliveryTeam: "amber",
          holdTeam: "cobalt",
          plantSeconds: 3.4,
          defuseSeconds: 4.2,
          sites: [
            bombSite(
              "kiln-yard",
              "Kiln Yard",
              "Crate-island pressure point in the middle of the foundry yard.",
              "courtyard",
              ["main-yard", "generator-hall"],
            ),
            bombSite(
              "shutter-lift",
              "Shutter Lift",
              "North loading relay tucked below the blue awning and catwalk return.",
              "loading-bay",
              ["drain-underpass", "main-yard"],
            ),
          ],
        },
        hostage: {
          label: "Evac Escort",
          briefing:
            "Cobalt Reach must secure pinned workers and escort them back through the south court before Amber Vanguard collapse the route.",
          rescueTeam: "cobalt",
          holdTeam: "amber",
          hostageClusters: [
            hostageCluster(
              "generator-workers",
              "Generator Workers",
              "Crew held inside the west corridor where tight cover limits the first peek.",
              "corridor",
              ["generator-hall", "main-yard"],
            ),
            hostageCluster(
              "loading-crew",
              "Loading Crew",
              "Stragglers trapped near the loading rail at the north edge.",
              "loading-bay",
              ["drain-underpass", "main-yard"],
            ),
          ],
          extractionZone: extractionZone(
            "Water Tower Gate",
            "South-side release pocket sheltered by the tower legs and divider wall.",
            "south-spawn",
            ["main-yard", "generator-hall"],
          ),
        },
      },
    ),
  },
  {
    id: "transit-crates",
    name: "Transit Crates",
    shortDescription:
      "A freight depot built around a gantry lane, a shutter alley, and a rail-side flank behind flatbeds.",
    visualTheme:
      "Muted rail-yard concrete, red wagons, olive depot sheds, and weathered blue metal.",
    spawnSetup:
      "South depot apron and north wagon bay with offset cover before the first peek.",
    cover:
      "Flatbed wagons, pallet stacks, crate piles, and concrete service barriers.",
    chokePoints:
      "The gantry cross, shutter-alley elbow, and rail exit behind the wagons.",
    landmark:
      "The overhead gantry crane is visible from every route and gives instant orientation.",
    tacticalSummary:
      "Main fights break under the gantry, the west shutter alley compresses range, and the east rail lane gives a longer flank with wagon cover.",
    mainMap: false,
    preview: preview("#101310", [
      rect(24, 26, 46, 42, "#586048"),
      rect(178, 28, 54, 42, "#5E7080"),
      rect(36, 74, 34, 86, "#4A4F4C"),
      rect(184, 78, 34, 72, "#554A3B"),
      rect(102, 82, 56, 36, "#6B6C66"),
      route("129,166 129,142 129,116 129,90 129,58 129,34", ROUTE_COLORS.main),
      route("54,152 54,126 54,98 54,72 104,72", ROUTE_COLORS.corridor),
      route("206,150 206,124 206,98 206,74 180,56 156,56", ROUTE_COLORS.flank),
      circle(122, 158, 8, ROUTE_COLORS.spawn),
      circle(136, 42, 8, ROUTE_COLORS.spawn),
      circle(129, 84, 6, ROUTE_COLORS.landmark),
      text(129, 18, "North Wagon Bay"),
      text(129, 190, "South Depot Apron"),
      text(129, 102, "Gantry Cross"),
      text(52, 176, "Shutter Alley", "preview__sub"),
      text(206, 170, "Rail Flank", "preview__sub"),
    ]),
    scene: transitCratesScene,
    ...mapDetails(
      {
        amber: spawnZone(
          "amber",
          "South Depot Apron",
          "Amber Vanguard stage on the south apron with shed cover before the lane opens.",
          "south-depot",
        ),
        cobalt: spawnZone(
          "cobalt",
          "North Wagon Bay",
          "Cobalt Reach hold the north wagons with the blue hall and flatbeds shielding first contact.",
          "north-wagon",
        ),
      },
      [
        {
          id: "container-lane",
          kind: "main",
          name: "Container Lane",
          description:
            "Fastest route through the middle, broken by the gantry and crate stacks.",
          focusId: "yard",
        },
        {
          id: "shutter-alley",
          kind: "corridor",
          name: "Shutter Alley",
          description: "A left-side route that favors tighter angles and quick swings.",
          focusId: "shutter",
        },
        {
          id: "rail-flank",
          kind: "flank",
          name: "Rail Flank",
          description: "Longer outside route using wagons as intermittent cover.",
          focusId: "rail",
        },
      ],
      [
        {
          name: "Gantry Crane",
          description: "The yard's overhead silhouette and central landmark.",
          focusId: "yard",
        },
        {
          name: "Flatbed Wagons",
          description: "Rail-lane cover pieces that break otherwise long sightlines.",
          focusId: "rail",
        },
        {
          name: "Shutter Alley",
          description: "A named close-range lane with elbow turns and hard corners.",
          focusId: "shutter",
        },
      ],
      {
        bomb: {
          label: "Relay Charge",
          briefing:
            "Amber Vanguard can wire the gantry console or the wagon switch while Cobalt Reach defend the depot clock.",
          deliveryTeam: "amber",
          holdTeam: "cobalt",
          plantSeconds: 3.5,
          defuseSeconds: 4.3,
          sites: [
            bombSite(
              "gantry-console",
              "Gantry Console",
              "Central control point exposed under the overhead beam.",
              "yard",
              ["container-lane", "shutter-alley"],
            ),
            bombSite(
              "wagon-switch",
              "Wagon Switch",
              "Rail-side signal panel protected by flatbed cover.",
              "rail",
              ["rail-flank", "container-lane"],
            ),
          ],
        },
        hostage: {
          label: "Evac Escort",
          briefing:
            "Cobalt Reach must recover trapped freight staff and bring them clear through the north wagons before Amber Vanguard close the lanes.",
          rescueTeam: "cobalt",
          holdTeam: "amber",
          hostageClusters: [
            hostageCluster(
              "shutter-staff",
              "Shutter Staff",
              "Rail clerks trapped along the west service alley.",
              "shutter",
              ["shutter-alley", "container-lane"],
            ),
            hostageCluster(
              "gantry-riggers",
              "Gantry Riggers",
              "Cargo riggers pinned beneath the central crane line.",
              "yard",
              ["container-lane", "rail-flank"],
            ),
          ],
          extractionZone: extractionZone(
            "North Wagon Lane",
            "Rail-side release point behind the flatbed wagons.",
            "rail",
            ["rail-flank", "container-lane"],
          ),
        },
      },
    ),
  },
  {
    id: "breaker-vault",
    name: "Breaker Vault",
    shortDescription:
      "A concrete bunker arena with a turbine pit center, blast-door hall, and a drain-flank loop.",
    visualTheme:
      "Cold concrete, bunker steel, drainage channels, and gray-green industrial lighting.",
    spawnSetup:
      "Opposing bunker aprons with immediate access to mid or the side corridors.",
    cover:
      "Pit rim edges, concrete barriers, blast-door frames, and drain-lane walls.",
    chokePoints:
      "The pit lip, blast-door swing, and the drain bridge reconnecting into center.",
    landmark:
      "A sunken turbine pit at center gives the map a unique silhouette and rotation anchor.",
    tacticalSummary:
      "Mid tension runs around the pit rim, the west blast hall is the tight brawl route, and the east drain route loops through a short elevated bridge.",
    mainMap: false,
    preview: preview("#0F1212", [
      rect(22, 26, 44, 40, "#5A6265"),
      rect(178, 28, 52, 44, "#657177"),
      rect(36, 74, 34, 84, "#484F53"),
      rect(184, 76, 34, 72, "#4A555A"),
      rect(106, 76, 48, 48, "#6B7176"),
      rect(114, 84, 32, 32, "#3E4449"),
      route("129,166 129,138 129,122 129,96 129,62 129,34", ROUTE_COLORS.main),
      route("54,152 54,126 54,98 54,74 98,74", ROUTE_COLORS.corridor),
      route("206,146 206,124 206,102 206,80 174,60 152,60", ROUTE_COLORS.flank),
      circle(122, 158, 8, ROUTE_COLORS.spawn),
      circle(136, 42, 8, ROUTE_COLORS.spawn),
      circle(130, 100, 6, ROUTE_COLORS.landmark),
      text(129, 18, "North Bunker Apron"),
      text(129, 190, "South Bunker Apron"),
      text(129, 106, "Turbine Pit"),
      text(54, 176, "Blast Door Hall", "preview__sub"),
      text(206, 168, "Drain Flank", "preview__sub"),
    ]),
    scene: breakerVaultScene,
    ...mapDetails(
      {
        amber: spawnZone(
          "amber",
          "South Bunker Apron",
          "Amber Vanguard stage on the south apron with immediate access to pit pressure or the drain loop.",
          "south-apron",
        ),
        cobalt: spawnZone(
          "cobalt",
          "North Bunker Apron",
          "Cobalt Reach hold the north bunker with pit rim cover on the opening beat.",
          "north-apron",
        ),
      },
      [
        {
          id: "pit-rim",
          kind: "main",
          name: "Pit Rim",
          description: "The fastest path across center with short drop and ramp decisions.",
          focusId: "pit",
        },
        {
          id: "blast-door-hall",
          kind: "corridor",
          name: "Blast Door Hall",
          description:
            "A west bunker lane that compresses fights into short cover transitions.",
          focusId: "blast-door",
        },
        {
          id: "drain-route",
          kind: "flank",
          name: "Drain Route",
          description:
            "Right-side loop through the drainage channel and a short bridge back to center.",
          focusId: "drain-flank",
        },
      ],
      [
        {
          name: "Turbine Pit",
          description: "Sunken center that makes the map readable after one round.",
          focusId: "pit",
        },
        {
          name: "Blast Doors",
          description: "Heavy steel frames marking the west-side corridor.",
          focusId: "blast-door",
        },
        {
          name: "Drain Bridge",
          description: "A small elevated crossing that finishes the flank loop.",
          focusId: "drain-flank",
        },
      ],
      {
        bomb: {
          label: "Relay Charge",
          briefing:
            "Amber Vanguard can arm either the turbine rim or the blast lock while Cobalt Reach work the bunker timer.",
          deliveryTeam: "amber",
          holdTeam: "cobalt",
          plantSeconds: 3.5,
          defuseSeconds: 4.4,
          sites: [
            bombSite(
              "turbine-rim",
              "Turbine Rim",
              "Center platform overlooking the pit and both bunker lips.",
              "pit",
              ["pit-rim", "drain-route"],
            ),
            bombSite(
              "blast-lock",
              "Blast Lock",
              "Heavy west-side control door beside the blast hall frames.",
              "blast-door",
              ["blast-door-hall", "pit-rim"],
            ),
          ],
        },
        hostage: {
          label: "Evac Escort",
          briefing:
            "Cobalt Reach must recover bunker staff and route them out through the north apron before Amber Vanguard cut off the bridge.",
          rescueTeam: "cobalt",
          holdTeam: "amber",
          hostageClusters: [
            hostageCluster(
              "drain-crew",
              "Drain Crew",
              "Maintenance team pinned near the east drainage route.",
              "drain-flank",
              ["drain-route", "pit-rim"],
            ),
            hostageCluster(
              "blast-staff",
              "Blast Staff",
              "Bunker clerks trapped near the west blast hall.",
              "blast-door",
              ["blast-door-hall", "pit-rim"],
            ),
          ],
          extractionZone: extractionZone(
            "North Bunker Exit",
            "Rear apron release zone shielded by the bunker lip.",
            "pit",
            ["pit-rim", "drain-route"],
          ),
        },
      },
    ),
  },
  {
    id: "quarry-slip",
    name: "Quarry Slip",
    shortDescription:
      "A dockside shipping lot with a mooring crane, harbor office lane, and a raised pier catwalk flank.",
    visualTheme:
      "Weathered dock concrete, muted green metal, blue cargo sheds, and low-contrast harbor grime.",
    spawnSetup:
      "South loading pocket and north cargo slip, both sheltered by low berms and structure edges.",
    cover:
      "Container stacks, concrete berms, office walls, and pier supports.",
    chokePoints:
      "The slip-yard cross, office-run exit, and the pier catwalk drop back into main.",
    landmark:
      "The mooring crane and pier catwalk give the map a readable harbor identity.",
    tacticalSummary:
      "Slip Yard is the straight contest, Harbor Office Run is the tighter lane, and the Pier Catwalk is a controlled elevated flank above the water-side edge.",
    mainMap: false,
    preview: preview("#101311", [
      rect(24, 26, 46, 42, "#55644B"),
      rect(178, 28, 52, 44, "#5A6E7B"),
      rect(36, 74, 34, 84, "#4A504B"),
      rect(184, 76, 34, 72, "#4C5751"),
      rect(102, 80, 56, 40, "#6A6F68"),
      route("129,166 129,142 129,118 129,92 129,58 129,34", ROUTE_COLORS.main),
      route("54,152 54,126 54,98 54,74 102,74", ROUTE_COLORS.corridor),
      route("206,146 206,122 206,96 206,76 176,58 154,58", ROUTE_COLORS.flank),
      circle(122, 158, 8, ROUTE_COLORS.spawn),
      circle(136, 42, 8, ROUTE_COLORS.spawn),
      circle(162, 68, 6, ROUTE_COLORS.landmark),
      text(129, 18, "North Cargo Slip"),
      text(129, 190, "South Loading Pocket"),
      text(129, 102, "Slip Yard"),
      text(54, 176, "Harbor Office Run", "preview__sub"),
      text(206, 168, "Pier Catwalk", "preview__sub"),
    ]),
    scene: quarrySlipScene,
    ...mapDetails(
      {
        amber: spawnZone(
          "amber",
          "South Loading Pocket",
          "Amber Vanguard stage behind the south berms with fast access into Slip Yard.",
          "south-pocket",
        ),
        cobalt: spawnZone(
          "cobalt",
          "North Cargo Slip",
          "Cobalt Reach hold the north cargo slip with shed corners and container cover.",
          "north-slip",
        ),
      },
      [
        {
          id: "slip-yard",
          kind: "main",
          name: "Slip Yard",
          description: "Open middle route with broken lines through berms and container cover.",
          focusId: "slip-yard",
        },
        {
          id: "office-run",
          kind: "corridor",
          name: "Harbor Office Run",
          description: "Left-side lane that trades long sightlines for close corner fights.",
          focusId: "office-run",
        },
        {
          id: "pier-catwalk",
          kind: "flank",
          name: "Pier Catwalk",
          description:
            "An elevated right-side flank that reconnects above the north-side shed.",
          focusId: "pier-catwalk",
        },
      ],
      [
        {
          name: "Mooring Crane",
          description: "Tall center-right marker that sells the harbor identity.",
          focusId: "slip-yard",
        },
        {
          name: "Harbor Office",
          description: "Named left-side building guiding the close-range route.",
          focusId: "office-run",
        },
        {
          name: "Pier Catwalk",
          description: "Raised flank with readable, limited verticality.",
          focusId: "pier-catwalk",
        },
      ],
      {
        bomb: {
          label: "Relay Charge",
          briefing:
            "Amber Vanguard can arm the slip cradle or the pier winch while Cobalt Reach control the harbor timer.",
          deliveryTeam: "amber",
          holdTeam: "cobalt",
          plantSeconds: 3.4,
          defuseSeconds: 4.1,
          sites: [
            bombSite(
              "slip-cradle",
              "Slip Cradle",
              "Dockside relay in the center yard between the berms and containers.",
              "slip-yard",
              ["slip-yard", "office-run"],
            ),
            bombSite(
              "pier-winch",
              "Pier Winch",
              "Winch controls tucked beside the raised pier catwalk.",
              "pier-catwalk",
              ["pier-catwalk", "slip-yard"],
            ),
          ],
        },
        hostage: {
          label: "Evac Escort",
          briefing:
            "Cobalt Reach must clear dock workers and bring them through the north slip before Amber Vanguard lock the shoreline.",
          rescueTeam: "cobalt",
          holdTeam: "amber",
          hostageClusters: [
            hostageCluster(
              "office-staff",
              "Office Staff",
              "Harbor office crew trapped in the left-side admin lane.",
              "office-run",
              ["office-run", "slip-yard"],
            ),
            hostageCluster(
              "crane-team",
              "Crane Team",
              "Pier workers pinned under the mooring crane sightline.",
              "slip-yard",
              ["slip-yard", "pier-catwalk"],
            ),
          ],
          extractionZone: extractionZone(
            "North Cargo Release",
            "Cargo slip release line tucked beside the north shed.",
            "pier-catwalk",
            ["pier-catwalk", "slip-yard"],
          ),
        },
      },
    ),
  },
  {
    id: "ledger-annex",
    name: "Ledger Annex",
    shortDescription:
      "An office-storage compound with an archive court center, a boxed records run, and a raised bridge flank.",
    visualTheme:
      "Tan office concrete, olive admin walls, mauve-gray archive metal, and dusty storage props.",
    spawnSetup:
      "South admin entry and north archive wing, each buffered by shelves and low dividers.",
    cover:
      "Shelf stacks, court dividers, pillars, and bridge supports.",
    chokePoints:
      "Archive Court crossings, the records-run elbow, and the bridge drop near the archive wing.",
    landmark:
      "The Archive Bridge cuts above the storage lane and gives the map a readable internal silhouette.",
    tacticalSummary:
      "Archive Court is the central pull, Records Run is the close corridor, and Archive Bridge is the semi-elevated flank above the storage side.",
    mainMap: false,
    preview: preview("#111310", [
      rect(24, 26, 46, 42, "#586048"),
      rect(178, 28, 52, 44, "#706A86"),
      rect(36, 74, 34, 84, "#4B4A44"),
      rect(184, 76, 34, 72, "#4B4A44"),
      rect(102, 80, 56, 40, "#6C675B"),
      route("129,166 129,142 129,118 129,92 129,58 129,34", ROUTE_COLORS.main),
      route("54,152 54,126 54,98 54,74 100,74", ROUTE_COLORS.corridor),
      route("206,146 206,122 206,96 206,76 178,58 154,58", ROUTE_COLORS.flank),
      circle(122, 158, 8, ROUTE_COLORS.spawn),
      circle(136, 42, 8, ROUTE_COLORS.spawn),
      circle(206, 76, 6, ROUTE_COLORS.landmark),
      text(129, 18, "North Archive Wing"),
      text(129, 190, "South Admin Entry"),
      text(129, 102, "Archive Court"),
      text(54, 176, "Records Run", "preview__sub"),
      text(206, 168, "Archive Bridge", "preview__sub"),
    ]),
    scene: ledgerAnnexScene,
    ...mapDetails(
      {
        amber: spawnZone(
          "amber",
          "South Admin Entry",
          "Amber Vanguard stage behind south shelves with two quick exits into the court or records lane.",
          "south-admin",
        ),
        cobalt: spawnZone(
          "cobalt",
          "North Archive Wing",
          "Cobalt Reach hold the north archive wing behind pillars and the archive block.",
          "north-wing",
        ),
      },
      [
        {
          id: "archive-court",
          kind: "main",
          name: "Archive Court",
          description:
            "The broad middle route where shelf stacks and dividers create peeking decisions.",
          focusId: "archive-court",
        },
        {
          id: "records-run",
          kind: "corridor",
          name: "Records Run",
          description:
            "Left-side storage corridor that shortens range and emphasizes corner timing.",
          focusId: "records-run",
        },
        {
          id: "archive-bridge",
          kind: "flank",
          name: "Archive Bridge",
          description:
            "Elevated right-side route that reconnects above the storage wing without dominating the whole map.",
          focusId: "bridge-flank",
        },
      ],
      [
        {
          name: "Archive Bridge",
          description: "The defining silhouette that makes the flank instantly readable.",
          focusId: "bridge-flank",
        },
        {
          name: "Records Run",
          description: "Named interior lane shaped by shelf stacks and pillar cover.",
          focusId: "records-run",
        },
        {
          name: "Archive Court",
          description: "Central play space and the first area most players will call out.",
          focusId: "archive-court",
        },
      ],
      {
        bomb: {
          label: "Relay Charge",
          briefing:
            "Amber Vanguard can arm either the archive court relay or the bridge lock while Cobalt Reach slow the lane timings.",
          deliveryTeam: "amber",
          holdTeam: "cobalt",
          plantSeconds: 3.5,
          defuseSeconds: 4.2,
          sites: [
            bombSite(
              "archive-court-relay",
              "Archive Court Relay",
              "Central records terminal exposed between dividers and pillar cover.",
              "archive-court",
              ["archive-court", "records-run"],
            ),
            bombSite(
              "bridge-lock",
              "Bridge Lock",
              "Upper lock panel beside the raised archive bridge.",
              "bridge-flank",
              ["archive-bridge", "archive-court"],
            ),
          ],
        },
        hostage: {
          label: "Evac Escort",
          briefing:
            "Cobalt Reach must secure office staff and route them back through the north wing before Amber Vanguard shut the stacks.",
          rescueTeam: "cobalt",
          holdTeam: "amber",
          hostageClusters: [
            hostageCluster(
              "records-clerks",
              "Records Clerks",
              "Clerks pinned in the left-side storage corridor.",
              "records-run",
              ["records-run", "archive-court"],
            ),
            hostageCluster(
              "archive-custody",
              "Archive Custody",
              "Custodial pair trapped near the center stacks and court dividers.",
              "archive-court",
              ["archive-court", "archive-bridge"],
            ),
          ],
          extractionZone: extractionZone(
            "North Archive Wing",
            "Backline release zone behind the archive block and pillars.",
            "bridge-flank",
            ["archive-bridge", "archive-court"],
          ),
        },
      },
    ),
  },
];

export const featuredMap = mapCatalog.find((map) => map.mainMap) ?? mapCatalog[0];

export function getMapById(mapId: string): MapDefinition {
  const selected = mapCatalog.find((map) => map.id === mapId);
  return selected ?? featuredMap;
}
