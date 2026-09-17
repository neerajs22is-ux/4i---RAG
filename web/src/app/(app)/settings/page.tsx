import { PageFrame, PageHeader } from "@/components/foundation/page-frame";
import { AccountCard } from "@/components/settings/account-card";
import {
  EvidenceStatusRow,
  type EvidenceState,
} from "@/components/foundation/evidence-status";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Settings.
 *
 * Pass 2 scope: a read-only view of how this deployment is actually configured,
 * taken from the locked V1 architecture. These are facts, not editable
 * preferences — editable workspace settings arrive with API integration.
 */

const ANSWERING = [
  ["Grounding", "Answers are written only from retrieved passages"],
  ["Citations", "Every factual claim must cite a supplied passage"],
  ["Sampling", "Deterministic (temperature 0)"],
  ["When evidence is missing", "Refuses instead of guessing"],
];

const EVIDENCE_STATES: EvidenceState[] = [
  "supported",
  "partial",
  "conflicting",
  "insufficient",
];

function DefinitionList({ rows }: { rows: string[][] }) {
  return (
    <dl className="divide-border divide-y">
      {rows.map(([term, detail]) => (
        <div
          key={term}
          className="grid gap-1 py-3 sm:grid-cols-[minmax(0,11rem)_1fr] sm:gap-4"
        >
          <dt className="text-muted-foreground text-xs font-medium">{term}</dt>
          <dd className="text-sm text-pretty">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function SettingsPage() {
  return (
    <PageFrame>
              <PageHeader
          eyebrow="Workspace"
          title="Settings"
          description="How this deployment retrieves, answers and verifies. Read-only until workspace settings are connected."
          actions={
            <Badge variant="secondary" className="font-mono text-2xs">
              read-only
            </Badge>
          }
        />
      
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="text-base">Retrieval</CardTitle>
              <CardDescription>
                How an answer finds its evidence.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-pretty">
                RAG-4i searches the sources available to your question — the
                documents in this workspace, or those included in a space — to
                find relevant information before generating an answer.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="text-base">Answering</CardTitle>
              <CardDescription>
                The contract every answer is held to.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DefinitionList rows={ANSWERING} />
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Evidence verification
              </CardTitle>
              <CardDescription>
                Before an answer is written, the retrieved passages are checked
                against the question. These are the four outcomes a reader will
                see.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              {EVIDENCE_STATES.map((state) => (
                <EvidenceStatusRow key={state} state={state} />
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <AccountCard />
        </div>
      </div>
    </PageFrame>
  );
}
