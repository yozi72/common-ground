"use client";
import { useEffect, useState } from "react";
import { deviceTimeZone } from "@/lib/push-client";

const COMMON = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];

export function TimezoneSetting({ override }: { override: string | null }) {
  const [device, setDevice] = useState<string | null>(null);
  const [value, setValue] = useState<string>(override ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDevice(deviceTimeZone()), 0); return () => clearTimeout(t); }, []);

  async function save(tz: string) {
    setMsg(null);
    const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "timezone", timezone: tz || null }) });
    if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error ?? "Couldn't save"); return; }
    setValue(tz);
    setMsg(tz ? `Times will show in ${tz.replace(/_/g, " ")}.` : "Using your device's timezone.");
  }

  const options = Array.from(new Set([...(device ? [device] : []), ...COMMON, ...(override ? [override] : [])]));
  return (
    <section id="timezone" className="card space-y-2 text-sm">
      <h2 className="font-semibold">Timezone</h2>
      <p className="muted">Session times are shown in your device&apos;s timezone{device ? ` (${device.replace(/_/g, " ")})` : ""}. The session itself is one shared hour anchored to Pacific time. Set an override only if your device is wrong.</p>
      <label className="block" htmlFor="tz">Show times in</label>
      <select id="tz" className="field" value={value} onChange={(e) => save(e.target.value)}>
        <option value="">Device timezone{device ? ` — ${device.replace(/_/g, " ")}` : ""}</option>
        {options.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
      </select>
      {msg && <p className="notice notice-ok" role="status">{msg}</p>}
    </section>
  );
}
