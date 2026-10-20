import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Talk with someone who sees politics differently.</h1>
        <p className="text-lg muted">
          Common Ground pairs you with another adult whose answers differ from yours, then gives you both the same
          human questions to answer. No names, no debates, no winning.
        </p>
        <div className="flex gap-3 flex-wrap pt-2">
          <Link href="/login" className="btn btn-primary">Get started</Link>
          <a href="#how" className="btn btn-secondary">How it works</a>
        </div>
      </section>

      <section id="how" className="grid gap-3 sm:grid-cols-2">
        {[
          ["You stay anonymous", "You appear as a random alias like “Quiet Heron”. Your sign-in email is never shown to anyone you talk with."],
          ["Different, on purpose", "A short questionnaire finds someone who answered differently from you. You'll only ever see “you differ”, never their answers."],
          ["Same questions, both of you", "Ten shared questions to start. Answers are hidden until you've both responded. Then open chat, with a new question now and then."],
          ["Reviewed before delivery", "Every message is checked before the other person sees it, including for contact details. It adds a short delay, and it isn't perfect."],
        ].map(([t, d]) => (
          <div key={t} className="card">
            <h2 className="font-medium">{t}</h2>
            <p className="muted text-sm mt-1">{d}</p>
          </div>
        ))}
      </section>

      <section className="card space-y-2 text-sm">
        <h2 className="font-medium">What this is not</h2>
        <ul className="list-disc pl-5 muted space-y-1">
          <li>Not a place to win an argument or change someone's vote.</li>
          <li>Not perfectly anonymous. We don't share your identity, but no filter catches everything you might reveal yourself.</li>
          <li>Not for anyone under 18.</li>
        </ul>
      </section>
    </div>
  );
}
