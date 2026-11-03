"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { palette } from "@/lib/palette";
import { variantLabelOf } from "@/lib/variants";
import { NONE } from "@/lib/dashboard/state";
import {
  chaseByVendor, pendingByCustomer, pendingByProduct, type ChaseVendor, type DashContext, type PendingGroup, type PendingRow,
} from "@/lib/dashboard/rollup";
import { isCustomKey, partyName, plural } from "@/lib/dashboard/lines";
import { DrillLink } from "./DrillTable";
import { Contact } from "./EntityHeader";
import { CopyCode, FilterLink, Thumb } from "./views";
import type { Nav } from "./useDashState";

const GROUPS_PER_PAGE = 60;
const HEADING: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: palette.black, borderBottom: `1px solid ${palette.gold}` };
const NOTE: React.CSSProperties = { fontSize: 10, color: palette.mutedGreige, marginLeft: 8 };

function HoldNote({ row }: { row: PendingRow }) {
  if (row.state !== "hold") return null;
  return <div className="font-body" style={{ fontSize: 10.5, color: palette.crimsonText }}>On hold{row.item.hold_note ? ` — ${row.item.hold_note}` : ""}</div>;
}

function LineRow({ nav, row, children }: { nav: Nav; row: PendingRow; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1.5 pl-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
      <div className="min-w-0">
        {children}
        {!isCustomKey(row.key) && <span className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige, marginLeft: 6 }}>{variantLabelOf(row.key)}</span>}
        <HoldNote row={row} />
      </div>
      <div className="text-right whitespace-nowrap">
        <span className="font-body" style={{ fontSize: 11.5, color: palette.softBlack }}>{row.pieces} pc</span>
        <Link href={nav.onward(`/admin/orders/${row.order.id}`)} prefetch={false} className="font-body uppercase" style={{ display: "inline-block", fontSize: 10, letterSpacing: "0.08em", color: palette.goldDeep, marginLeft: 10, padding: "6px 0", margin: "-6px 0 -6px 10px", textDecoration: "underline" }}>{row.order.order_number}</Link>
      </div>
    </div>
  );
}

