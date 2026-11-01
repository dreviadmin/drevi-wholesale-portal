// A cell that starts like a formula would run in Excel; a buyer name can be anything.
function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
