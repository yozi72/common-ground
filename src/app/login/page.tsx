"use client";
import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Lantern } from "@/components/Illustrations";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(params.get("error"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending"); setError(null);
    const next = params.get("next") ?? "/lobby";
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (error) { setError(error.message); setState("error"); return; }
    setState("sent");
  }

  return (
    <div className="max-w-sm mx-auto space-y-6">
      <Lantern className="w-36 h-auto mx-auto float" />
      <div className="text-center">
        <h1 className="text-3xl font-semibold">Sign in</h1>
        <p className="muted text-sm mt-1">We'll email you a one-time link. No password. Your email is used to sign you in and, only if you choose, for session reminders. It's never shown to other participants.</p>
      </div>
      {state === "sent" ? (
        <div className="notice notice-ok" role="status">Check your inbox for a sign-in link. It expires in an hour.</div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="email">Email</label>
          <input id="email" className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <div className="notice notice-bad" role="alert">{error}</div>}
          <button className="btn btn-primary w-full" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Email me a link"}</button>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
