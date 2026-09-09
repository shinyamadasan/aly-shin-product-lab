import ProductLab from "../product-lab";
import { resolveCreateNowJobId } from "@/lib/create-now";

// `?job=<id>` is the SAME parameter Today's Create Now already owns, resolved by the same validator
// on this route too (Wave B). That is what makes Saved Creatives' Open a plain link and what makes
// refreshing a reopened creative land on the same Creative Package instead of an empty screen.
// No second parameter, no second identifier, no second route model.
export default async function ContentStudioPage({ searchParams }: { searchParams: Promise<{ job?: string | string[] }> }) {
  const { job } = await searchParams;
  return <ProductLab initialCreativeJobId={resolveCreateNowJobId(job)} view="content-studio" />;
}
