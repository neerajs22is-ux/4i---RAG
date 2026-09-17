import { AuthGate } from "@/components/auth/auth-gate";
import { DesktopSidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";

/**
 * Application shell.
 *
 * `AuthGate` resolves the session and the active workspace before anything
 * protected renders, so the workspace is never briefly visible to a signed-out
 * visitor. Inside the gate the layout owns the viewport: a persistent sidebar,
 * a sticky top bar and one independently scrolling content region. Pages never
 * manage their own page chrome — they render inside `PageFrame`.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AuthGate>
      <div className="flex h-dvh w-full overflow-hidden">
        <DesktopSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </AuthGate>
  );
}
