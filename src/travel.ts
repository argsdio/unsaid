import type { Coords } from "./contracts.ts";

const EARTH_KM = 6371;

export function haversineKm(a: Coords, b: Coords): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// 8 min of walking and waiting, then ~14 km/h door to door. Calibrated so
// Bushwick -> Union Square lands near 35 min, which matches the real trip.
export function travelMin(from: Coords, to: Coords): number {
  return Math.round(8 + haversineKm(from, to) * 4.2);
}
