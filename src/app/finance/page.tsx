import ProductLab from "../product-lab";

// Finance: the monthly financial read and the expense ledger. Owner data only -- every table it
// reads is owner-only under RLS, so a signed-out or non-owner visitor gets the app's normal sign-in
// or an unavailable state, never figures.
export default function FinancePageRoute() {
  return <ProductLab view="finance" />;
}
