"use client";
import { useState } from "react";

export function DeleteAccount() {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    setBusy(true); setError(null);
    const res = await fetch("/api/account", { method: "DELETE" });
    if (!res.ok) { setError("Couldn't delete right now. Try again."); setBusy(false); return; }
    window.location.assign(window.location.origin + "/");
  }

  return (
    <section className="card space-y-3 text-sm">
      <h2 className="font-medium">Delete my account and data</h2>
      <p className="muted">Removes your account, profile, questionnaire answers, messages you sent, reflections and connections right away. Reports you filed are kept for safety review without your account attached. This can't be undone.</p>
      <label className="block" htmlFor="confirm">Type <strong>delete</strong> to confirm</label>
      <input id="confirm" className="field" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      {error && <div className="notice notice-bad" role="alert">{error}</div>}
      <button className="btn btn-danger" disabled={confirm !== "delete" || busy} onClick={del}>{busy ? "Deleting…" : "Delete everything"}</button>
    </section>
  );
}
