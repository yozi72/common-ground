"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { QUESTIONS, QUESTIONNAIRE_VERSION, UNSURE_LABEL, DECLINE_LABEL, LIFE_CONTEXT_OPTIONS, MAX_LIFE_CONTEXT, MIN_SHARED_ANSWERS, normalize, type Answers, type NonAnswers } from "@/lib/political";
import { Compass, Sprout, QuestionGlyph } from "@/components/Illustrations";

const TERMS_VERSION = "pilot-v1";

// Screens: 0 basics · 1 about you · 2..9 one question each · 10 priorities · 11 done
const QUESTION_START = 2;
const PRIORITIES = QUESTION_START + QUESTIONS.length;
const DONE = PRIORITIES + 1;

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
  const [answers, setAnswers] = useState<Answers>({});
  const [nonAnswers, setNonAnswers] = useState<NonAnswers>({});
  const [priorities, setPriorities] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Editing: start from what is already saved so unchanged answers are kept.
  // A failed load blocks submission (otherwise an empty form could overwrite saved data).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = supabaseBrowser();
      const [{ data: profile, error: e1 }, { data: account, error: e2 }] = await Promise.all([
        sb.from("profiles").select("age_band, region, community, life_context, share_context_with_prompts, political_answers, political_nonanswers, issue_priorities, questionnaire_version").limit(1).maybeSingle(),
        sb.from("accounts").select("onboarding_complete, adult_attested_at").limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      if (e1 || e2) { setLoadError((e1 ?? e2)?.message ?? "Couldn't load your profile"); return; }
      if (profile) {
        setAgeBand(profile.age_band ?? ""); setRegion(profile.region ?? ""); setCommunity(profile.community ?? "");
        setContext(profile.life_context ?? []); setShareContext(!!profile.share_context_with_prompts);
        if (profile.questionnaire_version === QUESTIONNAIRE_VERSION) {
          setAnswers((profile.political_answers as Answers) ?? {});
          setNonAnswers((profile.political_nonanswers as NonAnswers) ?? {});
          setPriorities(profile.issue_priorities ?? []);
        }
      }
      if (account?.onboarding_complete || account?.adult_attested_at) { setAdult(true); setTerms(true); }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  const answered = Object.keys(answers).length;
  const qIndex = screen - QUESTION_START;

  async function finish() {
    setBusy(true); setError(null);
    const { error } = await supabaseBrowser().rpc("complete_onboarding", {
      p_age_band: ageBand || null, p_region: region || null, p_community: community || null,
      p_life_context: context, p_share_context: shareContext,
      p_political_answers: answers, p_political_nonanswers: nonAnswers, p_issue_priorities: priorities,
      p_questionnaire_version: QUESTIONNAIRE_VERSION, p_terms_version: TERMS_VERSION,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.push("/lobby");
  }

  if (loadError) return (
    <div className="card space-y-3">
      <p className="notice notice-bad" role="alert">We couldn&apos;t load your saved profile ({loadError}). To avoid overwriting your answers, editing is paused.</p>
      <button className="btn btn-primary" onClick={() => { setLoadError(null); setLoadAttempt((n) => n + 1); }}>Try again</button>
    </div>
  );
  if (!loaded) return <p className="muted">Loading…</p>;

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
              I get that this is a pilot: my messages are checked before delivery, I&apos;ll have a random alias, and contact details can&apos;t be shared until two people choose to become friends.{" "}
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
            <legend className="eyebrow mb-2">Life context — pick up to {MAX_LIFE_CONTEXT}</legend>
            <p className="muted text-xs mb-2" id="context-count" aria-live="polite">{context.length} of {MAX_LIFE_CONTEXT} selected{context.length >= MAX_LIFE_CONTEXT ? " · unselect one to choose another" : ""}</p>
            <div className="flex flex-wrap gap-2" aria-describedby="context-count">
              {LIFE_CONTEXT_OPTIONS.map((o) => {
                const on = context.includes(o);
                const full = !on && context.length >= MAX_LIFE_CONTEXT;
                return <button type="button" key={o} className="chip" aria-pressed={on} aria-disabled={full} style={full ? { opacity: 0.5 } : undefined} onClick={() => { if (full) return; setContext(on ? context.filter((c) => c !== o) : [...context, o]); }}>{o}</button>;
              })}
            </div>
          </fieldset>
          <label className="option flex gap-3 items-start cursor-pointer" aria-pressed={shareContext}>
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={shareContext} onChange={(e) => setShareContext(e.target.checked)} />
            <span className="text-sm font-normal">Let the question-picker use my life context (the tags above) to choose better questions. Only if the other person agrees too; never shown to them. Your political answers are never used for this.</span>
          </label>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setScreen(0)}>Back</button>
            <button className="btn btn-primary flex-1" onClick={() => setScreen(QUESTION_START)}>Continue</button>
          </div>
        </section>
      )}

      {qIndex >= 0 && qIndex < QUESTIONS.length && (
        <QuestionScreen
          key={`q${qIndex}`}
          index={qIndex}
          answer={answers[QUESTIONS[qIndex].key]}
          nonAnswer={nonAnswers[QUESTIONS[qIndex].key]}
          onAnswer={(optionIndex) => {
            const key = QUESTIONS[qIndex].key;
            setAnswers({ ...answers, [key]: normalize(key, optionIndex) });
            const na = { ...nonAnswers }; delete na[key]; setNonAnswers(na);
          }}
          onNonAnswer={(kind) => {
            const key = QUESTIONS[qIndex].key;
            const a = { ...answers }; delete a[key]; setAnswers(a);
            setNonAnswers({ ...nonAnswers, [key]: kind });
          }}
          onBack={() => setScreen(screen - 1)}
          onNext={() => setScreen(screen + 1)}
          answeredSoFar={answered}
        />
      )}

      {screen === PRIORITIES && (
        <section className="space-y-5 pop" key="prio">
          <div className="text-center">
            <p className="eyebrow">One more, optional</p>
            <h1 className="text-2xl font-semibold mt-1">Which two of these issues matter most to you?</h1>
            <p className="muted text-sm mt-2">Pick up to two, or skip. This isn&apos;t used for matching yet; it helps us evaluate whether it should be.</p>
          </div>
          <div className="grid gap-2">
            {QUESTIONS.map((q) => {
              const on = priorities.includes(q.key);
              return (
                <button type="button" key={q.key} className="option" aria-pressed={on} disabled={!on && priorities.length >= 2}
                  onClick={() => setPriorities(on ? priorities.filter((k) => k !== q.key) : [...priorities, q.key])}>{q.topic}</button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setScreen(screen - 1)}>Back</button>
            <button className="btn btn-primary flex-1" onClick={() => setScreen(DONE)}>{priorities.length ? "Continue" : "Skip"}</button>
          </div>
        </section>
      )}

      {screen === DONE && (
        <section className="space-y-5 pop text-center" key="done">
          <Sprout className="w-44 h-auto mx-auto float" />
          <h1 className="text-3xl font-semibold">You&apos;re set</h1>
          <p className="muted">You answered {answered} of {QUESTIONS.length}.{answered < MIN_SHARED_ANSWERS ? ` With fewer than ${MIN_SHARED_ANSWERS} answers we can't tell who sees things differently from you, so you'd be matched with whoever is available. You can add answers later in Profile.` : " During the conversation hour we'll look for someone who answered differently."}</p>
          {error && <div className="notice notice-bad" role="alert">{error}</div>}
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setScreen(PRIORITIES)}>Back</button>
            <button className="btn btn-primary flex-1" disabled={busy} onClick={finish}>{busy ? "Saving…" : "Finish"}</button>
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
        {Array.from({ length: total }).map((_, i) => <span key={i} className="dot" data-state={i < current ? "done" : i === current ? "current" : "todo"} />)}
      </div>
      <span className="eyebrow">{current + 1} / {total}</span>
    </div>
  );
}

// One question per screen. Explicit options, nothing preselected; "not sure"
// and "prefer not to answer" are distinct from both an answer and skipping.
function QuestionScreen({ index, answer, nonAnswer, onAnswer, onNonAnswer, onBack, onNext, answeredSoFar }: {
  index: number; answer: number | undefined; nonAnswer: "unsure" | "declined" | undefined;
  onAnswer: (optionIndex: number) => void; onNonAnswer: (kind: "unsure" | "declined") => void; onBack: () => void; onNext: () => void; answeredSoFar: number;
}) {
  const q = QUESTIONS[index];
  const selectedIndex = answer === undefined ? null : Math.round(answer * (q.options.length - 1));
  return (
    <section className="space-y-5 pop">
      <QuestionGlyph index={index} className="w-32 h-auto mx-auto" />
      <div className="text-center">
        <p className="eyebrow">{q.topic} · {index + 1} of {QUESTIONS.length}</p>
        <h1 className="text-2xl font-semibold mt-1">{q.prompt}</h1>
        {index === 0 && <p className="muted text-sm mt-2">Only used to find someone who answered differently. The other person never sees your answers, and they are never sent to the AI that writes conversation questions. The more you answer, the better we can tell who differs from you.</p>}
      </div>
      <div className="grid gap-2" role="radiogroup" aria-label={q.prompt}>
        {q.options.map((label, i) => (
          <button type="button" key={label} role="radio" aria-checked={selectedIndex === i} className="option" onClick={() => onAnswer(i)}>{label}</button>
        ))}
        <button type="button" role="radio" aria-checked={nonAnswer === "unsure"} className="option muted" onClick={() => onNonAnswer("unsure")}>{UNSURE_LABEL}</button>
        <button type="button" role="radio" aria-checked={nonAnswer === "declined"} className="option muted" onClick={() => onNonAnswer("declined")}>{DECLINE_LABEL}</button>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-secondary" onClick={onBack}>Back</button>
        <button className="btn btn-primary flex-1" onClick={onNext}>{answer === undefined && !nonAnswer ? "Skip" : index === QUESTIONS.length - 1 ? "Done" : "Next"}</button>
      </div>
      <p className="text-center text-xs muted">{answeredSoFar} answered · {MIN_SHARED_ANSWERS}+ lets us find someone who differs</p>
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
