// Line-breaking for the coded vendor line on a price tag (Ansh, 28 Sep: a
// printed tag showed "DR-0069-08.9-10." — the line ran off the 38 mm label
// because it was drawn as one line while the SKU above it wraps).
//
// Breaks AFTER a hyphen so each line ends on a whole segment
// ("DR-0069-08.9-" / "10.7"), and only hard-breaks inside a segment when that
// one segment is itself wider than the label (a very long vendor SKU). Pure:
// the caller passes the measuring function, so vitest can pin it with a
// monospace stand-in — Courier, which the tag uses, is monospace too.
export function wrapAtHyphens(measure: (s: string) => number, text: string, width: number): string[] {
  const parts = text.split("-");
  const lines: string[] = [];
  let cur = "";
  parts.forEach((part, i) => {
    const piece = part + (i < parts.length - 1 ? "-" : "");
    if (cur && measure(cur + piece) > width) {
      lines.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  });
  if (cur) lines.push(cur);
  return lines.flatMap((line) => (measure(line) <= width ? [line] : hardBreak(measure, line, width)));
}

function hardBreak(measure: (s: string) => number, line: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (cur && measure(cur + ch) > width) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
