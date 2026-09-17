"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { SignInForm } from "@/components/auth/sign-in-form";
import {
  CenteredState,
  ErrorState,
  LoadingState,
} from "@/components/foundation/data-states";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useSession } from "@/components/providers/session-provider";
import { DURATION, EASE } from "@/lib/motion";

/**
 * Session gate for the application shell.
 *
 * Resolution order — protected content is never rendered until every check has
 * passed, so there is no flash of the workspace before we know who the visitor
 * is:
 *
 *   environment missing → configuration notice
 *   session loading     → polished loading state
 *   signed out          → sign-in
 *   workspace loading   → loading state
 *   no membership       → "no workspace access" (a real authorization outcome)
 *   workspace error     → retryable error
 *   ready               → application shell
 */

function BrandMark() {
  return (
    <span
      className="bg-primary text-primary-foreground text-2xs mx-auto inline-flex size-8 items-center justify-center rounded-lg font-semibold"
      aria-hidden="true"
    >
      4i
    </span>
  );
}

function SignInScreen() {
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DURATION.slow, ease: EASE.decelerate }}
        className="bg-card hairline w-full max-w-sm rounded-xl border p-6 shadow-sm"
      >
        <div className="text-center">
          <BrandMark />
          <h1 className="mt-4 text-base font-semibold tracking-tight">
            Sign in to RAG&#8209;4i
          </h1>
          <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
            Answers grounded in your documents, with the passages they came from.
          </p>
        </div>
        <div className="mt-6">
          <SignInForm />
        </div>
      </motion.div>
    </div>
  );
}

function NotConfigured() {
  return (
    <CenteredState
      title="Not configured"
      description="This deployment has no Supabase environment yet. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.example) and restart the app."
    />
  );
}

function NoWorkspace({ onRetry }: { onRetry: () => void }) {
  return (
    <CenteredState
      title="No workspace access"
      description="Your account is not a member of any workspace yet. Access is granted by a workspace administrator."
    >
      <Button variant="outline" onClick={onRetry}>
        Check again
      </Button>
    </CenteredState>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const {
    configured,
    status,
    workspaceStatus,
    workspaceError,
    refreshWorkspaces,
  } = useSession();

  if (!configured) return <NotConfigured />;

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Starting RAG-4i" />
      </div>
    );
  }

  if (status === "signed-out") return <SignInScreen />;

  if (workspaceStatus === "idle" || workspaceStatus === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading your workspace" />
      </div>
    );
  }

  if (workspaceStatus === "none") {
    return <NoWorkspace onRetry={refreshWorkspaces} />;
  }

  if (workspaceStatus === "error") {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6">
        <ErrorState
          error={workspaceError}
          onRetry={refreshWorkspaces}
          title="Could not load your workspace"
          className="w-full max-w-sm"
        />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION.normal, ease: EASE.standard }}
      className="h-dvh"
    >
      {children}
    </motion.div>
  );
}
