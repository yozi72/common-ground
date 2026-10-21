"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/lobby", label: "Talk", match: (p: string) => p.startsWith("/lobby") || p.startsWith("/c/") },
  { href: "/connections", label: "Friends", match: (p: string) => p.startsWith("/connections") },
  { href: "/settings", label: "Profile", match: (p: string) => p.startsWith("/settings") || p.startsWith("/onboarding") },
];

function Icon({ name, active }: { name: string; active: boolean }) {
  const stroke = active ? "var(--accent)" : "var(--muted)";
  if (name === "Talk") return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4 4v-4a3 3 0 0 1-1-2.2V6z" stroke={stroke} strokeWidth="2" fill={active ? "var(--accent-2)" : "none"} />
    </svg>
  );
  if (name === "Friends") return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" stroke={stroke} strokeWidth="2" fill={active ? "var(--accent-2)" : "none"} />
      <circle cx="16.5" cy="9.5" r="2.5" stroke={stroke} strokeWidth="2" />
      <path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6M14.5 15.5c2.5 0 4.5 1.8 4.5 4" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
  if (name === "Review") return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke={stroke} strokeWidth="2" fill={active ? "var(--accent-2)" : "none"} />
      <path d="M9 12l2 2 4-4" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="4" stroke={stroke} strokeWidth="2" fill={active ? "var(--accent-2)" : "none"} />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TabBar({ isAdmin = false, unread = 0 }: { isAdmin?: boolean; unread?: number }) {
  const path = usePathname();
  const tabs = isAdmin ? [...TABS, { href: "/admin", label: "Review", match: (p: string) => p.startsWith("/admin") }] : TABS;
  return (
    <nav aria-label="Sections" className="sm:hidden fixed bottom-0 inset-x-0 z-20" style={{ background: "var(--card)", borderTop: "1px solid var(--line)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const active = t.match(path);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined} className="flex flex-col items-center gap-0.5 py-2 text-xs font-semibold" style={{ color: active ? "var(--accent)" : "var(--muted)" }}>
                <span className="relative">
                  <Icon name={t.label} active={active} />
                  {t.label === "Friends" && unread > 0 && <span className="count absolute -top-1 -right-3" aria-label={`${unread} unread`}>{unread}</span>}
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
