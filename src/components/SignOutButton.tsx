"use client";
import { useState } from "react";
import { disablePush } from "@/lib/push-client";

// Signing out also detaches this browser's push subscription from the account,
// so a shared device never keeps delivering to the previous person.
export function SignOutButton({ className = "btn btn-secondary px-3 py-1.5 min-h-0 text-sm whitespace-nowrap" }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <form action="/auth/signout" method="post" onSubmit={async (e) => {
      if (busy) return;
      e.preventDefault();
      setBusy(true);
      try { await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 2500))]); } catch {}
      (e.target as HTMLFormElement).submit();
    }}>
      <button className={className} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>
    </form>
  );
}
