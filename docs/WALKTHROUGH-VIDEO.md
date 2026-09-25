# The buyer walkthrough video — how it is built

`scripts/walkthrough/` produces the Hindi-voiced, English-captioned explainer sent to
wholesale buyers. This is the plan it follows and why.

## The constraint that shapes everything

The voice comes from fal's Gemini TTS, which has **no pace control**: ~19 characters a second
plus a fixed lead-in and tail, and a style instruction does not move it. So the picture is cut
to the audio, never the audio to the picture — and it is cut at the level of a single
instruction, not a scene.

## Pipeline

1. **`skeleton.json`** — the choreography. One entry per *clip*, where a clip is one voice
   recording. Each carries the screen state it plays over and its actions: `tap` a named
   target at N seconds into the line (then switch state), `scroll` over a fraction of the
   line, `typing` through a sequence of states, `point` at something. The words are not here.
2. **`language.json`** — the words, one Hindi line and one English caption per clip id.
   Written and reviewed by native speakers against the intents in the skeleton, capped at 95
   Devanagari characters so a line cannot outrun its screen. Regenerate with the
   `walkthrough-language` workflow if the flow changes.
3. **`demo-buyer.mjs create`** — a "Royal Sarees" identity on **production** (login `royal`,
   matching the WhatsApp mock-up). Prod, because dev has 16 visible products and the video
   should show the real range. `destroy` removes it and everything filming created, in FK
   order.
4. **`capture.mjs`** — Playwright walks the flow as that buyer and saves every screen state as
   a full-page image plus the pixel box of every button a finger will tap, and the height of
   the sticky top bar (a `div`, not a `<header>`). Full-page so scrolling is a window sliding
   down one image; the bar is pinned back on by the renderer.
5. **`mocks.mjs`** — the WhatsApp message and the closing card, drawn to the same size with the
   link as a measured target.
6. **`tts.mjs`** — one recording per clip, **trimmed to the speech span**. Untrimmed, every
   clip carries ~0.4–1.5s of dead air, and a tap scheduled "0.5s in" lands before the voice
   has started. Cached by text hash, so re-runs cost nothing.
7. **`render.mjs`** — measures each trimmed clip, lays the clips end to end with fixed gaps,
   schedules every action against its clip, then draws each frame: the state image cropped at
   the current scroll, the sticky bar, the finger easing to its target, a ripple on the tap,
   the caption, a progress rule. Frames stream raw into ffmpeg; the voice track is assembled
   from the same timeline and muxed in the same pass. Writes `<out>.timeline.json`.

## Checking it

Extract a frame at each ripple time in the timeline and tile them: the finger must be on the
control in every one. That sheet caught both defects in the first render (a capture note
visible on the confirmation; a typing state landing after its tap because keyframes were not
sorted). Do it every time; do not trust the timeline numbers alone.

## Cost

~950 Devanagari characters of TTS ≈ $0.05 per full pass.
