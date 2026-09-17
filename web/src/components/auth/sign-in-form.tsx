"use client";

import { useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";

import { getSupabaseClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sign-in form.
 *
 * Email + password only: that is the method the project's Supabase Auth
 * supports today, and accounts are provisioned by an administrator (there is no
 * self-serve signup, and no mail delivery for magic links or recovery on this
 * project).
 *
 * Error handling maps the auth provider's failures onto plain language and
 * never renders the provider's own message.
 */

type FormState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

function messageForAuthError(error: { code?: string; status?: number; message?: string }): string {
  const code = error.code ?? "";
  if (code === "invalid_credentials" || error.status === 400) {
    return "That email and password combination was not recognised.";
  }
  if (code === "email_not_confirmed") {
    return "This address has not been confirmed yet. Ask your administrator to confirm it.";
  }
  if (code === "over_request_rate_limit" || error.status === 429) {
    return "Too many attempts. Wait a moment and try again.";
  }
  if (error.status === 422) {
    return "Enter a valid email address and password.";
  }
  return "We could not sign you in. Try again.";
}

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });

  const submitting = state.kind === "submitting";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setState({ kind: "submitting" });
    try {
      const { error } = await getSupabaseClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        setState({ kind: "error", message: messageForAuthError(error) });
        return;
      }
      // On success the session provider reacts to onAuthStateChange; nothing
      // else to do here.
      setState({ kind: "idle" });
    } catch {
      setState({
        kind: "error",
        message: "We could not reach the service. Check your connection.",
      });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 text-left" noValidate>
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          aria-invalid={state.kind === "error" ? true : undefined}
          placeholder="you@company.com"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="signin-password">Password</Label>
        <Input
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          aria-invalid={state.kind === "error" ? true : undefined}
        />
      </div>

      {state.kind === "error" ? (
        <p role="alert" className="text-destructive text-xs">
          {state.message}
        </p>
      ) : null}

      <Button
        type="submit"
        className="w-full gap-2"
        disabled={submitting || !email || !password}
      >
        {submitting ? (
          <>
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            Signing in…
          </>
        ) : (
          <>
            Sign in
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </>
        )}
      </Button>

      <p className="text-muted-foreground text-2xs text-pretty">
        Accounts are provisioned by your workspace administrator. Password
        recovery is not available in the app yet — contact your administrator if
        you are locked out.
      </p>
    </form>
  );
}
