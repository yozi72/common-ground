import { TwoCups, Bridge, Lantern, Sprout } from "@/components/Illustrations";
import { SessionStatus } from "@/components/SessionStatus";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getScheduleConfig, serverNow } from "@/lib/schedule-config";
import { sessionState } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The same schedule configuration every other screen uses (policy_config).
  const [schedule, { data: auth }] = await Promise.all([getScheduleConfig(), (await createSupabaseServerClient()).auth.getUser()]);
  const now = serverNow();
  const href = auth.user ? "/lobby" : "/login";
  return (
    <div className="space-y-10">
      <section className="text-center space-y-4">
        <TwoCups className="w-52 h-auto mx-auto float" />
        <h1 className="text-4xl font-semibold leading-tight">Talk with someone who sees politics differently.</h1>
        <p className="text-lg muted max-w-lg mx-auto">Does it feel like people on the other side have nothing in common with you?</p>
        <p className="text-lg max-w-lg mx-auto">Let&apos;s find out. No names, no debates, no winning.</p>
        <SessionStatus schedule={schedule} serverNow={now} initialSession={sessionState(now, schedule)} href={href} />
      </section>

      <section id="how" className="grid gap-4 sm:grid-cols-2">
        {[
          { t: "You stay anonymous", d: "You appear as a random alias like “Quiet Heron”. Your email is never shown to anyone you talk with.", art: <Lantern className="w-24 h-auto" /> },
          { t: "Different, on purpose", d: "A short questionnaire helps us find someone whose perspectives differ from yours. Your questionnaire answers stay private—we don’t reveal each other’s responses.", art: <Bridge className="w-24 h-auto" /> },
          { t: "Same questions, both of you", d: "Ten shared questions to start. Answers stay hidden until you've both responded. Then open chat, with a new question now and then.", art: <TwoCups className="w-24 h-auto" /> },
          { t: "Checked before delivery", d: "Every message is reviewed before the other person sees it, including for contact details until you both choose to become friends. It adds a short pause, and it isn't perfect.", art: <Sprout className="w-24 h-auto" /> },
        ].map(({ t, d, art }) => (
          <div key={t} className="card flex gap-4 items-start">
            <div className="shrink-0">{art}</div>
            <div>
              <h2 className="font-semibold text-lg">{t}</h2>
              <p className="muted text-sm mt-1">{d}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="card-flat text-sm" style={{ background: "var(--bg-2)" }}>
        <h2 className="font-semibold mb-2">What this is not</h2>
        <ul className="list-disc pl-5 muted space-y-1">
          <li>Not a place to win an argument or change someone&apos;s vote.</li>
          <li>Not perfectly anonymous. We don&apos;t share your identity, but no filter catches everything you might reveal yourself.</li>
          <li>Not for anyone under 18.</li>
        </ul>
      </section>
    </div>
  );
}
