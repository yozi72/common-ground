"use client";
import Link from "next/link";
import { useUnreadTotal } from "./useUnread";

// Desktop "Chats" link with a live unread badge (the phone tab bar has its own).
export function FriendsLink({ unread: initial }: { unread: number }) {
  const unread = useUnreadTotal(initial);
  return (
    <Link className="btn btn-ghost px-3 py-2 min-h-0" href="/connections">
      Chats{unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
    </Link>
  );
}
