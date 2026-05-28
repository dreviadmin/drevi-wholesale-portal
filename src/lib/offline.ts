import { openDB, type IDBPDatabase } from "idb";
import type { WholesaleProduct } from "@/lib/types";

// IndexedDB layer for exhibition offline use: a catalog cache (prefetched at
// session start) + a submission queue (new-buyer captures and orders made while
// offline, drained on reconnect). Browser-only — call from client code.

const DB_NAME = "drevi-offline";
const VERSION = 1;

export interface OrderPayload {
  sessionId: string;
  eventName: string;
  buyerId?: string; // existing buyer
  buyerClientRef?: string; // links to a queued capture made offline
  items: { sku: string; qty: number }[];
  staffNote?: string;
  buyerNote?: string;
}
export interface CapturePayload {
  clientRef: string;
  form: { business_name: string; owner_name: string; email: string; phone: string; city: string; gstin?: string };
}
export interface QueueItem {
  id?: number;
  type: "capture" | "order";
  payload: OrderPayload | CapturePayload;
  attempts: number;
  createdAt: string;
  lastError?: string;
}

async function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains("products")) d.createObjectStore("products", { keyPath: "sku" });
      if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    },
  });
}

export async function cacheProducts(products: WholesaleProduct[]): Promise<void> {
  const d = await db();
  const tx = d.transaction("products", "readwrite");
  await tx.store.clear();
  for (const p of products) await tx.store.put(p);
  await tx.done;
  await setMeta("products_cached_at", new Date().toISOString());
}
export async function getCachedProducts(): Promise<WholesaleProduct[]> {
  return (await db()).getAll("products");
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put("meta", value, key);
}
export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return (await db()).get("meta", key) as Promise<T | undefined>;
}

export async function enqueue(type: QueueItem["type"], payload: OrderPayload | CapturePayload): Promise<number> {
  const d = await db();
  return d.add("queue", { type, payload, attempts: 0, createdAt: new Date().toISOString() }) as Promise<number>;
}
export async function getQueue(): Promise<QueueItem[]> {
  return (await db()).getAll("queue") as Promise<QueueItem[]>;
}
export async function removeQueued(id: number): Promise<void> {
  await (await db()).delete("queue", id);
}
export async function updateQueued(item: QueueItem): Promise<void> {
  await (await db()).put("queue", item);
}
