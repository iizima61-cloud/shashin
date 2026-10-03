import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 写真でわかる外壁・防水診断：AI判定の中継役
// ・Geminiのキーはここにだけ置く（画面側には出さない）
// ・判定の指示文もここに置く（画面から好きな指示を送れないようにする）
// ・1日の利用回数に上限をかける（使いすぎ・いたずら防止）

const ALLOWED_ORIGINS = ["https://iizima61-cloud.github.io"];
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "50");   // 全体の1日上限
const PER_IP_LIMIT = Number(Deno.env.get("PER_IP_LIMIT") ?? "10");  // 1人（1回線）あたりの1日上限
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.1-flash-lite";
const MAX_IMAGES = 4;
const MAX_B64 = 2_800_000; // 1枚あたり約2MBまで

const Q1 = ["10年未満", "10〜15年", "15年以上", "わからない・塗ったことがない", "未回答"];
const Q2 = ["付かない", "少し付く", "はっきり付く", "わからない", "未回答"];
const Q3 = ["弾いている", "弾かない・しみ込んでいる", "わからない", "未回答"];
// 「どこが気になりますか？」と、防水の質問5問（w1〜w5）。画面側のフェーズ追加分。
const AREA = ["外壁・屋根", "ベランダ・屋上（防水）", "両方", "わからない", "未回答"];
const W1 = ["5年未満", "5〜10年", "10年以上", "したことがない", "わからない", "未回答"];
const W2 = ["残らない", "残る", "わからない", "未回答"];
const W3 = ["ない", "ある", "わからない", "未回答"];
const W4 = ["詰まっていない", "少したまっている", "詰まっている", "わからない", "未回答"];
const W5 = ["ない", "ある", "わからない", "未回答"];
const MIME = ["image/jpeg", "image/png", "image/webp"];

function cors(origin: string | null) {
  const o = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}
