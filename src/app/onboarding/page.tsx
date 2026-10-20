"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { DIMENSIONS, SCALE, LIFE_CONTEXT_OPTIONS, type PoliticalAnswers } from "@/lib/political";

const TERMS_VERSION = "pilot-v1";

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [ageBand, setAgeBand] = useState("");
  const [region, setRegion] = useState("");
  const [community, setCommunity] = useState("");
  const [context, setContext] = useState<string[]>([]);
  const [shareContext, setShareContext] = useState(false);
  const [answers, setAnswers] = useState<PoliticalAnswers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered = Object.keys(answers).length;

  async function finish() {
    setBusy(true); setError(null);
    const { error } = await supabaseBrowser().rpc("complete_onboarding", {
      p_age_band: ageBand || null, p_region: region || null, p_community: community || null,
      p_life_context: context, p_share_context: shareContext, p_political_answers: answers, p_terms_version: TERMS_VERSION,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.push("/lobby");
  }

  const steps = ["Basics", "About you", "Your views", "Done"];

  return (
    <div className="space-y-6">
      <ol className="flex gap-2 text-xs muted" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold" : ""} style={i === step ? { color: "var(--fg)" } : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Before you start</h1>
          <label className="flex gap-3 items-start card cursor-pointer">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
            <span>I am 18 or older.</span>
          </label>
          <label className="flex gap-3 items-start card cursor-pointer">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span>
              I understand this is a pilot. My messages are reviewed before delivery, I'll appear under a random alias, and
              sharing contact details isn't available. <a className="underline" href="/privacy" target="_blank">Details</a>
            </span>
          </label>
          <button className="btn btn-primary w-full" disabled={!adult || !terms} onClick={() => setStep(1)}>Continue</button>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">A little about you</h1>
          <p className="muted text-sm">All optional and deliberately coarse. Nothing here is shown to the person you talk with.</p>
          <Select label="Age" value={ageBand} onChange={setAgeBand} options={["18-24", "25-34", "35-44", "45-54", "55-64", "65+"]} />
          <Select label="Region" value={region} onChange={setRegion} options={["northeast", "midwest", "south", "west", "other"]} />
          <Select label="Where you live" value={community} onChange={setCommunity} options={["urban", "suburban", "rural", "mixed"]} />
          <fieldset>
            <legend className="text-sm font-medium mb-2">Life context (pick any)</legend>
            <div className="flex flex-wrap gap-2">
              {LIFE_CONTEXT_OPTIONS.map((o) => {
                const on = context.includes(o);
                return (
                  <button type="button" key={o} aria-pressed={on} onClick={() => setContext(on ? context.filter((c) => c !== o) : [...context, o])}
                    className="btn btn-secondary px-3 py-1.5 text-sm" style={on ? { borderColor: "var(--accent)", background: "var(--ok-bg)" } : undefined}>
                    {o}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="flex gap-3 items-start card cursor-pointer">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={shareContext} onChange={(e) => setShareContext(e.target.checked)} />
            <span className="text-sm">
              Let the question generator use my life context to pick better questions. Only used if the other person also agrees, and never shown to them.
            </span>
          </label>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setStep(0)}>Back</button>
            <button className="btn btn-primary flex-1" onClick={() => setStep(2)}>Continue</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-5">
          <h1 className="text-2xl font-semibold">Your views</h1>
          <p className="muted text-sm">
            This is only used to pair you with someone who answered differently. Your answers are private: the other person
            will only know that you differ, never how. Answer at least 3; skip any you like.
          </p>
          {DIMENSIONS.map((d) => (
            <fieldset key={d.key} className="card space-y-2">
              <legend className="font-medium">{d.prompt}</legend>
              <div className="flex justify-between text-xs muted"><span>{d.low}</span><span>{d.high}</span></div>
              <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={d.prompt}>
                {SCALE.map((s) => {
                  const on = answers[d.key] === s.value;
                  return (
                    <button type="button" key={s.value} role="radio" aria-checked={on} aria-label={s.label}
                      onClick={() => setAnswers({ ...answers, [d.key]: s.value })}
                      className="btn btn-secondary px-0 text-xs" style={on ? { borderColor: "var(--accent)", background: "var(--ok-bg)" } : undefined}>
                      {s.value === 0 ? "?" : s.value < 0 ? "◀".repeat(-s.value) : "▶".repeat(s.value)}
                    </button>
                  );
                })}
              </div>
              {answers[d.key] !== undefined && (
                <button type="button" className="btn btn-ghost text-xs px-2 py-1 min-h-0" onClick={() => { const a = { ...answers }; delete a[d.key]; setAnswers(a); }}>Skip this one</button>
              )}
            </fieldset>
          ))}
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary flex-1" disabled={answered < 3} onClick={() => setStep(3)}>
              {answered < 3 ? `Answer ${3 - answered} more` : "Continue"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">You're set</h1>
          <p className="muted">When you're ready, you'll join a waiting list. We'll look for someone who answered differently and invite you both. Either of you can decline.</p>
          {error && <div className="notice notice-bad" role="alert">{error}</div>}
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-primary flex-1" disabled={busy} onClick={finish}>{busy ? "Saving…" : "Finish"}</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div>
      <label className="block text-sm font-medium mb-1" htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Prefer not to say</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
