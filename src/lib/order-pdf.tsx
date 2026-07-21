import "server-only";

import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { Order, OrderItem } from "@/lib/types";

// Pre-fetched outfit thumbnails, keyed by SKU. Fetched OUTSIDE the renderer
// (with timeouts + format sniffing) so a slow/broken CDN URL can never hang or
// crash PDF generation — a missing image just renders as an empty slot.
// Keyed by IMAGE URL, not SKU: multiple custom lines all share sku "CUSTOM",
// and a SKU key made every custom line show the last-fetched photo.
type ImgMap = Map<string, { data: Buffer; format: "jpg" | "png" }>;

function sniffFormat(buf: Buffer): "jpg" | "png" | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  return null; // webp/avif/etc — react-pdf can't embed these; skip
}

async function fetchItemImages(items: OrderItem[]): Promise<ImgMap> {
  const map: ImgMap = new Map();
  await Promise.all(
    items.slice(0, 20).map(async (it) => {
      if (!it.image_url) return;
      try {
        // Shopify's CDN resizes via query param; Supabase public URLs ignore
        // it (transforms are a paid endpoint) — only append where it works.
        const url = it.image_url.includes("cdn.shopify.com")
          ? it.image_url + (it.image_url.includes("?") ? "&" : "?") + "width=200"
          : it.image_url;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
        if (!res.ok) return;
        const buf = Buffer.from(await res.arrayBuffer());
        const format = sniffFormat(buf);
        if (format && buf.length < 2_000_000) map.set(it.image_url, { data: buf, format });
        else if (buf.length >= 2_000_000) console.warn(`[order-pdf] image too large to embed (${Math.round(buf.length / 1024)}KB): ${it.image_url}`);
      } catch {
        // unreachable/slow image — render without it
      }
    }),
  );
  return map;
}

// Royal Noir order PDF (spec §9). Uses built-in PDF fonts (Times for the
// editorial headings, Helvetica for body) to keep rendering offline-safe — the
// palette + layout carry the brand identity.
const C = {
  black: "#1A1A1A",
  gold: "#C4A35A",
  goldDeep: "#A88848",
  ivory: "#FAF6F0",
  ivoryDeep: "#F2EBDC",
  greige: "#998F7A",
  crimson: "#8C2331",
};

const s = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: C.black, backgroundColor: "#FFFFFF" },
  wordmark: { fontFamily: "Times-Bold", fontSize: 22, letterSpacing: 6, color: C.black },
  tagline: { fontFamily: "Helvetica", fontSize: 7, letterSpacing: 3, color: C.gold, marginTop: 3 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: C.gold, paddingBottom: 12, marginBottom: 16 },
  orderNo: { fontFamily: "Times-Bold", fontSize: 14, color: C.black },
  meta: { fontSize: 8, color: C.greige, marginTop: 2 },
  sectionLabel: { fontSize: 8, letterSpacing: 2, color: C.gold, textTransform: "uppercase", marginBottom: 6 },
  buyerBlock: { marginBottom: 16 },
  buyerName: { fontFamily: "Times-Bold", fontSize: 12 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: C.black, paddingBottom: 5, marginBottom: 4 },
  th: { fontSize: 7, letterSpacing: 1, color: C.greige, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: C.ivoryDeep },
  cImg: { width: 34, height: 42, marginRight: 8, backgroundColor: C.ivoryDeep },
  cItem: { flex: 1, paddingRight: 6 },
  cState: { width: "20%" },
  cQty: { width: "17%", textAlign: "right" },
  cAmt: { width: "15%", textAlign: "right" },
  itemTitle: { fontFamily: "Times-Roman", fontSize: 11 },
  sku: { fontSize: 7, color: C.greige, marginTop: 2 },
  state: { fontSize: 8, color: C.goldDeep },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.black },
  totalLabel: { fontSize: 9, letterSpacing: 2, textTransform: "uppercase" },
  totalAmt: { fontFamily: "Times-Bold", fontSize: 16 },
  lead: { marginTop: 10, fontSize: 9, color: C.goldDeep },
  note: { marginTop: 14, padding: 10, backgroundColor: C.ivoryDeep, fontSize: 9 },
  footer: { position: "absolute", bottom: 32, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: C.greige, paddingTop: 8, fontSize: 8, color: C.greige, textAlign: "center" },
});