function ChaseGroup({ nav, vendor, phone, whatsapp }: { nav: Nav; vendor: ChaseVendor; phone: string | null; whatsapp: string | null }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        {vendor.key === NONE
          ? <span className="font-display" style={{ ...HEADING, borderBottom: "none" }}>{vendor.name}</span>
          : <FilterLink nav={nav} filter={{ dim: "vendor", value: vendor.key }} label={`Open vendor ${vendor.name}`} style={HEADING}>{vendor.name}</FilterLink>}
        <span className="font-body" style={{ fontSize: 11, fontWeight: 600, color: vendor.chase > 0 ? palette.crimsonText : palette.mutedGreige }}>
          {vendor.chase > 0 ? `Chase ${vendor.chase} pc` : "Nothing to chase"}
        </span>
        <span className="ml-auto"><Contact name={vendor.name} phone={phone} whatsapp={whatsapp} /></span>
      </div>
      {vendor.skus.map((s) => (
        <div key={s.key} className="flex items-start justify-between gap-2 py-1.5 pl-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
          <div className="min-w-0">
            <FilterLink nav={nav} filter={{ dim: "design", value: s.design }} label={`Open ${s.title}`} className="font-body block truncate" style={{ fontSize: 12, color: palette.black }}>{s.title}</FilterLink>
            <div className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>{s.label}</div>
            {s.vendorSku && <CopyCode code={s.vendorSku} />}
          </div>
          <div className="text-right whitespace-nowrap font-body" style={{ fontSize: 10.5, color: palette.softBlack }}>
            <span style={{ fontWeight: 600, color: palette.crimsonText }}>Chase {s.chase}</span>
            <div style={{ fontSize: 9.5, color: palette.mutedGreige }}>need {s.need} · {s.free} in stock{s.held ? ` · ${s.held} on hold` : ""}</div>
          </div>
        </div>
      ))}
      {vendor.covered.length > 0 && (
        <details className="pl-2 mt-1">
          <summary className="font-body" style={{ fontSize: 11, color: palette.mutedGreige, cursor: "pointer" }}>
            {plural(vendor.covered.length, "more size")} in stock, just confirm
          </summary>
          {vendor.covered.map((s) => (
            <div key={s.key} className="flex justify-between gap-2 py-1" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <span className="min-w-0">
                <span className="font-body block truncate" style={{ fontSize: 11.5, color: palette.softBlack }}>{s.title}</span>
                <span className="font-body block" style={{ fontSize: 9.5, color: palette.mutedGreige }}>{s.label}</span>
              </span>
              <span className="font-body whitespace-nowrap" style={{ fontSize: 9.5, color: palette.mutedGreige }}>need {s.need} · {s.free} in stock</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function PendingView({ nav, rows, ctx, vendorContact, empty }: {
  nav: Nav;
  rows: PendingRow[];
  ctx: DashContext;
  vendorContact: (key: string) => { phone: string | null; whatsapp: string | null };
  empty: React.ReactNode;
}) {
  const { state } = nav;
  const [limit, setLimit] = useState(GROUPS_PER_PAGE);
  const groups = useMemo<PendingGroup[]>(() => {
    if (state.group === "customer") return pendingByCustomer(rows);
    return state.group === "product" ? pendingByProduct(rows, ctx) : [];
  }, [rows, ctx, state.group]);
  const vendors = useMemo(() => (state.group === "vendor" ? chaseByVendor(rows, ctx) : []), [rows, ctx, state.group]);
  if (!rows.length) return <>{empty}</>;
  const count = state.group === "vendor" ? vendors.length : groups.length;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {(["customer", "product", "vendor"] as const).map((g) => {
          const next = { ...state, group: g };
          const on = state.group === g;
          return (
            <DrillLink key={g} href={nav.hrefFor(next)} onGo={() => nav.go(next)} current={on} className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.14em", padding: "6px 12px", background: on ? palette.goldDeep : "transparent", color: on ? palette.ivory : palette.softBlack, border: on ? "none" : "1px solid rgba(26,26,26,0.18)" }}>
              By {g}
            </DrillLink>
          );
        })}
        <span className="font-body" style={{ fontSize: 10, color: palette.mutedGreige }}>the backlog right now, whatever the dates and channel say</span>
      </div>

      {state.group === "customer" && groups.slice(0, limit).map((g) => (
        <div key={g.key} className="mb-4">
          <FilterLink nav={nav} filter={{ dim: "customer", value: g.key }} label={`Open customer ${g.name}`} style={HEADING}>{g.name}</FilterLink>
          <span className="font-body" style={NOTE}>{g.pieces} pc pending</span>
          {g.rows.map((r) => (
            <LineRow key={`${r.order.id}-${r.index}`} nav={nav} row={r}>
              <FilterLink nav={nav} filter={{ dim: "design", value: r.design }} label={`Open ${r.title}`} className="font-body" style={{ fontSize: 12, color: palette.black, borderBottom: `1px dotted ${palette.gold}` }}>{r.title}</FilterLink>
            </LineRow>
          ))}
        </div>
      ))}

      {state.group === "product" && groups.slice(0, limit).map((g) => (
        <div key={g.key} className="mb-4">
          <div className="flex items-center gap-2">
            <Thumb src={g.image} alt={g.name} width={32} height={40} />
            <div className="min-w-0">
              <FilterLink nav={nav} filter={{ dim: "design", value: g.key }} label={`Open ${g.name}`} style={HEADING}>{g.name}</FilterLink>
              <span className="font-body" style={NOTE}>{g.pieces} pc pending</span>
            </div>
          </div>
          {g.rows.map((r) => (
            <LineRow key={`${r.order.id}-${r.index}`} nav={nav} row={r}>
              <FilterLink nav={nav} filter={{ dim: "customer", value: r.order.buyer_id }} label={`Open customer ${partyName(r.buyer)}`} className="font-body" style={{ fontSize: 12, color: palette.black, borderBottom: `1px dotted ${palette.gold}` }}>{partyName(r.buyer)}</FilterLink>
            </LineRow>
          ))}
        </div>
      ))}

      {state.group === "vendor" && vendors.slice(0, limit).map((v) => {
        const c = vendorContact(v.key);
        return <ChaseGroup key={v.key} nav={nav} vendor={v} phone={c.phone} whatsapp={c.whatsapp} />;
      })}

      {count > limit && (
        <button type="button" onClick={() => setLimit((n) => n + GROUPS_PER_PAGE)} className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", padding: "7px 12px", border: "1px solid rgba(26,26,26,0.18)", color: palette.softBlack }}>
          Show more ({count - limit} left)
        </button>
      )}
    </div>
  );
}
