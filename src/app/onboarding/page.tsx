"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { DIMENSIONS, LIFE_CONTEXT_OPTIONS, type PoliticalAnswers } from "@/lib/political";
import { Compass, Sprout, QuestionGlyph } from "@/components/Illustrations";

const TERMS_VERSION = "pilot-v1";

// Screens: 0 basics · 1 about you · 2..6 one questionnaire item each · 7 done
const QUESTION_START = 2;
const DONE = QUESTION_START + DIMENSIONS.length;

export default function Onboarding() {
  const router = useRouter();
  const [screen, setScreen] = useState(0);
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
  const qIndex = screen - QUESTION_START;

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

  return (
    <div className="space-y-6">
      <Progress total={DONE + 1} current={screen} />

      {screen === 0 && (
        <section className="space-y-5 pop" key="s0">
          <Compass className="w-40 h-auto mx-auto float" />
          <div className="text-center">
            <h1 className="text-3xl font-semibold">Before you start</h1>
            <p className="muted mt-1">Two quick things, then a little about you.</p>
          </div>
          <label className="option flex gap-3 items-center cursor-pointer" aria-pressed={adult}>
            <input type="checkbox" className="h-6 w-6 accent-[var(--accent)]" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
            <span>I&apos;m 18 or older.</span>
          </label>
          <label className="option flex gap-3 items-start cursor-pointer" aria-pressed={terms}>
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span className="text-base font-normal">
              I get that this is a pilot: my messages are checked before delivery, I&apos;ll have a random alias, and contact details can&apos;t be shared.{" "}
              <a className="underline" href="/privacy" target="_blank">Details</a>
            </span>
          </label>
          <button className="btn btn-primary w-full" disabled={!adult || !terms} onClick={() => setScreen(1)}>Let&apos;s go</button>
        </section>
      )}

      {screen === 1 && (
        <section className="space-y-5 pop" key="s1">
          <div className="text-center">
            <h1 className="text-3xl font-semibold">A little about you</h1>
            <p className="muted mt-1">All optional and deliberately vague. Never shown to the person you talk with.</p>
          </div>
          <Select label="Age" value={ageBand} onChange={setAgeBand} options={["18-24", "25-34", "35-44", "45-54", "55-64", "65+"]} />
          <Select label="Region" value={region} onChange={setRegion} options={["northeast", "midwest", "south", "west", "other"]} />
          <Select label="Where you live" value={community} onChange={setCommunity} options={["urban", "suburban", "rural", "mixed"]} />
          <fieldset>
            <legend className="eyebrow mb-2">Life context — pick any</legend>
            <div className="flex flex-wrap gap-2">
              {LIFE_CONTEXT_OPTIONS.map((o) => {
                const on = context.includes(o);
                return (
                  <button type="button" key={o} className="chip" aria-pressed={on} onClick={() => setContext(on ? context.filter((c) => c !== o) : [...context, o])}>{o}</button>
                );
              })}
            </div>
          </fieldset>
          <label className="option flex gap-3 items-start cursor-pointer" aria-pressed={shareContext}>
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={shareContext} onChange={(e) => setShareContext(e.target.checked)} />
            <span className="text-sm font-normal">Let the question-picker use my life context to choose better questions. Only if the other person agrees too; never shown to them.</span>
          </label>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setScreen(0)}>Back</button>
            <button className="btn btn-primary flex-1" onClick={() => setScreen(QUESTION_START)}>Continue</button>
          </div>
        </section>
      )}

      {qIndex >= 0 && qIndex < DIMENSIONS.length && (
        <QuestionScreen
          key={`q${qIndex}`}
          index={qIndex}
          value={answers[DIMENSIONS[qIndex].key]}
          onChange={(v) => setAnswers({ ...answers, [DIMENSIONS[qIndex].key]: v })}
          onSkip={() => { const a = { ...answers }; delete a[DIMENSIONS[qIndex].key]; setAnswers(a); setScreen(screen + 1); }}
          onBack={() => setScreen(screen - 1)}
          onNext={() => setScreen(screen + 1)}
          answeredSoFar={answered}
        />
      )}

      {screen === DONE && (
        <section className="space-y-5 pop text-center" key="done">
          <Sprout className="w-44 h-auto mx-auto float" />
          <h1 className="text-3xl font-semibold">{answered >= 3 ? "You're set" : `Answer ${3 - answered} more to continue`}</h1>
          {answered >= 3 ? (
            <p className="muted">You answered {answered} of 5. When you&apos;re ready, you&apos;ll join a waiting list and we&apos;ll find someone who sees some of this differently. Either of you can say no thanks.</p>
          ) : (
            <p className="muted">We need at least three answers to find someone who differs from you. Go back and answer a couple more; &ldquo;unsure&rdquo; counts.</p>
          )}
          {error && <div className="notice notice-bad" role="alert">{error}</div>}
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setScreen(DONE - 1)}>Back</button>
            <button className="btn btn-primary flex-1" disabled={busy || answered < 3} onClick={finish}>{busy ? "Saving…" : "Finish"}</button>
          </div>
        </section>
      )}
    </div>
  );
}

