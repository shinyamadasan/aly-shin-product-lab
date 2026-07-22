import type { Product } from "./product-lab-types";

export const products: Product[] = [
  {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Fudgy brownie candidate for the first weekend dessert box.",
    image: "/product-images/P001_Brownies.png",
    decision: "Needs proof",
  },
  {
    id: "revel-bars",
    name: "Revel Bars",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Layered oat and chocolate bar candidate for the first box.",
    image: "/product-images/P003_Revel_Bars.png",
    decision: "Needs proof",
  },
  {
    id: "cookies",
    name: "Cookies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Cookie candidate to test size, texture, freshness, and giftability.",
    image: "/product-images/P002_Cookies.png",
    decision: "Needs proof",
  },
  {
    id: "burnt-cheesecake",
    name: "Burnt Cheesecake",
    category: "Cheesecake",
    role: "Premium upgrade",
    status: "testing",
    description: "Premium candidate that needs careful costing, chilling, and packaging tests.",
    image: "/product-images/P004_Burnt_Cheesecake.png",
    decision: "Retest",
  },
  {
    id: "caramel-macchiato",
    name: "Bottled Caramel Macchiato",
    category: "Coffee",
    role: "Add-on candidate",
    status: "paused",
    description: "Coffee add-on candidate. Needs freshness and premium-feel proof before launch.",
    image: "/product-images/P005_Bottled_Cold_Brew.png",
    decision: "Add-on test",
  },
  {
    id: "spanish-latte",
    name: "Bottled Spanish Latte",
    category: "Coffee",
    role: "Add-on candidate",
    status: "paused",
    description: "Coffee add-on candidate. Should not lead the first offer until tested.",
    image: "/product-images/P006_Bottled_Spanish_Latte.png",
    decision: "Add-on test",
  },
];

export const readinessRules = [
  "At least one product proof batch",
  "Real ingredient costing",
  "Packaging cost and stress test",
  "At least 5 tasting feedback entries",
  "Average tasting score of 8+",
  "Clear launch / retest / pause decision",
];

