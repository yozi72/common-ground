"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Server-synchronised clock: `now()` returns the estimated server time.
// The offset is re-measured whenever the caller passes a fresh server timestamp
// (from any API response) and when the tab regains focus.
export function useServerClock(initialServerNow: number) {
  const offset = useRef<number | null>(null);
  const [tick, setTick] = useState(0);
  const sync = useCallback((serverNow: number) => { offset.current = serverNow - Date.now(); }, []);
  // offset is measured lazily on first use (outside render of the initial value)
  const now = useCallback(() => { if (offset.current === null) offset.current = initialServerNow - Date.now(); return Date.now() + offset.current; }, [initialServerNow]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    const onVisible = () => { if (document.visibilityState === "visible") setTick((x) => x + 1); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, []);
  return { now, sync, tick };
}