function Progress({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="dots" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current + 1} aria-label="Setup progress">
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} className="dot" data-state={i < current ? "done" : i === current ? "current" : "todo"} />
        ))}
      </div>
      <span className="eyebrow">{current + 1} / {total}</span>
    </div>
  );
}

function QuestionScreen({ index, value, onChange, onSkip, onBack, onNext, answeredSoFar }: {
  index: number; value: number | undefined; onChange: (v: number) => void; onSkip: () => void; onBack: () => void; onNext: () => void; answeredSoFar: number;
}) {
  const d = DIMENSIONS[index];
  const v = value ?? 0;
  const label = value === undefined ? "Slide to answer, or skip" : v === 0 ? "Unsure / somewhere in between" : `${Math.abs(v) === 2 ? "Strongly" : "Leaning"} “${v < 0 ? d.low : d.high}”`;
  return (
    <section className="space-y-5 pop">
      <QuestionGlyph index={index} className="w-40 h-auto mx-auto" />
      <div className="text-center">
        <p className="eyebrow">Your views · {index + 1} of {DIMENSIONS.length}</p>
        <h1 className="text-2xl font-semibold mt-1">{d.prompt}</h1>
        {index === 0 && <p className="muted text-sm mt-2">Only used to pair you with someone who answered differently. The other person never sees your answers.</p>}
      </div>
      <div className="card space-y-4">
        <div className="flex justify-between gap-4 text-sm font-medium">
          <span className="text-left flex-1" style={{ color: v < 0 && value !== undefined ? "var(--fg)" : "var(--muted)" }}>{d.low}</span>
          <span className="text-right flex-1" style={{ color: v > 0 ? "var(--fg)" : "var(--muted)" }}>{d.high}</span>
        </div>
        <input type="range" className="slider" min={-2} max={2} step={1} value={v} onChange={(e) => onChange(Number(e.target.value))}
          aria-label={d.prompt} aria-valuetext={label} />
        <p className="text-center text-sm min-h-[1.5rem]" aria-live="polite" style={{ color: value === undefined ? "var(--muted)" : "var(--fg)" }}>{label}</p>
        <div className="flex justify-center">
          <button type="button" className="chip" aria-pressed={value === 0} onClick={() => onChange(0)}>Unsure / in between</button>
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-secondary" onClick={onBack}>Back</button>
        {value === undefined && <button className="btn btn-ghost" onClick={onSkip}>Skip</button>}
        <button className="btn btn-primary flex-1" disabled={value === undefined} onClick={onNext}>{index === DIMENSIONS.length - 1 ? "Done" : "Next"}</button>
      </div>
      <p className="text-center text-xs muted">{answeredSoFar} answered · at least 3 needed</p>
    </section>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div>
      <label className="block text-sm font-semibold mb-1" htmlFor={id}>{label}</label>
      <select id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Prefer not to say</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
