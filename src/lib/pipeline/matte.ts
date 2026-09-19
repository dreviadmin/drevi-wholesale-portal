import "server-only";

import sharp from "sharp";
import type { OverlayOptions } from "sharp";

import type { BgMode } from "@/lib/studio/backgrounds";

// The matte compositor (Ansh, 20 Sep: "also add a Matte composite option").
//
// Every other engine in engines.ts asks a model to RE-IMAGINE the photograph.
// This one does not: engines.ts gets a cut-out with a real alpha channel from
// fal-ai/birefnet/v2, and everything below drops that cut-out onto a ground
// built here with sharp. The garment's pixels are the SOURCE pixels, byte for
// byte, so the two failures the whole 38-render bench was chasing — invented
// handwork and colour drift — cannot happen. Not "are unlikely to": cannot.
//
// The price of that guarantee is the opposite weakness, and it is real:
//   · NO COLOUR CORRECTION AT ALL. A flat or colour-cast capture stays flat
//     and cast. That is the reason to reach for a generative chip instead, and
//     the Workbench hint says so out loud.
//   · Sheer hems can come back with holes where birefnet reads a gap in net or
//     chiffon as background. It is far better at this than expected (a chiffon
//     dupatta keeps the backdrop reading through it rather than being masked
//     flat) but it is not perfect.
//
// PURE PIXELS — no fetch, no fal, no supabase. engines.ts owns every network
// call and hands this module bytes, which is what keeps the provider shapes in
// one file and makes this one testable with nothing but a PNG.

/** Below this an alpha byte counts as background — anti-aliased fringe, not garment. */
const ALPHA_FLOOR = 16;

/**
 * A cut-out that covers essentially the whole frame means birefnet found no
 * subject to separate (a macro fabric crop is the usual case). That is not an
 * error — the composite is simply a no-op — but a contact shadow under a
 * full-frame rectangle is, so the shadow is skipped above this.
 */
// Above this, the frame is essentially all garment — a macro fabric crop, or a
// figure filling the frame edge to edge. There is no floor in view to cast
// onto, so a shadow can only appear as smudges in the bottom corners. 0.995
// caught only the extreme case; a crop at 0.93 still had nowhere to put one.
const NO_SUBJECT_FRAC = 0.9;

/** Below this the cut-out is empty and the composite would be a bare backdrop. */
const EMPTY_FRAC = 0.005;

// ── The studio-grey ground ────────────────────────────────────────────────
// backgrounds.ts describes this mode to the generative engines as a "seamless
// neutral grey studio backdrop … subtle vertical gradient slightly darker at
// the floor". These two values are that sentence in numbers: seamless (no wall
// line), neutral (r=g=b), and darker toward the bottom. The falloff is
// quadratic so the top two-thirds stay almost flat and the darkening reads as
// a floor rather than as a gradient someone applied.
const GREY_TOP = 222;
const GREY_BOTTOM = 188;

export interface MatteGeometry {
  width: number;
  height: number;
  /** Bounding box of the opaque subject. */
  minX: number;
  maxX: number;
  minY: number;
  /** Lowest opaque row — the figure's contact with the floor. */
  footY: number;
  opaqueFrac: number;
}

/**
 * Where the subject actually is, read from the cut-out's own alpha.
 *
 * One pass over the alpha plane; everything downstream (the plate's crop, the
 * shadow's width and position) is derived from this rather than assumed, which
 * is what lets one code path handle a full-length figure and a macro crop.
 */
export async function alphaGeometry(cutout: Buffer): Promise<MatteGeometry> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let minX = width, maxX = -1, minY = height, footY = -1, opaque = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] <= ALPHA_FLOOR) continue;
      opaque++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > footY) footY = y;
    }
  }
  return { width, height, minX, maxX, minY, footY, opaqueFrac: opaque / (width * height) };
}

/**
 * The plate's horizon, as a fraction of its height.
 *
 * The plates are wall-meets-floor photographs, so their vertical luminance
 * profile is smooth everywhere EXCEPT that join — the floor is lit differently
 * from the wall. Scanning a narrow greyscale strip (16 columns averaged, 256
 * rows) removes per-pixel noise and leaves one unmistakable peak in the
 * row-to-row delta; a second pass at the plate's own resolution, inside that
 * peak's neighbourhood, takes the quantisation back out. Measured across all
 * five shipped plates the coarse pass lands on 0.7734 every time, matching the
 * line measured by eye (~0.778).
 *
 * The search skips the top quarter and the last 5%: a plate lit from above has
 * its steepest gradient near the ceiling, and the very last rows can carry a
 * JPEG edge artefact. Neither is the floor.
 */
