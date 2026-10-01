// 件数の集計だけを返す（個別の行は返さない）。?key= に STATS_KEY が必要。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// 日本時間の「今日の0時」
function jstStartOfToday(): Date {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600 * 1000);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const need = Deno.env.get("STATS_KEY") ?? "";
  const got = new URL(req.url).searchParams.get("key") ?? "";
  if (!need || !safeEqual(need, got)) return json({ error: "forbidden" }, 403);

  const today = jstStartOfToday();
  const day = 24 * 3600 * 1000;
  const periods: Record<string, Date | null> = {
    today: today,
    d7: new Date(today.getTime() - 6 * day),
    d30: new Date(today.getTime() - 29 * day),
    all: null,
  };
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const [name, since] of Object.entries(periods)) {
    const { data, error } = await sb.rpc("shashin_event_counts", { since: since ? since.toISOString() : null });
    if (error) return json({ error: "db" }, 500);
    const bySource: Record<string, Record<string, number>> = {};
    for (const r of data ?? []) (bySource[r.source] ??= {})[r.event] = Number(r.n);
    out[name] = bySource;
  }
  return json({ periods: out });
});
