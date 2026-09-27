export function botLog(reason: string, detail?: unknown): void {
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