export async function plateHorizonFrac(plate: Buffer): Promise<number> {
  const W = 16;

  /** Column-averaged luminance per row of a W-wide strip. */
  const profile = async (height: number) => {
    const { data } = await sharp(plate).resize(W, height, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const rows = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < W; x++) sum += data[y * W + x];
      rows[y] = sum / W;
    }
    return rows;
  };
  const peak = (rows: Float64Array, lo: number, hi: number, fallback: number) => {
    // best starts at 0, NOT -1: a delta is an absolute value, so every row of a
    // perfectly flat strip scores 0 and a -1 seed would let the FIRST scanned
    // row win — 0.25 of the plate, the top of the search window, which is the
    // one answer we know is not a floor. Seeded at 0 a strip with no gradient
    // anywhere leaves `fallback` standing, which is what it is for.
    let best = 0, bestY = fallback;
    for (let y = Math.max(1, lo); y < Math.min(rows.length - 1, hi); y++) {
      const delta = Math.abs(rows[y + 1] - rows[y - 1]);
      if (delta > best) { best = delta; bestY = y; }
    }
    return bestY;
  };

  // COARSE pass at 256 rows. Squashing the plate this far is what makes the
  // peak unambiguous: sensor noise and JPEG blocking average out, and the only
  // thing left that changes row to row is the floor.
  const H = 256;
  const coarse = await profile(H);
  const coarseY = peak(coarse, Math.floor(H * 0.25), Math.floor(H * 0.95), Math.round(H * 0.7734));

  // FINE pass at the plate's own height, inside ±3 coarse buckets of that.
  // The coarse pass alone quantises the answer to 1/256 of the plate, which on
  // a 2000px plate scaled up to cover the frame lands the line ~8px off the
  // feet every time — small, consistent, and visible as a hairline gap between
  // the hem and the floor. This removes it.
  const meta = await sharp(plate).metadata();
  const ph = meta.height ?? 0;
  if (!ph || ph <= H) return clampFrac(coarseY / H);
  const fine = await profile(ph);
  const centre = Math.round((coarseY / H) * ph);
  const window = Math.ceil((ph / H) * 3);
  const fineY = peak(fine, centre - window, centre + window, centre);
  return clampFrac(fineY / ph);
}

/** Keep the divisions in groundFromPlate finite even for a plate with no floor. */
function clampFrac(f: number): number {
  return Math.min(0.95, Math.max(0.05, f));
}

/**
 * How far the plate may be scaled up to make its horizon reachable.
 *
 * With the shipped plates (horizon at 0.77 of 2000px) a 1200px frame needs no
 * more than ~1.6x, so this cap never binds in practice. It exists so a plate
 * whose horizon sits near an edge cannot ask for a 20x resize; when it does
 * bind the horizon lands as close to the feet as the plate allows instead of
 * exactly on them.
 */
const MAX_PLATE_SCALE = 8;

/**
 * The plate, moved so its wall-to-floor line sits exactly on the figure's feet.
 *
 * THE PART THAT LOOKS BROKEN IF IT IS SKIPPED. Composited naively, the gold
 * sharara's feet end at 0.922 of the frame while the plate's horizon sits at
 * 0.773 — the figure is not floating above the floor, she is standing INSIDE
 * THE WALL, and the eye reads it instantly.
 *
 * The plate moves, not the figure. Cropping the garment to suit a backdrop
 * would be the one thing this engine exists to never do, and the plates are
 * smooth gradients, so shifting one is invisible apart from the line we are
 * moving. The plate is rendered TALLER than the frame (enough above the
 * horizon to cover footY, enough below to cover the rest) and then cropped.
 */
export async function groundFromPlate(plate: Buffer, g: MatteGeometry): Promise<Buffer> {
  const meta = await sharp(plate).metadata();
  const pw = meta.width ?? 0, ph = meta.height ?? 0;
  if (!pw || !ph) throw new Error("Background plate has no readable dimensions");

  const hf = await plateHorizonFrac(plate);
  const above = hf * ph, below = (1 - hf) * ph;
  const scale = Math.min(
    MAX_PLATE_SCALE,
    Math.max(g.width / pw, g.footY / above, (g.height - g.footY) / below),
  );
  const sw = Math.max(g.width, Math.round(pw * scale));
  const sh = Math.max(g.height, Math.round(ph * scale));
  // Clamped so a capped scale crops to the nearest legal window rather than
  // throwing; horizontally the plate is simply centred.
  const top = Math.max(0, Math.min(sh - g.height, Math.round(hf * sh) - g.footY));
  const left = Math.max(0, Math.min(sw - g.width, Math.round((sw - g.width) / 2)));
  return sharp(plate)
    .resize(sw, sh, { fit: "fill" })
    .extract({ left, top, width: g.width, height: g.height })
    .toBuffer();
}

