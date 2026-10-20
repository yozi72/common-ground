import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DeleteAccount } from "./DeleteAccount";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("age_band, region, community, life_context, share_context_with_prompts, political_answers").eq("account_id", auth.user.id).maybeSingle();
  const answered = profile ? Object.keys(profile.political_answers ?? {}).length : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">Profile</h1>
      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">Your account</h2>
        <p className="muted">Signed in as {auth.user.email}. This is never shown to other participants.</p>
        <form action="/auth/signout" method="post"><button className="btn btn-secondary">Sign out</button></form>
      </section>
      <section className="card space-y-2 text-sm">
        <h2 className="font-semibold">About you</h2>
        <p className="muted">Age {profile?.age_band ?? "—"} · {profile?.region ?? "—"} · {profile?.community ?? "—"} · {profile?.life_context?.length ? profile.life_context.join(", ") : "no life context"}</p>
        <p className="muted">Matching questionnaire: {answered} of 5 answered. Context sharing for questions: {profile?.share_context_with_prompts ? "on" : "off"}.</p>
        <a className="btn btn-secondary" href="/onboarding">Edit</a>
      </section>
      <DeleteAccount />
    </div>
  );
}
