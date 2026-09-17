"use client";

import { motion } from "motion/react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  EvidenceStateDot,
  EvidenceStatusBadge,
  EvidenceStatusRow,
  evidenceStateConfig,
  type EvidenceState,
} from "@/components/foundation/evidence-status";
import {
  FadeIn,
  ScaleIn,
  SlideIn,
  Stagger,
  StaggerItem,
} from "@/components/motion/primitives";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* ------------------------------------------------------------------ layout */

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <SlideIn
      direction="up"
      className="scroll-mt-24 border-t hairline pt-10"
      id={id}
      onMount
    >
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {hint && (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm text-pretty">
            {hint}
          </p>
        )}
      </div>
      {children}
    </SlideIn>
  );
}

function Swatch({
  name,
  token,
  className,
  foreground,
}: {
  name: string;
  token: string;
  className: string;
  foreground?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border hairline">
      <div
        className={`flex h-14 items-end p-2 text-2xs font-medium ${className} ${foreground ?? ""}`}
      >
        Aa
      </div>
      <div className="bg-card px-2.5 py-2">
        <p className="text-xs font-medium">{name}</p>
        <p className="text-muted-foreground font-mono text-2xs">{token}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- page */

const EVIDENCE_STATES: EvidenceState[] = [
  "supported",
  "partial",
  "conflicting",
  "insufficient",
];

export default function ShowcasePage() {
  const [motionKey, setMotionKey] = useState(0);
  const [loading, setLoading] = useState(false);

  return (
    <div className="min-h-svh bg-background">
      {/* Header */}
      <header className="bg-background/80 sticky top-0 z-40 border-b hairline backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-2.5">
            <span className="bg-primary text-primary-foreground inline-flex size-6 items-center justify-center rounded-md text-2xs font-semibold">
              4i
            </span>
            <span className="text-sm font-medium">Foundation</span>
            <Badge variant="secondary" className="font-mono text-2xs">
              dev
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                Home
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-6 py-12">
        <FadeIn onMount>
          <p className="text-primary font-mono text-2xs tracking-widest uppercase">
            UI Pass 1
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">
            Design &amp; motion foundation
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl text-pretty">
            Internal QA surface for the RAG-4i design system. Everything here is
            token-driven: typography, colour, radius, elevation, and motion are
            defined once and consumed by component classes. Not part of the
            shipped product.
          </p>
        </FadeIn>

        <div className="mt-10 space-y-12">
          {/* ------------------------------------------------ typography */}
          <Section
            id="typography"
            title="Typography"
            hint="Instrument Sans for interface and prose; JetBrains Mono for citations, identifiers and metrics. Tabular numerals keep evidence columns aligned."
          >
            <div className="space-y-6">
              <div className="space-y-3">
                <p className="text-4xl font-semibold tracking-tight text-balance">
                  Income-tax Act, 2025
                </p>
                <p className="text-2xl font-semibold tracking-tight">
                  Standard deduction
                </p>
                <p className="text-lg">Answers grounded in your documents.</p>
                <p className="text-sm">
                  Body copy at the default size, used for answer text. Line height
                  stays generous so long, dense answers remain readable.
                </p>
                <p className="text-muted-foreground text-sm">
                  Secondary copy for context, captions and supporting detail.
                </p>
                <p className="text-2xs text-muted-foreground font-medium tracking-wide uppercase">
                  Metadata label
                </p>
              </div>
              <Separator />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="bg-card rounded-lg border hairline p-4">
                  <p className="text-muted-foreground mb-2 text-2xs font-medium tracking-wide uppercase">
                    Citation · mono
                  </p>
                  <p className="font-mono text-sm">
                    §19 Table Sl.2(a) · p.46 ·{" "}
                    <span className="text-muted-foreground">
                      231f38fb · 0.0328
                    </span>
                  </p>
                </div>
                <div className="bg-card rounded-lg border hairline p-4">
                  <p className="text-muted-foreground mb-2 text-2xs font-medium tracking-wide uppercase">
                    Metrics · tabular
                  </p>
                  <div className="font-mono text-sm">
                    <span className="text-muted-foreground">recall@8</span>{" "}
                    0.604 · <span className="text-muted-foreground">mrr</span>{" "}
                    0.813 ·{" "}
                    <span className="text-muted-foreground">evidence</span> 8/8
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------- colour */}
          <Section
            id="colour"
            title="Colour"
            hint="Cool neutral surfaces with a single indigo accent. Semantic colours are reserved for evidence state and system feedback — never decoration."
          >
            <div className="space-y-8">
              <div>
                <p className="text-muted-foreground mb-3 text-2xs font-medium tracking-wide uppercase">
                  Surfaces &amp; interaction
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  <Swatch
                    name="Background"
                    token="--background"
                    className="bg-background"
                  />
                  <Swatch name="Card" token="--card" className="bg-card" />
                  <Swatch
                    name="Muted"
                    token="--muted"
                    className="bg-muted"
                  />
                  <Swatch
                    name="Accent"
                    token="--accent"
                    className="bg-accent"
                  />
                  <Swatch
                    name="Primary"
                    token="--primary"
                    className="bg-primary"
                    foreground="text-primary-foreground"
                  />
                  <Swatch
                    name="Border"
                    token="--border"
                    className="bg-border"
                  />
                </div>
              </div>

              <div>
                <p className="text-muted-foreground mb-3 text-2xs font-medium tracking-wide uppercase">
                  Evidence &amp; feedback semantics
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                  <Swatch
                    name="Success"
                    token="--success"
                    className="bg-success"
                    foreground="text-success-foreground"
                  />
                  <Swatch
                    name="Warning"
                    token="--warning"
                    className="bg-warning"
                    foreground="text-warning-foreground"
                  />
                  <Swatch
                    name="Conflict"
                    token="--conflict"
                    className="bg-conflict"
                    foreground="text-conflict-foreground"
                  />
                  <Swatch
                    name="Neutral state"
                    token="--neutral-state"
                    className="bg-neutral-state"
                    foreground="text-neutral-state-foreground"
                  />
                  <Swatch
                    name="Destructive"
                    token="--destructive"
                    className="bg-destructive"
                    foreground="text-destructive-foreground"
                  />
                </div>
              </div>
            </div>
          </Section>

          {/* -------------------------------------------- evidence states */}
          <Section
            id="evidence"
            title="Evidence states"
            hint="The four gate outcomes, translated for readers. The same state always uses the same colour, icon and wording."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {EVIDENCE_STATES.map((state) => (
                    <EvidenceStatusBadge key={state} state={state} />
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {EVIDENCE_STATES.map((state) => (
                    <span
                      key={state}
                      className="bg-card inline-flex items-center gap-2 rounded-full border hairline px-2.5 py-1 text-2xs"
                    >
                      <EvidenceStateDot state={state} />
                      {evidenceStateConfig(state).label}
                    </span>
                  ))}
                </div>
              </div>
              <Card>
                <CardContent className="space-y-5 pt-6">
                  {EVIDENCE_STATES.map((state) => (
                    <EvidenceStatusRow key={state} state={state} />
                  ))}
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* --------------------------------------------------- buttons */}
          <Section
            id="buttons"
            title="Buttons"
            hint="Six variants, six sizes, visible focus rings, and an explicit loading state that preserves width."
          >
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button>Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
                <Button variant="destructive">
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs">Extra small</Button>
                <Button size="sm">Small</Button>
                <Button size="default">Default</Button>
                <Button size="lg">Large</Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="icon" aria-label="Search">
                      <Search className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Search documents</TooltipContent>
                </Tooltip>
                <Button size="icon-sm" variant="outline" aria-label="Add">
                  <Plus className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Copy">
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled>Disabled</Button>
                <Button
                  variant="outline"
                  disabled
                  className="gap-2"
                  onClick={() => setLoading((v) => !v)}
                >
                  {loading && <Loader2 className="size-3.5 animate-spin" />}
                  {loading ? "Working…" : "Simulate"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setLoading((v) => !v)}
                  aria-live="polite"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Searching evidence…
                    </>
                  ) : (
                    <>
                      Toggle loading
                      <ChevronDown className="size-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Section>

          {/* ---------------------------------------------------- inputs */}
          <Section
            id="inputs"
            title="Inputs"
            hint="Labelled, keyboard-reachable, and explicit about invalid state via aria-invalid — not colour alone."
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="showcase-question">Ask a question</Label>
                <Input
                  id="showcase-question"
                  placeholder="What is the standard deduction under section 202(1)?"
                />
                <p className="text-muted-foreground text-2xs">
                  Enter to send · Shift+Enter for a new line
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="showcase-disabled">Disabled</Label>
                <Input id="showcase-disabled" disabled defaultValue="Read only" />
                <p className="text-muted-foreground text-2xs">
                  Disabled controls stay legible and focus-skipped.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="showcase-invalid">Invalid</Label>
                <Input
                  id="showcase-invalid"
                  aria-invalid
                  defaultValue="not-a-uuid"
                  aria-describedby="showcase-invalid-error"
                />
                <p
                  id="showcase-invalid-error"
                  className="text-destructive text-2xs"
                >
                  That identifier is not valid.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="showcase-notes">Long form</Label>
                <Textarea
                  id="showcase-notes"
                  rows={3}
                  placeholder="Add context for the retrieval…"
                />
              </div>
            </div>
          </Section>

          {/* ----------------------------------------------------- cards */}
          <Section
            id="cards"
            title="Surfaces &amp; elevation"
            hint="Three levels only: the page, raised cards, and floating overlays. Borders carry the structure; shadows stay quiet."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card className="shadow-xs">
                <CardHeader>
                  <CardTitle className="text-base">Flat</CardTitle>
                  <CardDescription>
                    Default surface for lists and dense content.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-16 w-full" />
                </CardContent>
              </Card>
              <Card className="shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Raised</CardTitle>
                  <CardDescription>
                    Hover target — lifts one step, never bounces.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <FileText className="text-muted-foreground size-4" />
                    <span className="font-mono text-xs">incometax.pdf</span>
                    <Badge variant="secondary" className="ml-auto text-2xs">
                      78 pp
                    </Badge>
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-glow border-primary/30">
                <CardHeader>
                  <CardTitle className="text-base">Accent</CardTitle>
                  <CardDescription>
                    Reserved for the primary call to action.
                  </CardDescription>
                </CardHeader>
                <CardFooter>
                  <Button size="sm" className="w-full">
                    Start asking
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </Section>

          {/* --------------------------------------------------- loading */}
          <Section
            id="loading"
            title="Loading"
            hint="Skeletons mirror the shape of the content they replace; shimmer is subtle and stops entirely under reduced motion."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Answer skeleton</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <div className="flex gap-2 pt-2">
                    <Skeleton className="h-6 w-24 rounded-full" />
                    <Skeleton className="h-6 w-20 rounded-full" />
                  </div>
                </CardContent>
              </Card>
              <Card className="shimmer relative overflow-hidden">
                <CardHeader>
                  <CardTitle className="text-base">Processing document</CardTitle>
                  <CardDescription>
                    Parse → chunk → embed, surfaced honestly.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="text-primary size-4 animate-spin" />
                    Embedding chunks
                    <span className="text-muted-foreground font-mono ml-auto text-xs">
                      186 / 226
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                    <motion.div
                      className="bg-primary h-full rounded-full"
                      initial={{ width: "20%" }}
                      animate={{ width: "82%" }}
                      transition={{ duration: 1.6, ease: [0.05, 0.7, 0.1, 1] }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* ---------------------------------------------------- motion */}
          <Section
            id="motion"
            title="Motion"
            hint="Five primitives, one vocabulary. Entrance motion is a one-shot reveal: safe to re-run, never distracting."
          >
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMotionKey((k) => k + 1)}
                >
                  Replay entrance
                </Button>
                <span className="text-muted-foreground text-2xs">
                  Remounts the block below.
                </span>
              </div>
              <div key={motionKey} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <FadeIn onMount>
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle className="text-sm">FadeIn</CardTitle>
                      <CardDescription className="text-xs">
                        Opacity only.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </FadeIn>
                <SlideIn onMount direction="up">
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle className="text-sm">SlideIn</CardTitle>
                      <CardDescription className="text-xs">
                        Directional offset.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </SlideIn>
                <ScaleIn onMount>
                  <Card className="h-full">
                    <CardHeader>
                      <CardTitle className="text-sm">ScaleIn</CardTitle>
                      <CardDescription className="text-xs">
                        Slight emphasis.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </ScaleIn>
                <Stagger onMount>
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <StaggerItem key={i}>
                        <Card>
                          <CardContent className="flex items-center gap-2 py-3">
                            <Check className="text-success size-3.5" />
                            <span className="text-xs">Staggered {i + 1}</span>
                          </CardContent>
                        </Card>
                      </StaggerItem>
                    ))}
                  </div>
                </Stagger>
              </div>
            </div>
          </Section>

          {/* -------------------------------------------------- overlays */}
          <Section
            id="overlays"
            title="Overlays"
            hint="Radix behaviour under the hood: focus trap, Escape to close, focus returned to the trigger."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete document?</DialogTitle>
                    <DialogDescription>
                      This removes the document, its chunks and its embeddings.
                      Existing conversations keep their citations.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="ghost">Cancel</Button>
                    <Button variant="destructive">Delete</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline">Sheet</Button>
                </SheetTrigger>
                <SheetContent side="right">
                  <SheetHeader>
                    <SheetTitle>Evidence</SheetTitle>
                    <SheetDescription>
                      Source passages retrieved for the current answer.
                    </SheetDescription>
                  </SheetHeader>
                  <ScrollArea className="mt-4 h-64 pr-3">
                    <div className="space-y-3">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <div
                          key={i}
                          className="bg-card rounded-lg border hairline p-3"
                        >
                          <p className="font-mono text-2xs text-muted-foreground">
                            §19 Table Sl.2(a) · p.46
                          </p>
                          <p className="mt-1 text-xs">
                            Standard deduction: ₹75,000 or the salary, whichever
                            is less…
                          </p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </SheetContent>
              </Sheet>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Popover</Button>
                </PopoverTrigger>
                <PopoverContent className="w-72">
                  <p className="text-sm font-medium">Retrieval settings</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Hybrid search · 20 dense + 20 lexical · RRF fusion · top 8
                    passages.
                  </p>
                </PopoverContent>
              </Popover>

              <HoverCard>
                <HoverCardTrigger asChild>
                  <Button variant="ghost">Hover card</Button>
                </HoverCardTrigger>
                <HoverCardContent className="w-72">
                  <p className="text-2xs text-muted-foreground font-mono">
                    chunk 231f38fb · p.46
                  </p>
                  <p className="mt-1 text-xs">
                    Dense rank 1 · lexical rank 3 · fused score 0.0328
                  </p>
                </HoverCardContent>
              </HoverCard>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Copy answer">
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy answer</TooltipContent>
              </Tooltip>
            </div>
          </Section>

          {/* --------------------------------------------- accessibility */}
          <Section
            id="accessibility"
            title="Accessibility &amp; reduced motion"
            hint="Baseline guarantees for every surface built on this foundation."
          >
            <Card>
              <CardContent className="text-muted-foreground space-y-2 pt-6 text-sm">
                <ul className="list-disc space-y-1.5 pl-5">
                  <li>
                    Visible focus rings on every interactive element via
                    <code className="text-foreground mx-1">:focus-visible</code>
                    — never removed.
                  </li>
                  <li>
                    Keyboard: Radix handles focus traps, Escape, arrow-key
                    navigation and focus return.
                  </li>
                  <li>
                    State is communicated by icon and text, not colour alone
                    (evidence badges carry labels; invalid inputs set
                    <code className="text-foreground mx-1">aria-invalid</code>).
                  </li>
                  <li>
                    <code className="text-foreground">prefers-reduced-motion</code>{" "}
                    is honoured globally: transforms are skipped, opacity
                    transitions remain so content does not pop.
                  </li>
                  <li>
                    Skip-to-content link is the first focusable element; the
                    layout uses semantic landmarks.
                  </li>
                </ul>
              </CardContent>
            </Card>
          </Section>

          <Separator />
          <p className="text-muted-foreground pb-8 text-2xs">
            RAG-4i foundation QA · not linked from the product · remove before
            shipping.
          </p>
        </div>
      </main>
    </div>
  );
}
