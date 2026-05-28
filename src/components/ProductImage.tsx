import Image from "next/image";
import { HUES, hueForSku } from "@/lib/palette";

interface ImageProduct {
  sku: string;
  title?: string | null;
  image_urls?: string[] | null;
}

// Real image from image_urls[0]; falls back to the prototype's stylized
// gradient placeholder when empty. DREVI watermark (top-left) and SKU
// (bottom-right) are preserved in both modes (spec §7.1).
export function ProductImage({ product, large = false }: { product: ImageProduct; large?: boolean }) {
  const src = product.image_urls?.[0];

  const watermark = (
    <div
      className="absolute top-3 left-3 font-display pointer-events-none"
      style={{ color: "rgba(255,255,255,0.55)", fontSize: large ? 11 : 9, letterSpacing: "0.25em" }}
    >
      DREVI
    </div>
  );
  const skuTag = (
    <div
      className="absolute bottom-3 right-3 font-body pointer-events-none"
      style={{ color: "rgba(255,255,255,0.55)", fontSize: 9, letterSpacing: "0.1em" }}
    >
      {product.sku}
    </div>
  );

  if (src) {
    return (
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: "4/5" }}>
        <Image
          src={src}
          alt={product.title ?? product.sku}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          className="object-cover"
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.18) 0%, transparent 22%, transparent 78%, rgba(0,0,0,0.18) 100%)" }} />
        {watermark}
        {skuTag}
      </div>
    );
  }

  // Gradient placeholder
  const [c1, c2] = HUES[hueForSku(product.sku)] ?? HUES.sage;
  return (
    <div className="relative w-full overflow-hidden" style={{ aspectRatio: "4/5", background: `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)` }}>
      <div
        className="absolute inset-0 opacity-20 mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><filter id='n'><feTurbulence baseFrequency='0.9'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")",
        }}
      />
      {watermark}
      {skuTag}
      <div className="absolute inset-0 flex items-center justify-center px-6">
        <div
          className="font-display text-center"
          style={{
            color: "rgba(255,255,255,0.92)",
            fontSize: large ? 22 : 16,
            lineHeight: 1.15,
            fontWeight: 500,
            letterSpacing: "0.01em",
            textShadow: "0 2px 12px rgba(0,0,0,0.25)",
          }}
        >
          {(product.title ?? product.sku).split(" ").slice(0, 2).join(" ")}
        </div>
      </div>
    </div>
  );
}