/** Minimal mode's ground: flat white, nothing else. */
function whiteGround(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}

/** Grey mode's ground: seamless neutral grey, quadratically darker at the floor. */
function greyGround(w: number, h: number): Promise<Buffer> {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const t = h > 1 ? y / (h - 1) : 0;
    const v = Math.round(GREY_TOP + (GREY_BOTTOM - GREY_TOP) * t * t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ── The contact shadow ────────────────────────────────────────────────────
//
// Without one the figure reads pasted-on however well the horizon lines up.
// The shadow is derived from the cut-out's OWN alpha, so it follows this
// garment's hem rather than being a generic ellipse.
//
// THE NUMBERS, and why these ones. Ansh's prototype squashed the whole
// silhouette into a 0.05H band, blurred it and called it faint. Rendered at
// size it was worse than faint — it was a hard-edged grey SLAB sitting on the
// wall. Three things were wrong and all three are fixed here:
//
//   1 SOURCE — the bottom 35% of the figure, not all of it. Squashing head to
//     hem makes the band's width the union of every row (hair, arms, a raised
//     dupatta) and its interior solid. The bottom third is what touches the
//     floor, and its profile is the hem's.
//   2 FALLOFF — the squashed core is padded with 2.2σ of transparency on every
//     side BEFORE the blur. sharp clamps a blur at the canvas edge, so an
//     unpadded band ends in a visible rectangle no matter how large σ is. This
//     is the single change that turned a slab into a pool.
//   3 PLACEMENT — 45% of the core above the foot line, 55% below. Ansh's note
//     said "just above the foot line"; on these plates the foot line IS the
//     horizon, so a shadow entirely above it is painted on the WALL. The floor
//     recedes downward in frame, so the pool has to straddle the feet and
//     spread toward the camera.
//
// STRENGTH 0.70 — peak opacity of the pool, i.e. the darkest pixel of the
// shadow multiplies the ground to 30% of its luminance. Chosen by rendering
// 0.35 / 0.40 / 0.50 / 0.55 / 0.70 across all three bench garments and looking
// at them at 300px, the width a catalogue card actually shows: below 0.55 the
// pool disappears at that size and the figure floats again, and at 0.70 it
// still reads as a soft contact pool at 1:1 rather than a smudge. On a dark
// plate (midnight) a multiply shadow is nearly invisible at any strength —
// that is correct, not a bug, and pushing the value up to make it show would
// ruin it everywhere else.
const SHADOW_STRENGTH = 0.7;
/** Fraction of the figure's height, measured up from the hem, that casts it. */
const SHADOW_HEM_FRAC = 0.35;
/** Core width as a multiple of the subject's bounding-box width. */
const SHADOW_WIDTH_MUL = 1.15;
/** Core height as a fraction of the frame — the pad below roughly quadruples the footprint. */
const SHADOW_CORE_FRAC = 0.02;
/** Blur sigma as a fraction of the frame height — ~16px on a 1200px frame. */
const SHADOW_BLUR_FRAC = 0.013;
/** Share of the core that sits ABOVE the foot line. */
const SHADOW_LIFT = 0.45;

interface Overlay { input: Buffer; blend: "multiply"; left: number; top: number }

async function contactShadow(cutout: Buffer, g: MatteGeometry): Promise<Overlay | null> {
  const figW = g.maxX - g.minX + 1;
  const figH = g.footY - g.minY + 1;
  const hemH = Math.max(2, Math.min(figH, Math.round(figH * SHADOW_HEM_FRAC)));
  const coreW = Math.max(8, Math.round(figW * SHADOW_WIDTH_MUL));
  const coreH = Math.max(3, Math.round(g.height * SHADOW_CORE_FRAC));
  const sigma = Math.max(1, Math.round(g.height * SHADOW_BLUR_FRAC));
  const pad = Math.round(sigma * 2.2);
  const blobW = coreW + pad * 2, blobH = coreH + pad * 2;

  const core = await sharp(cutout)
    .ensureAlpha()
    .extractChannel("alpha")
    .extract({ left: g.minX, top: g.footY - hemH + 1, width: figW, height: hemH })
    .resize(coreW, coreH, { fit: "fill" })
    .toBuffer();

  // b-w is forced before raw(): extend/blur can hand back a 3-channel buffer,
  // and joinChannel told it is 1 channel would then read the rows offset — a
  // shadow of diagonal stripes, which is exactly what the first cut produced.
  const { data: mask, info } = await sharp(core)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0 } })
    .blur(sigma)
    .linear(SHADOW_STRENGTH, 0)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.width !== blobW || info.height !== blobH) {
    // Not recoverable and not worth guessing at: a wrong-shaped mask paints
    // stripes across the product photo, which is worse than no shadow.
    console.warn(`Matte: shadow mask came back ${info.width}x${info.height}x${info.channels}, expected ${blobW}x${blobH}x1 — skipping the shadow`);
    return null;
  }

  // Solid black carrying the pool as its alpha; 'multiply' then darkens the
  // ground in proportion to that alpha and leaves the rest untouched.
  const overlay = await sharp({ create: { width: blobW, height: blobH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(mask, { raw: { width: blobW, height: blobH, channels: 1 } })
    .png()
    .toBuffer();

  const left = Math.round((g.minX + g.maxX) / 2 - blobW / 2);
  // Measured from the CORE, not the padded blob: the pad is only room for the
  // blur, so anchoring on the blob edge would drag the dark centre around
  // every time sigma changed.
  const top = Math.round(g.footY - coreH * SHADOW_LIFT) - pad;
  return cropOverlayToFrame(overlay, blobW, blobH, left, top, g.width, g.height);
}

/**
 * sharp refuses an overlay that overhangs the canvas, and a garment shot
 * cropped at the hem overhangs it almost every time. Trim rather than reject.
 */
async function cropOverlayToFrame(
  buf: Buffer, w: number, h: number, left: number, top: number, frameW: number, frameH: number,
): Promise<Overlay | null> {
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const x1 = Math.min(frameW, left + w), y1 = Math.min(frameH, top + h);
  if (x1 <= x0 || y1 <= y0) return null; // entirely off-frame
  const cw = x1 - x0, ch = y1 - y0;
  const input =
    cw === w && ch === h
      ? buf
      : await sharp(buf).extract({ left: x0 - left, top: y0 - top, width: cw, height: ch }).png().toBuffer();
  return { input, blend: "multiply", left: x0, top: y0 };
}

/**
 * Drop a cut-out onto a ground and return the finished PNG.
 *
 * `plate` is the coloured mode's backdrop bytes; pass null in minimal and grey
 * mode, and also when a coloured-mode plate could not be read — this falls
 * back to the white ground rather than failing, the same call engines.ts makes
 * for the generative engines (a background is not worth losing a render over).
 */
export async function compositeMatte(args: { cutout: Buffer; mode: BgMode; plate?: Buffer | null }): Promise<Buffer> {
  // A PNG with no alpha channel is not a failed cut-out, it IS the source
  // photograph. ensureAlpha() inside alphaGeometry would hand it back fully
  // opaque, which passes every guard below and republishes the original —
  // shoot-room wall included — labelled as a generated candidate. Refuse.
  if (!(await sharp(args.cutout).metadata()).hasAlpha) {
    throw new Error(
      "The cut-out came back with no transparency, so there is nothing to composite — " +
      "the background removal did not run. Try again, or use a generative chip on this angle.",
    );
  }

  const g = await alphaGeometry(args.cutout);
  if (g.footY < 0 || g.opaqueFrac < EMPTY_FRAC) {
    throw new Error(
      "The cut-out came back empty — birefnet found no garment to separate from this photo. " +
      "A macro crop with no clear subject is the usual cause; try a generative chip on this angle instead.",
    );
  }

  let ground: Buffer;
  if (args.mode === "coloured" && args.plate) {
    // Downloading the plate and DECODING it are two different failures, and
    // only the first was handled upstream. A truncated or non-image body
    // reaches here and throws out of groundFromPlate — which would lose the
    // whole render over a background, exactly what the fallback exists to
    // prevent.
    try {
      ground = await groundFromPlate(args.plate, g);
    } catch (err) {
      console.warn(`Matte: plate could not be decoded (${(err as Error).message}) — compositing onto white instead`);
      ground = await whiteGround(g.width, g.height);
    }
  } else if (args.mode === "grey") ground = await greyGround(g.width, g.height);
  else ground = await whiteGround(g.width, g.height);

  const layers: OverlayOptions[] = [];
  // A full-frame cut-out has no floor line to sit on — the shadow would be a
  // band across the middle of the photograph.
  if (g.opaqueFrac < NO_SUBJECT_FRAC) {
    const shadow = await contactShadow(args.cutout, g);
    if (shadow) layers.push(shadow);
  }
  // Shadow first, figure on top — the figure must never be darkened by its own
  // shadow, only the ground around it.
  layers.push({ input: args.cutout, left: 0, top: 0 });

  return sharp(ground).composite(layers).png().toBuffer();
}
