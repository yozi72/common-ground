import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function Nav() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  let isAdmin = false;
  if (data.user) {
    const { data: a } = await supabase.rpc("is_admin");
    isAdmin = !!a;
  }
  return (
    <header className="border-b" style={{ borderColor: "var(--line)" }}>
      <nav aria-label="Main" className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <Link href={data.user ? "/lobby" : "/"} className="font-semibold tracking-tight whitespace-nowrap">Common Ground</Link>
        <ul className="flex items-center gap-0.5 sm:gap-1 text-sm">
          {data.user ? (
            <>
              <li><Link className="btn btn-ghost px-2 sm:px-3" href="/lobby">Talk</Link></li>
              <li><Link className="btn btn-ghost px-2 sm:px-3" href="/connections">Connections</Link></li>
              <li><Link className="btn btn-ghost px-2 sm:px-3" href="/settings">Settings</Link></li>
              {isAdmin && <li><Link className="btn btn-ghost px-2 sm:px-3" href="/admin">Review</Link></li>}
            </>
          ) : (
            <li><Link className="btn btn-primary px-3" href="/login">Sign in</Link></li>
          )}
        </ul>
      </nav>
    </header>
  );
}
