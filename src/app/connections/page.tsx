import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Connections } from "./Connections";

export const dynamic = "force-dynamic";

// Chats: ongoing chats (both said "keep talking"), friends-tier chats, and
// recent ended conversations whose reflection / keep-talking decision can
// still be reached (30 days).
export default async function ConnectionsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const [{ data: threads }, { data: recent }] = await Promise.all([supabase.rpc("friend_threads_overview"), supabase.rpc("my_recent_conversations")]);
  return <Connections initialThreads={(threads ?? []) as never} initialRecent={(recent ?? []) as never} />;
}
