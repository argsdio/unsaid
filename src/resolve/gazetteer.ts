import type { Coords } from "../contracts.ts";

// Hand-built NYC gazetteer. Deterministic, offline, and reproducible across
// demo runs — which matters more tonight than precision. Coordinates are
// neighbourhood/landmark centroids, good to a few hundred metres.

export const PLACES: Record<string, Coords> = {
  "world trade center": { lat: 40.7127, lng: -74.0134 },
  "financial district": { lat: 40.7075, lng: -74.0113 },
  "battery park": { lat: 40.7033, lng: -74.017 },
  tribeca: { lat: 40.7163, lng: -74.0086 },
  soho: { lat: 40.7233, lng: -74.003 },
  noho: { lat: 40.7271, lng: -73.9931 },
  chinatown: { lat: 40.7158, lng: -73.997 },
  "little italy": { lat: 40.7191, lng: -73.9973 },
  "lower east side": { lat: 40.715, lng: -73.9843 },
  "east village": { lat: 40.7265, lng: -73.9815 },
  "west village": { lat: 40.7358, lng: -74.0036 },
  "greenwich village": { lat: 40.7336, lng: -74.0027 },
  "union square": { lat: 40.7359, lng: -73.9911 },
  flatiron: { lat: 40.7401, lng: -73.9903 },
  gramercy: { lat: 40.7368, lng: -73.9845 },
  chelsea: { lat: 40.7465, lng: -74.0014 },
  "hells kitchen": { lat: 40.7638, lng: -73.9918 },
  koreatown: { lat: 40.7479, lng: -73.9857 },
  "herald square": { lat: 40.7497, lng: -73.988 },
  "murray hill": { lat: 40.7479, lng: -73.9756 },
  midtown: { lat: 40.7549, lng: -73.984 },
  "times square": { lat: 40.758, lng: -73.9855 },
  "grand central": { lat: 40.7527, lng: -73.9772 },
  "penn station": { lat: 40.7506, lng: -73.9935 },
  "central park": { lat: 40.7829, lng: -73.9654 },
  "upper east side": { lat: 40.7736, lng: -73.9566 },
  "upper west side": { lat: 40.787, lng: -73.9754 },
  "morningside heights": { lat: 40.8075, lng: -73.9626 },
  "columbia university": { lat: 40.8075, lng: -73.9626 },
  harlem: { lat: 40.8116, lng: -73.9465 },
  "washington heights": { lat: 40.8417, lng: -73.9394 },
  nyu: { lat: 40.7295, lng: -73.9965 },
  "brooklyn heights": { lat: 40.696, lng: -73.9954 },
  "downtown brooklyn": { lat: 40.6937, lng: -73.9857 },
  dumbo: { lat: 40.7033, lng: -73.9881 },
  "fort greene": { lat: 40.6892, lng: -73.974 },
  williamsburg: { lat: 40.7081, lng: -73.9571 },
  greenpoint: { lat: 40.7304, lng: -73.9512 },
  bushwick: { lat: 40.6944, lng: -73.9213 },
  "bedford stuyvesant": { lat: 40.6872, lng: -73.9418 },
  "crown heights": { lat: 40.6694, lng: -73.9422 },
  "prospect heights": { lat: 40.6774, lng: -73.9668 },
  "park slope": { lat: 40.671, lng: -73.9814 },
  "barclays center": { lat: 40.6826, lng: -73.9754 },
  "long island city": { lat: 40.7447, lng: -73.9485 },
  astoria: { lat: 40.7644, lng: -73.9235 },
  sunnyside: { lat: 40.7433, lng: -73.9196 },
  "jackson heights": { lat: 40.7557, lng: -73.8831 },
  flushing: { lat: 40.7654, lng: -73.8318 },
  fordham: { lat: 40.862, lng: -73.8895 },
};

export const ALIASES: Record<string, string> = {
  wtc: "world trade center",
  "1 wtc": "world trade center",
  "one world trade": "world trade center",
  "oculus": "world trade center",
  fidi: "financial district",
  "wall street": "financial district",
  les: "lower east side",
  ev: "east village",
  wv: "west village",
  "the village": "greenwich village",
  village: "greenwich village",
  ues: "upper east side",
  uws: "upper west side",
  "bed stuy": "bedford stuyvesant",
  "bedstuy": "bedford stuyvesant",
  "bed-stuy": "bedford stuyvesant",
  lic: "long island city",
  "k town": "koreatown",
  ktown: "koreatown",
  "hell s kitchen": "hells kitchen",
  columbia: "columbia university",
  cu: "columbia university",
  "morningside": "morningside heights",
  "prospect park": "park slope",
  "union sq": "union square",
  "washington square": "nyu",
  "washington square park": "nyu",
  "wsp": "nyu",
  "east williamsburg": "williamsburg",
  "south williamsburg": "williamsburg",
  "soho nyc": "soho",
};

// Fallback only, and always low confidence.
export const BOROUGHS: Record<string, Coords> = {
  manhattan: { lat: 40.7831, lng: -73.9712 },
  brooklyn: { lat: 40.6782, lng: -73.9442 },
  queens: { lat: 40.7282, lng: -73.7949 },
  bronx: { lat: 40.8448, lng: -73.8648 },
  "staten island": { lat: 40.5795, lng: -74.1502 },
  nyc: { lat: 40.7549, lng: -73.984 },
  "new york": { lat: 40.7549, lng: -73.984 },
};

export function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
