import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

// Magic-link landing. Exchanges the code for a session, promotes the configured
// admin email on first sign-in, and sends new users to onboarding.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = url.searchParams.get("next") ?? "/lobby";
  const supabase = await createSupabaseServerClient();

  let userId: string | null = null;
  let email: string | null = null;
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, env.siteUrl()));
    userId = data.user?.id ?? null; email = data.user?.email ?? null;
  } else if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as "magiclink" | "email" });
    if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, env.siteUrl()));
    userId = data.user?.id ?? null; email = data.user?.email ?? null;
  } else {
    return NextResponse.redirect(new URL("/login?error=missing_code", env.siteUrl()));
  }

  if (userId && email && env.adminEmail() && email.toLowerCase() === env.adminEmail()) {
    await supabaseAdmin().from("accounts").update({ role: "admin" }).eq("id", userId);
  }

  const { data: account } = await supabase.from("accounts").select("onboarding_complete, role").eq("id", userId!).maybeSingle();
  // Reviewers go straight to the console; they can set up participation later from Talk.
  const dest = account?.onboarding_complete ? next : account?.role === "admin" ? "/admin" : "/onboarding";
  return NextResponse.redirect(new URL(dest, env.siteUrl()));
}
