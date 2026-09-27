import type { Evaluation, Survivor } from "../contracts.ts";

export function selectBestWorst(
  survivors: Survivor[],
  perPerson: Evaluation[][],
): Survivor | null {
  const travel = new Map(survivors.map((s) => [s.venueId, s.longestTravelMin]));
  const ranked = survivors
    .map((c) => {
      const evals = perPerson.map(
        (list) => list.find((e) => e.venueId === c.venueId) ?? { venueId: c.venueId, pass: false, score: 0 },
      );
      return { c, evals, worst: Math.min(...evals.map((e) => e.score)) };
    })
    .filter((x) => x.evals.every((e) => e.pass))
    .sort(
      (a, b) =>
        b.worst - a.worst ||
        (travel.get(a.c.venueId) ?? 0) - (travel.get(b.c.venueId) ?? 0),
    );
  return ranked[0]?.c ?? null;
}
