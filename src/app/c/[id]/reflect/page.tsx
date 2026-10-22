import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Reflect } from "./Reflect";
import { reflectConnection, type RecentRow } from "@/lib/connection-state";

export const dynamic = "force-dynamic";

export default async function ReflectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data: conv } = await supabase.from("conversations").select("id, status, end_reason, questions_asked").eq("id", id).maybeSingle();
  if (!conv) notFound();
  if (conv.status !== "ended") redirect(`/c/${id}`);
  const { data: me } = await supabase.from("participants").select("id").eq("conversation_id", id).eq("account_id", auth.user.id).maybeSingle();
  if (!me) notFound();
  const [{ data: aliases }, { data: reflection }, { data: decision }, { data: cfg }, { data: recent }] = await Promise.all([
    supabase.from("participant_aliases").select("participant_id, alias").eq("conversation_id", id),
    supabase.from("session_reflections").select("felt_understood, recognized_shared, would_repeat, free_text").eq("conversation_id", id).eq("participant_id", me.id).maybeSingle(),
    supabase.from("connection_requests").select("decision").eq("conversation_id", id).eq("participant_id", me.id).maybeSingle(),
    supabase.from("policy_config").select("value").eq("key", "friendship_enabled").maybeSingle(),
    supabase.rpc("my_recent_conversations"),
  ]);
  // the actual connection state: an active chat with this person (from this conversation, or an
  // earlier one when this was a rematch), not just my own decision
  const mine = ((recent ?? []) as RecentRow[]).find((r) => r.conversation_id === id);
  const connection = reflectConnection(mine);
  const peerAlias = aliases?.find((a) => a.participant_id !== me.id)?.alias ?? "your partner";
  return (
    <Reflect conversationId={id} peerAlias={peerAlias} endReason={conv.end_reason} questionsAsked={conv.questions_asked}
      initialReflection={reflection ?? null} initialDecision={decision?.decision ?? null} friendshipEnabled={cfg?.value !== false} initialConnection={connection} />
  );
}
