"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Live total of unread friend messages for the signed-in person. Starts from
// the server-rendered value and refreshes when a notification arrives, when a
// chat marks itself read (window event "cg:unread-changed"), when the tab
// regains focus, and every 30 s as a fallback.
export const UNREAD_CHANGED = "cg:unread-changed";

export function useUnreadTotal(initial: number) {
  const [unread, setUnread] = useState(initial);
  useEffect(() => {
    let alive = true;
    const sb = supabaseBrowser();
    const refresh = async () => {
      const { data } = await sb.rpc("friend_unread_total");
      if (alive && typeof data === "number") setUnread(data);
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    // one channel per hook instance: the shared client returns an existing channel by name, and a
    // subscribed channel refuses new callbacks (the tab bar and the desktop link both use this hook)
    const ch = sb.channel(`unread-total-${crypto.randomUUID()}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, refresh).subscribe();
    const t = setInterval(refresh, 30_000);
    window.addEventListener(UNREAD_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      alive = false; clearInterval(t); sb.removeChannel(ch);
      window.removeEventListener(UNREAD_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initial]);
  return unread;
}
