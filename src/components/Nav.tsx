import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TabBar } from "./TabBar";

// Top bar on every screen; on phones the section links move into a bottom
// tab bar (TabBar) so Talk / Friends / Profile are always one tap away.
export async function Nav() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  let isAdmin = false;
  if (data.user) {
    const { data: a } = await supabase.rpc("is_admin");
    isAdmin = !!a;
  }
  return (
    <>
      <header>
        <nav aria-label="Main" className="max-w-2xl mx-auto px-4 h-16 flex items-center justify-between gap-2">
          <Link href={data.user ? "/lobby" : "/"} className="flex items-center gap-2 font-semibold whitespace-nowrap" style={{ fontFamily: "var(--font-display)" }}>
            <span aria-hidden="true" className="inline-block w-7 h-7 rounded-full" style={{ background: "linear-gradient(135deg, var(--accent) 50%, var(--sage) 50%)" }} />
            Common Ground
          </Link>
          <ul className="flex items-center gap-1 text-sm">
            {data.user ? (
              <>
                <li className="hidden sm:block"><Link className="btn btn-ghost px-3 py-2 min-h-0" href="/lobby">Talk</Link></li>
                <li className="hidden sm:block"><Link className="btn btn-ghost px-3 py-2 min-h-0" href="/connections">Friends</Link></li>
                <li className="hidden sm:block"><Link className="btn btn-ghost px-3 py-2 min-h-0" href="/settings">Profile</Link></li>
                {isAdmin && <li><Link className="btn btn-ghost px-3 py-2 min-h-0" href="/admin">Review</Link></li>}
                <li>
                  <form action="/auth/signout" method="post">
                    <button className="btn btn-secondary px-3 py-1.5 min-h-0 text-sm">Sign out</button>
                  </form>
                </li>
              </>
            ) : (
              <li><Link className="btn btn-primary px-4 py-2 min-h-0" href="/login">Sign in</Link></li>
            )}
          </ul>
        </nav>
      </header>
      {data.user && <TabBar />}
    </>
  );
}
