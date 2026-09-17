"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";

import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Account and workspace.
 *
 * Everything here is the signed-in user's own information, read from the live
 * session and the RLS-scoped memberships row. No infrastructure detail, no
 * tokens, no internal identifiers beyond the user's own account id.
 */
export function AccountCard() {
  const { user, workspaces, activeWorkspace, signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  const rows: Array<[string, string]> = [
    ["Signed in as", user?.email ?? "—"],
    ["Workspace", activeWorkspace?.name ?? "—"],
    ["Role", activeWorkspace ? activeWorkspace.role : "—"],
    ["Workspaces", String(workspaces.length)],
    ["Account id", user?.id ?? "—"],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account and workspace</CardTitle>
        <CardDescription>
          Your session and the workspace your questions are scoped to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-border divide-y">
          {rows.map(([term, value]) => (
            <div
              key={term}
              className="grid gap-1 py-3 sm:grid-cols-[minmax(0,11rem)_1fr] sm:gap-4"
            >
              <dt className="text-muted-foreground text-xs font-medium">
                {term}
              </dt>
              <dd className="font-mono text-sm break-all">{value}</dd>
            </div>
          ))}
        </dl>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-4 gap-1.5"
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </CardContent>
    </Card>
  );
}
