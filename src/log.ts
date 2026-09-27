// The scripted demo prints a clean transcript, and the running commentary makes
// that unreadable. Read per call, not once at module load: an import runs before
// the script that sets it.
export function botLog(reason: string, detail?: unknown): void {
  if (process.env.UNSAID_QUIET === "1") return;
  const stamp = new Date().toISOString().slice(11, 19);
  if (detail !== undefined) {
    console.log(`[unsaid ${stamp}] ${reason}`, detail);
  } else {
    console.log(`[unsaid ${stamp}] ${reason}`);
  }
}

export function slotSnapshot(slots: {
  budgetCapUSD?: { value?: number | null };
  dietary?: { value?: string[] | null };
  window?: { value?: { start: string; end: string } | null };
  home?: { value?: { label?: string } | null };
  maxTravelMin?: { value?: number | null };
}): Record<string, unknown> {
  return {
    budget: slots.budgetCapUSD?.value ?? "(unset)",
    diet: slots.dietary?.value ?? "(unset)",
    time: slots.window?.value ?? "(unset)",
    home: slots.home?.value?.label ?? "(unset)",
    travelMin: slots.maxTravelMin?.value ?? "(unset)",
  };
}