async function sha(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function buildPrompt(
  n: number,
  q1: string, q2: string, q3: string,
  area: string, w1: string, w2: string, w3: string, w4: string, w5: string,
) {
  return `あなたは長野県の防水・塗装専門店（職人歴30年以上）の建物点検員です。お客様がスマホで撮った住宅の写真${n}枚と、質問への回答から、劣化の目安を判定してください。

【写真の順番の目安】1枚目：建物の全体、2枚目：気になる所のアップ、3枚目：気になる所を少し離れて、4枚目：ほかに気になる所（撮られていない枠は送られていません）

【質問への回答】
・前回の塗装：${q1}
・外壁を指でこすると白い粉：${q2}
・雨の後、外壁は水を：${q3}
・気になる場所：${area}
・前回の防水工事（トップコートの塗り替えを含む）：${w1}
・雨のあと、水たまりが半日以上残るか：${w2}
・下の階の天井や壁のシミ・雨漏りの跡：${w3}
・排水口（ドレン）のゴミ詰まり：${w4}
・床のフカフカ・ブカブカ：${w5}

【判定する項目（キー）】
crack=外壁のひび割れ / moss=コケ / mold=カビ / chalking=チョーキング / membrane=ベランダ・屋上の防水層 / drain=排水口（ドレン）まわり / metal_roof=金属屋根（折板・立平・トタンなど） / steel=鉄部（鉄骨・破風・庇・手すり・霧除けなどの塗装された鉄） / kasagi=笠木（金物のさびを含む） / toriai=取り合い（壁と床・壁と屋根などのつなぎ目、防水層の立ち上がり）

【部位の見分け方（最重要）】
・membrane は、人が歩ける平らな面（ベランダの床・屋上・陸屋根）の防水層だけ。傾斜のある屋根（トタン・折板・立平などの金属屋根、瓦、スレート）は membrane にしない。
・トタン・折板・立平など金属の屋根は metal_roof で判定する。金属屋根の塗装の色あせ・剥がれ・さびは metal_roof の中で判定し、ウレタンやFRPの防水とは書かない。
・同じ場所を2つの項目で重ねて判定しない。1つの場所は、最も当てはまる1項目だけにする。

【防水層の種類（membraneのときは必ず type を付ける）】
coating=塗る防水（ウレタン・FRP。継ぎ目のない塗膜、表面に保護塗装）
sheet=シート防水（塩ビシート・ゴムシート。一定幅のシートと直線の継ぎ目が見える）
asphalt=アスファルト防水（表面に砂粒の付いた黒〜灰色のシート、継ぎ目が重なっている）
見分けがつかない場合は coating にせず、見た目が近い方を選ぶ。

【段階】1=今のところ心配ありません / 2=一度、専門家に見てもらうと安心です / 3=早めに専門家へご相談ください
・crack：ヘアクラック程度=1、目立つひび=2、幅のあるひび・複数箇所=3
・moss / mold：わずか=1、広がり始め=2、広範囲=3
・membrane（coating）：色あせ無し=1、色あせあり=2（色あせは必ず2。トップコートの塗り替え時期のため）、トップコートの剥がれ・ひび、膨れ・破れ・めくれ・水たまり=3
・membrane（coating）で、防水層が剥がれて下地のコンクリート・モルタル（灰色でざらついた面）が見えている場合は必ず3にし、\"exposed\":true を付ける。塗る防水は緑・グレーなど色の付いた防水層そのものの場合もあるので、色付きの層が剥がれて灰色の下地が出ていれば exposed とする。reasons には「防水層が剥がれ、下地のコンクリートが見えています」と書く
・membrane（sheet）：傷み無し=1、継ぎ目の汚れのたまり・小さな浮きやしわ=2、継ぎ目の口開き・端部や立ち上がりのめくれ・剥がれ・大きな浮き・破れ=3
・membrane（asphalt）：傷み無し=1、砂落ちの始まり・継ぎ目の軽い傷み=2、継ぎ目の口開き・膨れ・破れ・広範囲の砂落ちや表面劣化=3
・metal_roof：目立つさび無し=1、継ぎ目・ビスまわりのさびの出始め=2、広範囲のさび・塗膜の剥がれ・穴あき・浮き・ビスの抜け=3
・steel：傷み無し=1、塗膜の細かいひび割れ・部分的なさび=2、塗膜の剥がれ・広範囲のさび・さび汁の垂れ=3
・drain：きれい=1、土や落ち葉のたまり始め=2、土砂や草の堆積・水たまり・周辺防水層のめくれ=3
・過去の補修跡（部分的に塗った跡・貼った跡）だけでは2にしない。補修跡のまわりに割れ・剥がれ・すき間など新しい傷みが見える時だけ2以上にする。補修跡があることは reasons に書く（例：「補修した跡が見られますが、まわりに新しい傷みは確認されませんでした」）
・kasagi：汚れ・軽いさび=1、継ぎ目シーリングの割れ・さびの広がり=2、浮き・ぐらつき・継ぎ目のすき間=3
・toriai：大きな傷み無し=1、シーリングのひび・痩せ=2、すき間・剥がれ・防水層立ち上がりのめくれ=3
・chalking：写真ではなく「白い粉」の回答で判定。付かない・わからない・未回答=出さない、少し付く=1、はっきり付く=2、はっきり付く上に写真で色あせ・塗膜の剥がれが見える=3
・雨のあと水たまりが半日以上残るという回答の場合、写真に防水層（membrane）が写っていればそのlevelを2以上にする。防水層が写っていない場合は、水はけの悪さを示すものとして drain のlevelを2以上にしてよい（写っていなくても出してよい）。reasons には「雨の後、水たまりが半日以上残るとのご回答でした」のように回答に基づくことが分かるよう書く。
・排水口に「少したまっている」という回答の場合、写真に写っていなくても drain を level 2 として出してよい。reasons は「排水口にゴミがたまっているとのご回答でした」とする。
・排水口が「詰まっている」という回答の場合、写真に写っていなくても drain を level 3 として出す。reasons は「排水口が詰まっているとのご回答でした」のように回答に基づくことが分かるよう書く。
・床を歩くとフカフカ・ブカブカする所があるという回答の場合、写真に写っていなくても membrane を level 3 として出す（防水層の下に水が回っている可能性があるため）。reasons は「歩くとフカフカする所があるとのご回答でした」とする。type が分からない場合は coating とする。
・下の階の天井や壁のシミ・雨漏りの跡についての回答は、全体の判定（overall）に画面側で反映するため、ここでの項目判定は今までどおり写真で見えるものだけで行う（この回答だけを理由に項目を追加しない）。

【ルール】
・照明・安定器・アンテナ・室外機・配線などの設備そのものは判定しない（設備の取り付け部まわりの外壁や防水の傷みは判定する）。
・写真で実際に見える項目だけを出す（chalkingは回答で判定。上記の水たまり・排水口・床のフカフカに関する回答ベースの判定は例外）。見えない項目は出さない。推測で項目を増やさない。
・判断に迷う、写真がぼやけている・暗い・遠い場合は、1ではなく2にする（安全側）。
・reasons は、その判定の根拠として写真で確認できたことを短い日本語で1〜3個。「〜が確認されました」「〜が一部に見られます」のように、見えたことだけを書く。「〜は確認されませんでした」という否定の文は、levelが1の項目だけに使う（2・3の項目には書かない）。専門用語は「金物（笠木）のさび」のように、どこの何かが分かる言い方にする。年数・費用・工事名の断定は書かない。不安をあおる言葉は使わない。
・写真が住宅・建物の外装やベランダ・屋上でない場合は not_building を true にする。

【出力】JSONだけを返す：
{\"not_building\":false,\"findings\":[{\"item\":\"crack\",\"level\":2,\"reasons\":[\"外壁に細いひびが複数確認されました\"]},{\"item\":\"membrane\",\"type\":\"sheet\",\"level\":3,\"reasons\":[\"シートの継ぎ目に口開きが確認されました\"]}]}`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin" }, 403, origin);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "not_ready" }, 503, origin);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, origin); }
  const images = Array.isArray(body?.images) ? body.images : [];
  if (images.length < 1 || images.length > MAX_IMAGES) return json({ error: "bad_request" }, 400, origin);
  for (const im of images) {
    if (!im || !MIME.includes(im.mime) || typeof im.data !== "string" || im.data.length > MAX_B64) {
      return json({ error: "image_rejected" }, 400, origin);
    }
  }
  const q1 = Q1.includes(body?.q1) ? body.q1 : "未回答";
  const q2 = Q2.includes(body?.q2) ? body.q2 : "未回答";
  const q3 = Q3.includes(body?.q3) ? body.q3 : "未回答";
  const area = AREA.includes(body?.area) ? body.area : "未回答";
  const w1 = W1.includes(body?.w1) ? body.w1 : "未回答";
  const w2 = W2.includes(body?.w2) ? body.w2 : "未回答";
  const w3 = W3.includes(body?.w3) ? body.w3 : "未回答";
  const w4 = W4.includes(body?.w4) ? body.w4 : "未回答";
  const w5 = W5.includes(body?.w5) ? body.w5 : "未回答";

  // 利用回数の上限（止まっていたら安全側で断る）
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const ipKey = "ip:" + (await sha(ip + (Deno.env.get("IP_SALT") ?? "iizima")));
    const total = await sb.rpc("shindan_bump", { p_key: "total" });
    if (total.error) throw total.error;
    if (total.data > DAILY_LIMIT) return json({ error: "busy" }, 429, origin);
    const mine = await sb.rpc("shindan_bump", { p_key: ipKey });
    if (mine.error) throw mine.error;
    if (mine.data > PER_IP_LIMIT) return json({ error: "limit" }, 429, origin);
  } catch (_e) {
    return json({ error: "busy" }, 503, origin);
  }

  const parts: any[] = [{ text: buildPrompt(images.length, q1, q2, q3, area, w1, w2, w3, w4, w5) }];
  for (const im of images) parts.push({ inline_data: { mime_type: im.mime, data: im.data } });

  let r: Response;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
  } catch {
    return json({ error: "upstream" }, 502, origin);
  }
  if (!r.ok) return json({ error: "upstream", status: r.status }, 502, origin);
  const data = await r.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  let result: any;
  try {
    const t = text.replace(/```json|```/g, "").trim();
    result = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    return json({ error: "invalid_json" }, 502, origin);
  }
  // 写真はどこにも保存しない（この関数は受け取って判定に使うだけ）
  return json(result, 200, origin);
});
