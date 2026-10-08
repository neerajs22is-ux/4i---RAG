import { FileText, Lock } from "lucide-react";

/**
 * Workspace-isolation figure.
 *
 * Two workspaces with their own documents, separated by the database
 * boundary that the product actually enforces (row-level security on every
 * read). Illustrative workspace and file names; the mechanism drawn is the
 * implemented one.
 */

const WORKSPACES = [
  {
    name: "Tax & advisory",
    files: ["Year-End Procedures.pdf", "Fixed Assets Advisory Note.pdf"],
  },
  {
    name: "Audit",
    files: ["Engagement Letters.pdf", "Sampling Guide.pdf"],
  },
];

function WorkspacePanel({ name, files }: { name: string; files: string[] }) {
  return (
    <div className="bg-card hairline min-w-0 rounded-xl border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="bg-primary text-primary-foreground text-2xs inline-flex size-5 shrink-0 items-center justify-center rounded font-semibold"
          aria-hidden="true"
        >
          4i
        </span>
        <p className="min-w-0 truncate text-xs font-medium">{name}</p>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {files.map((file) => (
          <li
            key={file}
            className="bg-background hairline flex items-center gap-2 rounded-md border px-2 py-1.5"
          >
            <FileText
              className="text-muted-foreground size-3 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-xs" title={file}>
              {file}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IsolationFigure() {
  return (
    <figure
      className="bg-background hairline rounded-2xl border p-3.5 shadow-sm sm:p-5"
      aria-label="Two workspaces separated by database-level row security"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch sm:gap-5">
        <WorkspacePanel {...WORKSPACES[0]} />

        <div
          className="flex items-center justify-center gap-2 sm:flex-col"
          aria-hidden="true"
        >
          <span className="bg-border h-px flex-1 sm:h-auto sm:w-px" />
          <span className="bg-card hairline inline-flex size-7 shrink-0 items-center justify-center rounded-full border">
            <Lock className="text-primary-strong size-3" />
          </span>
          <span className="bg-border h-px flex-1 sm:h-auto sm:w-px" />
        </div>

        <WorkspacePanel {...WORKSPACES[1]} />
      </div>
      <figcaption className="text-muted-foreground mt-4 text-center text-xs text-pretty">
        Row-level security: every document, passage and conversation is scoped
        to its workspace in the database, on every read.
      </figcaption>
    </figure>
  );
}
