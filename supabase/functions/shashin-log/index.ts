// 写真診断アプリの利用イベントを1行記録する。個人情報・写真・IP・端末情報は保存しない。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVENTS = ["page_view", "photo_selected", "shindan_done", "line_click", "mitsumori_click"];
// shindan_done のときだけ、画面の「どこが気になりますか？」の回答(area)も任意で記録する。
const AREA_VALUES = ["外壁・屋根", "ベランダ・屋上（防水）", "両方", "わからない", "未回答"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const event = String(b?.event ?? "");
  const source = String(b?.source ?? "");
  const session_id = String(b?.session_id ?? "");
  if (!EVENTS.includes(event)) return json({ error: "event" }, 400);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(source)) return json({ error: "source" }, 400);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(session_id)) return json({ error: "session_id" }, 400);
  const areaRaw = b?.area;
  const area = (event === "shindan_done" && typeof areaRaw === "string" && AREA_VALUES.includes(areaRaw)) ? areaRaw : null;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // 重複（同じsession_id×event）は無視して1回だけ記録
  const row: Record<string, unknown> = { event, source, session_id };
  if (area) row.area = area;
  const { error } = await sb.from("shashin_events")
    .upsert(row, { onConflict: "session_id,event", ignoreDuplicates: true });
  if (error) return json({ error: "db" }, 500);
  return json({ ok: true });
});
