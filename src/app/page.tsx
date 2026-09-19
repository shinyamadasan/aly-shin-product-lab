import ProductLab from "./product-lab";

// Home is the operations Dashboard. Today (content creation) moved to /today; see src/app/today/page.tsx.
export default function HomeRoute() {
  return <ProductLab view="dashboard" />;
}
