import "server-only";

import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { Order, OrderItem } from "@/lib/types";

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
  row: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: C.ivoryDeep },
  cItem: { width: "48%" },
  cState: { width: "22%" },
  cQty: { width: "14%", textAlign: "right" },
  cAmt: { width: "16%", textAlign: "right" },
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
function stateLabel(it: OrderItem): string {
  if (it.stock_state === "ready") return "In Stock";
  if (it.stock_state === "limited") return "Limited Edition";
  if (it.stock_state === "made_to_order") return `Made to Order - ${it.restock_days ?? "?"}d`;
  return "Sold Out";
}

export interface PdfBuyer {
  business_name: string | null;
  owner_name: string | null;
  phone: string | null;
  city: string | null;
}

function OrderDoc({ order, buyer }: { order: Order; buyer: PdfBuyer }) {
  const items = order.items ?? [];
  const maxLead = items.filter((i) => i.stock_state === "made_to_order").reduce((m, i) => Math.max(m, i.restock_days ?? 0), 0);
  const date = new Date(order.submitted_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.headerRow}>
          <View>
            <Text style={s.wordmark}>DREVI</Text>
            <Text style={s.tagline}>WHOLESALE</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={s.orderNo}>{order.order_number}</Text>
            <Text style={s.meta}>{date}</Text>
            <Text style={s.meta}>{order.source === "exhibition" ? "Exhibition order" : "Portal order"}</Text>
          </View>
        </View>

        <View style={s.buyerBlock}>
          <Text style={s.sectionLabel}>Order For</Text>
          <Text style={s.buyerName}>{buyer.business_name ?? "-"}</Text>
          <Text style={s.meta}>{[buyer.owner_name, buyer.phone, buyer.city].filter(Boolean).join(" - ")}</Text>
        </View>

        <Text style={s.sectionLabel}>Items</Text>
        <View style={s.tableHead}>
          <Text style={[s.th, s.cItem]}>Item</Text>
          <Text style={[s.th, s.cState]}>Availability</Text>
          <Text style={[s.th, s.cQty]}>Qty x Price</Text>
          <Text style={[s.th, s.cAmt]}>Amount</Text>
        </View>
        {items.map((it, i) => (
          <View style={s.row} key={`${it.sku}-${i}`}>
            <View style={s.cItem}>
              <Text style={s.itemTitle}>{it.title}</Text>
              <Text style={s.sku}>{it.sku}</Text>
            </View>
            <Text style={[s.state, s.cState]}>{stateLabel(it)}</Text>
            <Text style={[s.cQty, { fontSize: 9 }]}>{it.qty} x {inr(it.unit_price)}</Text>
            <Text style={[s.cAmt, { fontSize: 10, fontFamily: "Times-Bold" }]}>{inr(it.qty * it.unit_price)}</Text>
          </View>
        ))}

        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Total</Text>
          <Text style={s.totalAmt}>{inr(order.total_amount)}</Text>
        </View>
        {maxLead > 0 && <Text style={s.lead}>Estimated availability: {maxLead} days</Text>}

        {order.notes && (
          <View style={s.note}>
            <Text style={{ fontSize: 7, letterSpacing: 1, color: C.greige, textTransform: "uppercase", marginBottom: 3 }}>Note</Text>
            <Text>{order.notes}</Text>
          </View>
        )}

        <Text style={s.footer}>
          This is an order request, not an invoice. Rakesh will confirm availability and billing.{"\n"}
          Drevi Fashion - Dadar West, Mumbai - +91 88280 43555 - Dream Forward. Root Deep.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderOrderPdf(order: Order, buyer: PdfBuyer): Promise<Buffer> {
  return renderToBuffer(<OrderDoc order={order} buyer={buyer} />);
}
