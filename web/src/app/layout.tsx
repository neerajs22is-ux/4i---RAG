import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";

import { AppProviders } from "@/components/providers/app-providers";
import "./globals.css";

/**
 * Typography.
 *
 * Instrument Sans — a compact grotesque with enough character to avoid the
 * default "AI product" look, and quiet enough for dense enterprise content.
 * JetBrains Mono — citations, chunk ids, page numbers, timings: anything that
 * benefits from tabular alignment and a technical register.
 *
 * Both are self-hosted by `next/font` (no external requests at runtime), and
 * exposed as CSS variables consumed by the `font-sans` / `font-mono` tokens.
 */
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "RAG-4i",
    template: "%s · RAG-4i",
  },
  description:
    "Answers grounded in your documents, with verifiable sources and honest uncertainty.",
};

export const viewport: Viewport = {
  themeColor: [
    // Browser chrome only (metadata cannot read CSS variables) — matches the
    // Platinum / Onyx backgrounds in globals.css.
    { media: "(prefers-color-scheme: light)", color: "#f1f2f3" },
    { media: "(prefers-color-scheme: dark)", color: "#111313" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${instrumentSans.variable} ${jetbrainsMono.variable}`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
        >
          Skip to content
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
