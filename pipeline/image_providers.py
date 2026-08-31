#!/usr/bin/env python3
"""
image_providers.py — one interface, several image-edit backends.

    edit_image(png_bytes, prompt, provider) -> png_bytes

Providers
---------
openai     gpt-image-2 via /v1/images/edits         ~$0.20-0.25 / image
seedream   ByteDance Seedream 4.0 edit via fal.ai   ~$0.03 / image
seedream45 ByteDance Seedream 4.5 edit via fal.ai   ~$0.04 / image

fal notes (verified against fal.ai docs, Jul 2026):
  POST https://fal.run/<model-path>          (synchronous)
  Authorization: Key <FAL_KEY>
  body: {prompt, image_urls[<=10], image_size, num_images,
         enable_safety_checker, seed}
  -> {"images":[{"url","width","height"}], "seed":...}
Input images may be plain URLs OR base64 data URIs — we use data URIs so
Drive files never need to be made public.

Env knobs:
  FAL_KEY                     required for seedream*
  DREVI_SEEDREAM_SIZE         default 'auto_2K' ('auto_4K' for max quality)
  DREVI_SEEDREAM_SAFETY       '1' to leave fal's safety checker ON
                              (default off: these are the brand's own
                              catalog photos of its own garments, and the
                              checker false-positives on fitted ethnic wear
                              — the exact problem that blocked SKUs on OpenAI)
"""
from __future__ import annotations

import base64
import os

import requests

FAL_SYNC = "https://fal.run/"
# NB: v5 pro's endpoint id has no 'fal-ai/' prefix (verified via fal OpenAPI).
FAL_MODELS = {
    "seedream":    "fal-ai/bytedance/seedream/v4/edit",
    "seedream45":  "fal-ai/bytedance/seedream/v4.5/edit",
    "seedream5":   "bytedance/seedream/v5/pro/edit",
}
# Approx list price per output image (fal, Jul 2026) — for run cost estimates.
PRICE_PER_IMAGE = {
    "openai":     0.22,
    "seedream":   0.03,
    "seedream45": 0.04,
    "seedream5":  0.0675,   # <=1536px; ~0.135 for 1536-2048px
}
PROVIDERS = ("openai", "seedream", "seedream45", "seedream5")

# Where each provider's outputs live (Drive folder name under the INPUT parent)
OUTPUT_FOLDER_NAME = {
    "openai":     "CHATGPT_TEST",
    "seedream":   "SEEDREAM_TEST",
    "seedream45": "SEEDREAM45_TEST",
    "seedream5":  "SEEDREAM5PRO_TEST",
}


def _openai_edit(png: bytes, prompt: str, model: str = "gpt-image-2",
                 quality: str = "high", size: str = "auto") -> bytes:
    key = os.environ["OPENAI_API_KEY"]
    r = requests.post(
        "https://api.openai.com/v1/images/edits",
        files={"image": ("input.png", png, "image/png")},
        data={"model": model, "prompt": prompt, "size": size,
              "quality": quality, "n": 1},
        headers={"Authorization": f"Bearer {key}"},
        timeout=300,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI HTTP {r.status_code}: {r.text[:500]}")
    return base64.b64decode(r.json()["data"][0]["b64_json"])


def _fal_edit(png: bytes, prompt: str, provider: str) -> bytes:
    key = os.environ.get("FAL_KEY")
    if not key:
        raise RuntimeError("FAL_KEY not set — add it to .env "
                           "(get one at https://fal.ai/dashboard/keys)")
    size = os.environ.get("DREVI_SEEDREAM_SIZE", "auto_2K")
    safety = os.environ.get("DREVI_SEEDREAM_SAFETY", "0") == "1"
    data_uri = "data:image/png;base64," + base64.b64encode(png).decode()
    body = {
        "prompt": prompt,
        "image_urls": [data_uri],
        "image_size": size,
        "num_images": 1,
        "enable_safety_checker": safety,
    }
    if provider == "seedream5":
        # v5 pro defaults to jpeg; ask for png so catalog output stays lossless
        body["output_format"] = os.environ.get("DREVI_SEEDREAM_FORMAT", "png")
    r = requests.post(
        FAL_SYNC + FAL_MODELS[provider],
        headers={"Authorization": f"Key {key}",
                 "Content-Type": "application/json"},
        json=body, timeout=300,
    )
    if r.status_code != 200:
        raise RuntimeError(f"fal HTTP {r.status_code}: {r.text[:500]}")
    body = r.json()
    imgs = body.get("images") or []
    if not imgs:
        raise RuntimeError(f"fal returned no images: {str(body)[:300]}")
    url = imgs[0].get("url", "")
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    got = requests.get(url, timeout=180)
    if got.status_code != 200:
        raise RuntimeError(f"fal image download {got.status_code}")
    return got.content


def edit_image(png: bytes, prompt: str, provider: str = "openai") -> bytes:
    """Run one background/lighting edit. Returns image bytes (PNG/JPEG)."""
    if provider == "openai":
        return _openai_edit(png, prompt)
    if provider in FAL_MODELS:
        return _fal_edit(png, prompt, provider)
    raise ValueError(f"unknown provider {provider!r}; expected {PROVIDERS}")


def classify_error(err: str) -> str:
    """Normalise provider errors into the audit-log vocabulary."""
    e = (err or "").lower()
    if "billing hard limit" in e or "insufficient" in e or "quota" in e:
        return "BILLING"
    if "safety" in e or "content_policy" in e or "nsfw" in e:
        return "SAFETY"
    if "429" in e or "rate limit" in e:
        return "RATELIMIT"
    return "ERROR"