function inr(n: number): string {
  return "Rs " + Math.round(n).toLocaleString("en-IN");
}
// Unit prices under a GST split carry paise (e.g. 4995/4 = 1248.75). Rounding
// them to whole rupees made the printed multiplication fail its own arithmetic
// (4 x 1,249 = 4,996 != 4,995). Show paise only when the value actually has a
// fractional part, so plain lines stay clean.
function inrUnit(n: number): string {
  const isWhole = Math.abs(n - Math.round(n)) < 0.005;
  return isWhole
    ? inr(n)
    : "Rs " + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function stateLabel(it: OrderItem): string {
  if (it.stock_state === "ready") return "In Stock";
  if (it.stock_state === "limited") return "Limited Edition";
  if (it.stock_state === "made_to_order") return it.restock_days ? `Made to Order - ${it.restock_days}d` : "Made to Order";
  return "Sold Out";
}

export interface PdfBuyer {
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  portal_self_service: "Portal order",
  exhibition: "Exhibition order",
  in_store: "In-store order",
};

function OrderDoc({ order, buyer, images }: { order: Order; buyer: PdfBuyer; images: ImgMap }) {
  const items = order.items ?? [];
  const maxLead = items.filter((i) => i.stock_state === "made_to_order").reduce((m, i) => Math.max(m, i.restock_days ?? 0), 0);
  const date = new Date(order.submitted_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  // Staff-assisted orders produce an INVOICE (tax + payment recorded on the
  // spot); client self-service stays an ORDER REQUEST pending confirmation.
  const isInvoice = order.source !== "portal_self_service";
  const subtotal = items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);
  const taxed = order.tax_mode === "inclusive" || order.tax_mode === "exclusive";
  const discount = order.discount_amount ?? 0;
  const advance = order.advance_amount ?? 0;
  const balance = Math.max(0, (order.total_amount ?? 0) - advance);
  const showBreakdown = discount > 0 || (taxed && order.tax_mode === "exclusive");

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            <Text style={s.wordmark}>DREVI</Text>
            <Text style={s.tagline}>{isInvoice ? "WHOLESALE - INVOICE" : "WHOLESALE"}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.orderNo}>{order.order_number}</Text>
            <Text style={s.meta}>{date}</Text>
            <Text style={s.meta}>{SOURCE_LABEL[order.source] ?? "Order"}</Text>
          </View>
        </View>

        <View style={s.buyerBlock}>
          <Text style={s.sectionLabel}>Order For</Text>
          <Text style={s.buyerName}>{buyer.business_name ?? "-"}</Text>
          <Text style={s.meta}>{[buyer.owner_name, buyer.phone, buyer.city].filter(Boolean).join(" - ")}</Text>
        </View>

        <Text style={s.sectionLabel}>Items</Text>
        <View style={s.tableHead}>
          <Text style={[s.th, { width: 42 }]}> </Text>
          <Text style={[s.th, s.cItem]}>Item</Text>
          <Text style={[s.th, s.cState]}>Availability</Text>
          <Text style={[s.th, s.cQty]}>Qty x Price</Text>
          <Text style={[s.th, s.cAmt]}>Amount</Text>
        </View>
        {items.map((it, i) => {
          const img = it.image_url ? images.get(it.image_url) : undefined;
          return (
            <View style={s.row} key={`${it.sku}-${i}`} wrap={false}>
              {img ? (
                <Image style={s.cImg} src={{ data: img.data, format: img.format }} />
              ) : (
                <View style={s.cImg} />
              )}
              <View style={s.cItem}>
                <Text style={s.itemTitle}>{it.title}</Text>
                <Text style={s.sku}>{it.sku}{it.special_request ? "  ·  SPECIAL QTY REQUEST" : ""}</Text>
              </View>
              <Text style={[s.state, s.cState]}>{stateLabel(it)}</Text>
              <Text style={[s.cQty, { fontSize: 9 }]}>
                {/* "(was …)" marks a genuine discount — never printed for GST
                    bill-splits (actual_qty set), which must look like plain lines */}
                {it.qty} x {inrUnit(it.unit_price)}{it.original_price != null && it.actual_qty == null ? ` (was ${inr(it.original_price)})` : ""}
              </Text>
              <Text style={[s.cAmt, { fontSize: 10, fontFamily: "Times-Bold" }]}>{inr(it.qty * it.unit_price)}</Text>
            </View>
          );
        })}

        {/* Discount + tax breakdown (staff-recorded) */}
        {showBreakdown && (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
            <Text style={{ fontSize: 9, color: C.greige }}>Subtotal</Text>
            <Text style={{ fontSize: 9 }}>{inr(subtotal)}</Text>
          </View>
        )}
        {discount > 0 && (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 3 }}>
            <Text style={{ fontSize: 9, color: C.greige }}>
              Discount{order.discount_type === "percent" ? ` (${order.discount_value}%)` : ""}
            </Text>
            <Text style={{ fontSize: 9 }}>- {inr(discount)}</Text>
          </View>
        )}
        {taxed && order.tax_mode === "exclusive" && (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 3 }}>
            <Text style={{ fontSize: 9, color: C.greige }}>GST @ {order.tax_rate}%</Text>
            <Text style={{ fontSize: 9 }}>{inr(order.tax_amount)}</Text>
          </View>
        )}

        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Total</Text>
          <Text style={s.totalAmt}>{inr(order.total_amount)}</Text>
        </View>
        {taxed && order.tax_mode === "inclusive" && (
          <Text style={{ fontSize: 8, color: C.greige, textAlign: "right", marginTop: 2 }}>
            Includes GST @ {order.tax_rate}% = {inr(order.tax_amount)}
          </Text>
        )}

        {/* Payment */}
        {advance > 0 && (
          <View style={{ marginTop: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 9, color: C.greige }}>
                Advance received{order.payment_method ? ` (${order.payment_method})` : ""}
              </Text>
              <Text style={{ fontSize: 9 }}>{inr(advance)}</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 3 }}>
              <Text style={{ fontSize: 10, fontFamily: "Times-Bold" }}>Balance due</Text>
              <Text style={{ fontSize: 11, fontFamily: "Times-Bold", color: C.goldDeep }}>{inr(balance)}</Text>
            </View>
          </View>
        )}

        {maxLead > 0 && <Text style={s.lead}>Estimated availability: {maxLead} days</Text>}

        {order.notes && (
          <View style={s.note}>
            <Text style={{ fontSize: 7, letterSpacing: 1, color: C.greige, textTransform: "uppercase", marginBottom: 3 }}>Note</Text>
            <Text>{order.notes}</Text>
          </View>
        )}

        <Text style={s.footer}>
          {isInvoice
            ? "Thank you for your business."
            : "This is an order request, not an invoice. Rakesh will confirm availability and billing."}{"\n"}
          Drevi Fashion - Dadar West, Mumbai - +91 88280 43555 - Dream Forward. Root Deep.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderOrderPdf(order: Order, buyer: PdfBuyer): Promise<Buffer> {
  const images = await fetchItemImages(order.items ?? []);
  return renderToBuffer(<OrderDoc order={order} buyer={buyer} images={images} />);
}
