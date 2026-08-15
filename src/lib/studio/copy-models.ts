// Retrofit R6 (§8) — the copy-model registry, shared by the server generator
// and the copy panel so the operator sees the same estimate the run will cost.
//
// A copy run is one vision call: up to 3 images at 800px (~1.6k input tokens
// each) plus the prompt, and ~700 output tokens. `estimateInr` is that call
// rounded to the paisa — enough to tell a few paise apart from a few rupees,
// not an invoice.

export interface CopyModel {
  id: string;
  label: string;
  note: string;
  /** ₹ per copy run, at 3 images + ~700 output tokens. */
  estimateInr: number;
}

export const COPY_MODELS: CopyModel[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "Default — richest description (Ansh, 4 Aug)", estimateInr: 3.0 },
  { id: "claude-opus-4-8", label: "Opus 4.8", note: "Previous hero tier", estimateInr: 3.0 },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", note: "Faster, cheaper", estimateInr: 0.6 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Cheapest — batch backfills", estimateInr: 0.15 },
];

export function copyModelInfo(id: string | null | undefined): CopyModel {
  return COPY_MODELS.find((m) => m.id === id) ?? { id: id ?? "unknown", label: id ?? "unknown", note: "Not in the registry", estimateInr: 0.6 };
}

export function estimateLabel(id: string | null | undefined): string {
  const m = copyModelInfo(id);
  return m.estimateInr < 1 ? `~${Math.round(m.estimateInr * 100)} paise` : `~₹${m.estimateInr.toFixed(2)}`;
}

/** Ansh (4 Aug): copy always defaults to Opus, whatever the tier. */
export function defaultCopyModel(_tier: string | null | undefined): string {
  return process.env.COPY_MODEL ?? "claude-opus-5";
}
