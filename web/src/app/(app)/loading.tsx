import { PageFrame } from "@/components/foundation/page-frame";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading boundary.
 *
 * Mirrors the shape of a content page (header block, then surface) so the
 * transition into real content is a cross-fade, not a jump. This is a shell
 * skeleton only — the AI generation indicator is a separate, later component.
 */
export default function AppLoading() {
  return (
    <PageFrame>
      <div className="space-y-8" aria-busy="true">
        <div className="space-y-3">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
        <span className="sr-only" role="status">
          Loading content
        </span>
      </div>
    </PageFrame>
  );
}
