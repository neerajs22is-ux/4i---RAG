import type { Metadata } from "next";

import { EvidenceSection } from "@/components/site/evidence-section";
import { FinalCta } from "@/components/site/final-cta";
import { Hero } from "@/components/site/hero";
import { SecuritySection } from "@/components/site/security-section";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { SpacesSection } from "@/components/site/spaces-section";
import { StepsSection } from "@/components/site/steps-section";

/**
 * Public landing page.
 *
 * Rendered at `/` for everyone, signed in or not: the entry button adapts
 * (Sign in / Open workspace) instead of redirecting signed-in visitors away,
 * so the page stays reachable and linkable. No authentication state is needed
 * for the page itself — the only client islands are the entry button, the
 * theme control and the reveal-independent demo card.
 */
export const metadata: Metadata = {
  title: {
    absolute:
      "RAG-4i: Ask your documents. Get answers with the evidence attached.",
  },
  description:
    "Answers questions from your workspace's documents, citing the passage behind every claim. When the documents don't cover a question, it says so.",
  openGraph: {
    title: "RAG-4i: answers from your documents, with the evidence attached",
    description:
      "Ask questions in plain language and get answers from your workspace's own documents, cited to the passage behind every claim.",
    siteName: "RAG-4i",
    type: "website",
    locale: "en",
  },
};

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteNav />
      <main id="main" className="flex-1">
        <Hero />
        <EvidenceSection />
        <StepsSection />
        <SpacesSection />
        <SecuritySection />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
