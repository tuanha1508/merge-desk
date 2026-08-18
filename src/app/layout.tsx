import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Merge control",
  description:
    "Every open pull request, the customer behind it, and one decision - merge.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
