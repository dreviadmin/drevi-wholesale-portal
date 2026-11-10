import { BuyerFallback } from "@/components/BuyerFallback";

// notFound() fires when the order is not this buyer's (RLS hides it) or no
// longer exists. Next's default 404 here was unstyled, with no way back.
export default function OrderNotFound() {
  return <BuyerFallback message="We couldn't find this order. Everything you have ordered is under My orders on your home page." />;
}
