import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aly & Shin Product Lab",
  description: "Internal product proof, costing, tasting, and content journal for Aly & Shin.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>{children}</body>
    </html>
  );
}
