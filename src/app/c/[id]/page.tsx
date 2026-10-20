import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Conversation } from "./Conversation";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  // RLS: these return nothing unless the signed-in user is a participant.
  const { data: conv } = await supabase.from("conversations").select("*").eq("id", id).maybeSingle();
  if (!conv) notFound();
  const { data: me } = await supabase.from("participants").select("id, left_at").eq("conversation_id", id).eq("account_id", auth.user.id).maybeSingle();
  if (!me) notFound();
  const { data: aliases } = await supabase.from("participant_aliases").select("participant_id, alias").eq("conversation_id", id);
  const myAlias = aliases?.find((a) => a.participant_id === me.id)?.alias ?? "You";
  const peerAlias = aliases?.find((a) => a.participant_id !== me.id)?.alias ?? "Your partner";

  if (conv.status === "ended") redirect(`/c/${id}/reflect`);

  return <Conversation conversationId={id} myParticipantId={me.id} myAlias={myAlias} peerAlias={peerAlias} />;
}
