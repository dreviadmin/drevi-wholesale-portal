"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, ImageOff } from "lucide-react";
import { ZoomImage } from "@/components/Lightbox";
import { ReceiptEditor, type VendorOption, type EditorLine } from "../ReceiptEditor";
import { deleteReceipt } from "../actions";
import { uuid } from "@/lib/uuid";
import { formatINR, formatUnitINR } from "@/lib/format";
import { palette } from "@/lib/palette";

interface ReceiptHeader {
  id: string; number: string; vendorId: string; vendorName: string; vendorCity: string | null;
  date: string; billAmount: number | null; notes: string; billUrl: string | null;
  createdBy: string; createdAt: string;
}
interface Line { id: string; sku: string; description: string; qty: number; unitCost: number }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function ReceiptDetail({ receipt, lines, vendors, registrySkus }: {
  receipt: ReceiptHeader;
  lines: Line[];
  vendors: VendorOption[];
  registrySkus: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const totals = lines.reduce((t, l) => ({ pieces: t.pieces + l.qty, value: t.value + l.qty * l.unitCost }), { pieces: 0, value: 0 });
  const mismatch = receipt.billAmount != null && receipt.billAmount > 0 && Math.abs(receipt.billAmount - totals.value) > 0.5;

  async function doDelete() {
    if (!window.confirm(`Delete receipt ${receipt.number}? Its lines are removed with it. This cannot be undone.`)) return;
    setBusy(true);
    const res = await deleteReceipt(receipt.id);
    setBusy(false);
    if (res.ok) { router.push("/admin/receipts"); router.refresh(); }
    else window.alert(res.error ?? "Delete failed");
  }

  if (editing) {
    const initialLines: EditorLine[] = lines.map((l) => ({ key: uuid(), sku: l.sku, description: l.description, qty: l.qty, unitCost: String(l.unitCost) }));
    return (
      <>
        <h1 className="font-display mt-3" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Edit {receipt.number}</h1>
        <ReceiptEditor
          vendors={vendors}
          registrySkus={registrySkus}
          initial={{
            id: receipt.id,
            vendorId: receipt.vendorId,
            receiptDate: receipt.date,
            billAmount: receipt.billAmount != null ? String(receipt.billAmount) : "",
            notes: receipt.notes,
            billPhotoUrl: receipt.billUrl,
            lines: initialLines,
          }}
        />
        <button type="button" onClick={() => setEditing(false)} className="mt-2 w-full font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.16em", padding: "11px 0" }}>
          Cancel Edit
        </button>
      </>
    );
  }

  return (
    <>
      <div className="mt-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-mono" style={{ fontSize: 22, fontWeight: 700, color: palette.black }}>{receipt.number}</h1>
          <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>
            {receipt.vendorName}{receipt.vendorCity ? ` · ${receipt.vendorCity}` : ""}
          </div>
          <div className="font-body mt-0.5" style={{ fontSize: 11, color: palette.mutedGreige }}>
            {fmtDate(receipt.date)} · logged by {receipt.createdBy.split("@")[0]}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
            <Pencil size={12} /> Edit
          </button>
          <button type="button" onClick={doDelete} disabled={busy} className="flex items-center gap-1.5 font-body uppercase disabled:opacity-50" style={{ border: `1px solid ${palette.crimsonText}`, color: palette.crimsonText, fontSize: 9, letterSpacing: "0.15em", padding: "7px 11px" }}>
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>

      <div className="flex gap-4 mt-4 items-start">
        {receipt.billUrl ? (
          <ZoomImage src={receipt.billUrl} alt={`Bill for ${receipt.number}`} width={90} height={113} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 flex-shrink-0" style={{ width: 90, height: 113, background: palette.ivoryDeep, color: palette.mutedGreige }}>
            <ImageOff size={18} />
            <span className="font-body" style={{ fontSize: 8.5 }}>No bill photo</span>
          </div>
        )}
        <div className="font-body" style={{ fontSize: 12.5, color: palette.softBlack }}>
          <div>{totals.pieces} piece{totals.pieces === 1 ? "" : "s"} across {lines.length} line{lines.length === 1 ? "" : "s"}</div>
          <div className="font-display mt-1" style={{ fontSize: 19, fontWeight: 600, color: palette.black }}>{formatINR(totals.value)}</div>
          {receipt.billAmount != null && receipt.billAmount > 0 && (
            <div className="mt-1" style={{ fontSize: 11.5 }}>
              Bill amount {formatINR(receipt.billAmount)}
              {mismatch && (
                <span className="ml-2 px-2 py-0.5" style={{ background: palette.amberSoft, color: palette.goldDeep, fontSize: 10 }}>
                  differs by {formatINR(Math.abs(receipt.billAmount - totals.value))}
                </span>
              )}
            </div>
          )}
          {receipt.notes && <div className="mt-1" style={{ fontSize: 11.5, color: palette.mutedGreige }}>{receipt.notes}</div>}
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 480 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${palette.black}` }}>
              {["SKU", "Qty", "₹/pc", "Total"].map((h, i) => (
                <th key={h} className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.14em", color: palette.mutedGreige, padding: "7px 8px", textAlign: i === 0 ? "left" : "right" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <td style={{ padding: "9px 8px" }}>
                  <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: palette.black }}>{l.sku}</span>
                  {l.description && <span className="font-body block" style={{ fontSize: 10, color: palette.mutedGreige }}>{l.description}</span>}
                </td>
                <td className="font-body text-right" style={{ fontSize: 12.5, padding: "9px 8px" }}>{l.qty}</td>
                <td className="font-body text-right" style={{ fontSize: 12.5, padding: "9px 8px" }}>{formatUnitINR(l.unitCost)}</td>
                <td className="font-display text-right" style={{ fontSize: 13, fontWeight: 600, padding: "9px 8px" }}>{formatINR(l.qty * l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
