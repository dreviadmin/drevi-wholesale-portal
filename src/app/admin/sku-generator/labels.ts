"use client";

// Roll-label PDF engine for the DCode DC421 Pro — ported from the reference
// tool's downloadRollPdf / drawLabelAt (spec §6.4; the numbers are calibrated
// against the physical printer — do not tweak).
import { jsPDF } from "jspdf";
import QRCode from "qrcode";

export interface Calibration {
  rollW: number; // label width mm
  rollH: number; // label height mm
  across: number; // labels per row
  gapX: number; // horizontal gap mm
}
export const DEFAULT_CAL: Calibration = { rollW: 38, rollH: 25, across: 1, gapX: 3 };
export const CAL_KEY = "drevi_sheet_cal_v1";
export const TRAY_KEY = "drevi_print_tray_v1";

export interface TrayItem { sku: string; copies: number }
export interface PrintDatum { sku: string; found: boolean; vendorCode: string; mrp: string }

// QRs encode the SKU string only — deterministic, never stored (spec §6.1).
export async function qrPngDataUrl(sku: string, pixels = 512): Promise<string> {
  return QRCode.toDataURL(sku, {
    errorCorrectionLevel: "Q",
    margin: 1,
    width: pixels,
    color: { dark: "#141414", light: "#FFFFFF" },
  });
}

function drawLabelAt(
  doc: jsPDF,
  x: number,
  W: number,
  H: number,
  sku: string,
  qrPng: string,
  withPrice: boolean,
  datum?: PrintDatum,
) {
  const qrSize = Math.min(H - 3.2, 16.5);
  const qrX = x + 1.6;
  const qrY = (H - qrSize) / 2;
  doc.addImage(qrPng, "PNG", qrX, qrY, qrSize, qrSize);

  const textX0 = qrX + qrSize + 1.8;
  const textW = x + W - textX0 - 1.2;

  if (withPrice) {
    // courier bold 5.6pt wrapped SKU → 5.4pt vendorCode → helvetica bold Rs <mrp>
    doc.setFont("courier", "bold");
    doc.setFontSize(5.6);
    doc.setTextColor(20, 20, 20);
    const skuLines = doc.splitTextToSize(sku, textW) as string[];
    const lineH = 2.05;
    const codeH = 2.0;
    const priceH = 3.2;
    const blockH = skuLines.length * lineH + codeH + priceH + 1.2;
    let y = Math.max(2.6, (H - blockH) / 2 + 1.8);
    for (const line of skuLines) {
      doc.text(line, textX0, y);
      y += lineH;
    }
    doc.setFontSize(5.4);
    doc.text(datum?.vendorCode ?? "---------", textX0, y + 0.3);
    y += codeH + 0.9;
    const mrpText = datum?.mrp ? `Rs ${datum.mrp}` : "Rs -";
    doc.setFont("helvetica", "bold");
    let size = 8;
    doc.setFontSize(size);
    while (size > 5.5 && doc.getTextWidth(mrpText) > textW) {
      size -= 0.25;
      doc.setFontSize(size);
    }
    doc.text(mrpText, textX0, y + 1.6);
  } else {
    // grey 'DREVI SKU' 4.6pt + courier bold 6.2pt wrapped SKU
    doc.setFont("helvetica", "normal");
    doc.setFontSize(4.6);
    doc.setTextColor(120, 120, 120);
    doc.setFont("courier", "bold");
    doc.setFontSize(6.2);
    doc.setTextColor(20, 20, 20);
    const skuLines = doc.splitTextToSize(sku, textW) as string[];
    const lineH = 2.3;
    const blockH = 2.2 + skuLines.length * lineH;
    let y = Math.max(2.6, (H - blockH) / 2 + 1.8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(4.6);
    doc.setTextColor(120, 120, 120);
    doc.text("DREVI SKU", textX0, y);
    y += 2.2;
    doc.setFont("courier", "bold");
    doc.setFontSize(6.2);
    doc.setTextColor(20, 20, 20);
    for (const line of skuLines) {
      doc.text(line, textX0, y);
      y += lineH;
    }
  }
}

export async function buildRollPdf(
  tray: TrayItem[],
  cal: Calibration,
  withPrice: boolean,
  data: Map<string, PrintDatum>,
): Promise<jsPDF> {
  const W = cal.rollW;
  const H = cal.rollH;
  const across = Math.max(1, Math.floor(cal.across));
  const gap = Math.max(0, cal.gapX);
  const pageW = across * W + (across - 1) * gap;
  const pageH = H;
  const orientation = pageW >= pageH ? "landscape" : "portrait";

  // Flatten copies into a single label stream.
  const stream: string[] = [];
  for (const t of tray) for (let i = 0; i < Math.max(1, t.copies); i++) stream.push(t.sku);

  const qrCache = new Map<string, string>();
  for (const sku of new Set(stream)) qrCache.set(sku, await qrPngDataUrl(sku));

  const doc = new jsPDF({ unit: "mm", format: [pageW, pageH], orientation, compress: true });
  for (let i = 0; i < stream.length; i += across) {
    if (i > 0) doc.addPage([pageW, pageH], orientation);
    const row = stream.slice(i, i + across);
    row.forEach((sku, col) => {
      drawLabelAt(doc, col * (W + gap), W, H, sku, qrCache.get(sku)!, withPrice, data.get(sku));
    });
  }
  return doc;
}

export function pdfFileName(withPrice: boolean): string {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ist.getUTCFullYear()}${p(ist.getUTCMonth() + 1)}${p(ist.getUTCDate())}-${p(ist.getUTCHours())}${p(ist.getUTCMinutes())}`;
  return `drevi-${withPrice ? "price-" : ""}labels-${stamp}.pdf`;
}

// Print via hidden iframe; resolves false when the browser blocked it.
export function printPdf(doc: jsPDF): boolean {
  try {
    const url = doc.output("bloburl") as unknown as string;
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        /* handled by caller toast */
      }
    };
    document.body.appendChild(frame);
    // Leave the frame attached — removing it cancels the print dialog.
    return true;
  } catch {
    return false;
  }
}

export async function shareQr(sku: string): Promise<"shared" | "downloaded"> {
  const dataUrl = await qrPngDataUrl(sku);
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], `${sku}.png`, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: sku });
      return "shared";
    } catch {
      /* cancelled or unsupported — fall through */
    }
  }
  downloadDataUrl(dataUrl, `${sku}.png`);
  return "downloaded";
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
