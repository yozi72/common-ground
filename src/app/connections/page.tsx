import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Connections } from "./Connections";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data } = await supabase.rpc("my_connections");
  return <Connections initial={(data ?? []) as never} />;
}
