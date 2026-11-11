// The design-number floor a new CAT-SUB mints above, combined from every
// corpus of used numbers (registry-sheet.ts numberFloor reads them). Pure, so
// the mint and the "Next #" preview provably take the same maximum.

export interface FloorSource {
  floor: number;
  warning?: string;
}

/** Highest floor across the sources (bad values count as 0), plus their warnings. */
export function combineFloors(known: number, ...sources: FloorSource[]): { floor: number; warnings: string[] } {
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  let floor = clean(known);
  const warnings: string[] = [];
  for (const s of sources) {
    floor = Math.max(floor, clean(s.floor));
    if (s.warning) warnings.push(s.warning);
  }
  return { floor, warnings };
}
