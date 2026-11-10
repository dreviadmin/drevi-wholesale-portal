import { BuyerFallback } from "@/components/BuyerFallback";

// notFound() fires for a SKU that is hidden or gone, usually from an old link
// shared on WhatsApp. Next's default 404 here was unstyled, with no way back.
export default function ProductNotFound() {
  return <BuyerFallback message="This piece is no longer in the catalog." />;
}
