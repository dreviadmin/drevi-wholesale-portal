/**
 * A list in runs of at most `size`, in order; the last run may be shorter.
 *
 * For PostgREST filters: an .in() list travels in the request URL, so a few
 * hundred UUIDs in one call can outgrow what a proxy accepts (a 414), and a
 * read that fans out to several rows per id can pass the 1,000-row cap.
 */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a whole number above 0, not ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * `run` once per chunk of `xs`, one after another, with the rows put back
 * together in order. Stops at the first error. `done` counts the items whose
 * chunks went through, so a write that fails part way can say how far it got
 * rather than report all or nothing.
 */
export async function inRuns<T, R = never, E extends { message: string } = { message: string }>(
  xs: readonly T[],
  size: number,
  run: (part: T[]) => PromiseLike<{ data?: R[] | null; error: E | null }>,
): Promise<{ data: R[]; error: E | null; done: number }> {
  const data: R[] = [];
  let done = 0;
  for (const part of chunk(xs, size)) {
    const res = await run(part);
    if (res.error) return { data, error: res.error, done };
    data.push(...(res.data ?? []));
    done += part.length;
  }
  return { data, error: null, done };
}
