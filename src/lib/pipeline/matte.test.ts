import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";

// matte.ts is server-only for the same reason engines.ts is; the marker package
// throws outside a React Server Component, and there is nothing to exercise in
// it, so it is stubbed. Everything below is the REAL compositor.
vi.mock("server-only", () => ({}));

import { compositeMatte, alphaGeometry, plateHorizonFrac, groundFromPlate } from "./matte";

/**
 * A synthetic plate: a bright "wall" above a darker "floor", with the join at
 * a known fraction. The shipped plates are photographs of exactly this — the
 * step is all the horizon scan ever looks for.
 */
async function plate(width: number, height: number, horizonFrac: number): Promise<Buffer> {
  const wallH = Math.round(height * horizonFrac);
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const v = y < wallH ? 200 : 120;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A cut-out: transparent, with one opaque block standing on `footY`. */
async function figure(w: number, h: number, box: { x0: number; x1: number; y0: number; y1: number }): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 210; buf[i + 1] = 40; buf[i + 2] = 90; buf[i + 3] = 255;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** Row-averaged luminance down a column clear of the subject. */
async function columnProfile(png: Buffer, left: number, width: number, height: number): Promise<Float64Array> {
  const { data } = await sharp(png).extract({ left, top: 0, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let s = 0;
    for (let x = 0; x < width; x++) s += data[y * width + x];
    rows[y] = s / width;
  }
  return rows;
}

function steepestRow(rows: Float64Array): number {
  let best = -1, bestY = -1;
  for (let y = 1; y < rows.length - 1; y++) {
    const d = Math.abs(rows[y + 1] - rows[y - 1]);
    if (d > best) { best = d; bestY = y; }
  }
  return bestY;
}

describe("matte geometry", () => {
  it("reads the subject's bounding box and foot line off the alpha channel", async () => {
    const cut = await figure(200, 300, { x0: 60, x1: 139, y0: 40, y1: 249 });
    const g = await alphaGeometry(cut);
    expect(g).toMatchObject({ width: 200, height: 300, minX: 60, maxX: 139, minY: 40, footY: 249 });
    expect(g.opaqueFrac).toBeCloseTo((80 * 210) / (200 * 300), 5);
  });

  it("finds a plate's horizon to the row, not to a bucket", async () => {
    // 1/256 buckets alone would answer 0.7734 here; the fine pass must not.
    for (const frac of [0.6, 0.75, 0.778, 0.9]) {
      const p = await plate(120, 2000, frac);
      expect(await plateHorizonFrac(p)).toBeCloseTo(frac, 2);
    }
  });

  it("clamps a plate with no floor at all into a usable fraction", async () => {
    const flat = await sharp({ create: { width: 100, height: 400, channels: 3, background: { r: 180, g: 180, b: 180 } } }).png().toBuffer();
    const f = await plateHorizonFrac(flat);
    expect(f).toBeGreaterThanOrEqual(0.05);
    expect(f).toBeLessThanOrEqual(0.95);
  });
});

describe("horizon alignment — the plate moves, never the figure", () => {
  it("lands the wall-to-floor line on the figure's feet", async () => {
    // The failure this exists to stop: feet at 0.83 of the frame, plate horizon
    // at 0.75, so a naive composite stands the figure INSIDE the wall.
    const cut = await figure(200, 300, { x0: 70, x1: 129, y0: 40, y1: 249 });
    const out = await compositeMatte({ cutout: cut, mode: "coloured", plate: await plate(150, 400, 0.75) });
    // A column at the right edge, clear of both the figure and its shadow.
    const rows = await columnProfile(out, 185, 15, 300);
    expect(steepestRow(rows)).toBeCloseTo(249, -1); // within ~5 rows of footY
  });

  it("keeps the source frame exactly — no re-crop, no resize", async () => {
    const cut = await figure(137, 411, { x0: 20, x1: 90, y0: 10, y1: 300 });
    for (const mode of ["minimal", "grey", "coloured"] as const) {
      const out = await compositeMatte({ cutout: cut, mode, plate: mode === "coloured" ? await plate(150, 400, 0.75) : null });
      const m = await sharp(out).metadata();
      expect([m.width, m.height]).toEqual([137, 411]);
    }
  });

  it("crops the plate rather than stretching it to an odd aspect", async () => {
    const g = await alphaGeometry(await figure(400, 200, { x0: 10, x1: 390, y0: 10, y1: 180 }));
    const ground = await groundFromPlate(await plate(150, 400, 0.75), g);
    const m = await sharp(ground).metadata();
    expect([m.width, m.height]).toEqual([400, 200]);
  });
});

describe("the grounds", () => {
  it("minimal is pure white", async () => {
    const cut = await figure(60, 80, { x0: 20, x1: 39, y0: 10, y1: 60 });
    const out = await compositeMatte({ cutout: cut, mode: "minimal" });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    for (const i of [0, (info.width - 1) * info.channels]) {
      expect([data[i], data[i + 1], data[i + 2]]).toEqual([255, 255, 255]);
    }
  });

  it("grey is neutral and darker at the floor, with no wall line", async () => {
    const cut = await figure(60, 400, { x0: 20, x1: 39, y0: 10, y1: 300 });
    const out = await compositeMatte({ cutout: cut, mode: "grey" });
    const rows = await columnProfile(out, 0, 8, 400);
    expect(rows[0]).toBeGreaterThan(rows[399]); // darker toward the floor
    // Seamless: no single row is a step, unlike a plate.
    const deltas = Array.from({ length: 398 }, (_, i) => Math.abs(rows[i + 2] - rows[i]));
    expect(Math.max(...deltas)).toBeLessThan(2);
    // Neutral: r = g = b.
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(data[1]);
    expect(data[1]).toBe(data[2]);
  });

  it("falls back to white when a coloured plate could not be read", async () => {
    const cut = await figure(60, 80, { x0: 20, x1: 39, y0: 10, y1: 60 });
    // engines.ts passes plate:null when fetchPlate returns nothing — this is
    // that call, and it must render rather than throw.
    const out = await compositeMatte({ cutout: cut, mode: "coloured", plate: null });
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });
});

describe("the contact shadow", () => {
  it("darkens the ground below the hem and never the figure itself", async () => {
    const cut = await figure(200, 300, { x0: 70, x1: 129, y0: 40, y1: 249 });
    const out = await compositeMatte({ cutout: cut, mode: "minimal" });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];

    // Right under the feet: darkened.
    expect(px(100, 255)).toBeLessThan(250);
    // The figure's own pixels: untouched, still the exact source colour.
    expect([px(100, 200), data[(200 * info.width + 100) * info.channels + 1]]).toEqual([210, 40]);
    // Far from the figure: still pure white, so the pool is local.
    expect(px(3, 295)).toBe(255);
    // Above the subject there is no shadow at all.
    expect(px(100, 20)).toBe(255);
  });

  it("skips the shadow when the cut-out fills the frame — a macro crop has no foot line", async () => {
    const solid = await figure(120, 120, { x0: 0, x1: 119, y0: 0, y1: 119 });
    const out = await compositeMatte({ cutout: solid, mode: "minimal" });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      expect([data[i], data[i + 1], data[i + 2]]).toEqual([210, 40, 90]);
    }
  });
});

describe("refusals", () => {
  it("refuses an empty cut-out instead of publishing a bare backdrop", async () => {
    const empty = await sharp({ create: { width: 120, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await expect(compositeMatte({ cutout: empty, mode: "minimal" })).rejects.toThrow(/cut-out came back empty/i);
  });
});
