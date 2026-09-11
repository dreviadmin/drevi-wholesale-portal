// Pure colour-list helpers shared by every colour picker (SKU generator, Log
// delivery). No "use client", no server-only — importable from either side
// and from unit tests.

export type ColorGroups = { name: string; items: [string, string][] }[];

// Color ranking from the reference: code exact → code prefix → name prefix →
// code contains → name contains.
export function rankColors(q: string, groups: ColorGroups): [string, string][] {
  const all = groups.flatMap((g) => g.items.map(([c, n]) => [c, n] as [string, string]));
  const s = q.trim().toUpperCase();
  if (!s) return all;
  const score = ([code, name]: [string, string]) => {
    const N = name.toUpperCase();
    if (code === s) return 0;
    if (code.startsWith(s)) return 1;
    if (N.startsWith(s)) return 2;
    if (code.includes(s)) return 3;
    if (N.includes(s)) return 4;
    return 9;
  };
  return all.filter((c) => score(c) < 9).sort((a, b) => score(a) - score(b));
}

export function findColorName(code: string, groups: ColorGroups): string | null {
  const c = code.trim().toUpperCase();
  if (!c) return null;
  for (const g of groups) {
    const hit = g.items.find(([k]) => k.toUpperCase() === c);
    if (hit) return hit[1];
  }
  return null;
}
