import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ViewData, ViewEpisode, ViewFound } from "./view.js";

type Series = { name: string; feed: string };

const SITE_LABELS: Record<string, string> = {
  "shonenjumpplus.com": "ジャンプ+",
  "tonarinoyj.jp": "となりのYJ",
  "www.sunday-webry.com": "サンデーうぇぶり",
  "comic-days.com": "コミックDAYS",
  "mgpk-cdn.magazinepocket.com": "マガポケ",
  "pocket.shonenmagazine.com": "マガポケ",
  "rookie.shonenjump.com": "ジャンプルーキー",
  "younganimal.com": "ヤングアニマルWeb",
};
const NEW_WITHIN_MS = 3 * 24 * 3600 * 1000;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jst = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...opts }).format(new Date(iso));

// 公開日があればそれを、なければ初めて見つけた時刻を「更新日時」とみなす
const stamp = (e: ViewEpisode) => e.date ?? e.firstSeen;

function card(name: string, site: string, eps: ViewEpisode[], now: number): string {
  const [latest, ...older] = eps;
  const at = latest && stamp(latest);
  const isNew = at ? now - Date.parse(at) < NEW_WITHIN_MS : false;
  const li = (e: ViewEpisode) => {
    const t = stamp(e);
    return `<li><a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a><time>${t ? jst(t, { month: "numeric", day: "numeric" }) : ""}</time></li>`;
  };
  return `<article class="card" data-site="${esc(site)}">
  <div class="meta"><span class="site">${esc(site)}</span>${isNew ? '<span class="new">NEW</span>' : ""}</div>
  <h2>${esc(name)}</h2>
  ${
    latest
      ? `<a class="latest" href="${esc(latest.url)}" rel="noopener"><span>${esc(latest.title)}</span><time>${at ? jst(at, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "日付不明"}</time></a>`
      : '<p class="empty">まだ取得できていません</p>'
  }
  ${older.length ? `<details><summary>過去の話</summary><ul>${older.map(li).join("")}</ul></details>` : ""}
</article>`;
}

const KIND_LABEL = { new: "新連載", oneshot: "読切" } as const;

function foundSection(found: ViewFound[], now: number): string {
  if (!found.length) return "";
  const row = (f: ViewFound) => {
    const isNew = f.firstSeen ? now - Date.parse(f.firstSeen) < NEW_WITHIN_MS : false;
    return `<li><span class="kind ${f.kind}">${KIND_LABEL[f.kind]}</span><a href="${esc(f.url)}" rel="noopener">${esc(f.title)}</a>${isNew ? '<span class="new">NEW</span>' : ""}<span class="site">${esc(f.site)}</span></li>`;
  };
  return `<section class="found"><details open><summary>新連載・読切 <small>(${found.length})</small></summary><ul>${found.map(row).join("")}</ul></details></section>`;
}

async function main() {
  const series: Series[] = JSON.parse(await readFile(new URL("../config/series.json", import.meta.url), "utf8"));
  const view: ViewData = await readFile(new URL("../state/episodes.json", import.meta.url), "utf8").then(JSON.parse, () => ({
    series: {},
  }));
  const now = Date.now();

  const rows = series.map((s, order) => {
    const eps = view.series[s.feed]?.episodes ?? [];
    const site = SITE_LABELS[new URL(s.feed).host] ?? new URL(s.feed).host;
    const at = eps[0] && stamp(eps[0]);
    return { s, eps, site, order, time: at ? Date.parse(at) : -Infinity };
  });
  // 更新が新しい順。日時が不明な作品は設定ファイルの順で最後に並べる
  rows.sort((a, b) => b.time - a.time || a.order - b.order);

  const sites = [...new Set(rows.map((r) => r.site))];
  const updated = view.updatedAt ? jst(view.updatedAt, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-";

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>マンガ喫茶</title>
<style>
:root{--bg:#faf7f2;--card:#fff;--text:#2a2420;--sub:#7a6f66;--line:#e8e0d6;--accent:#b4532a;--new:#fff;--newbg:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#171412;--card:#221e1b;--text:#efe8e0;--sub:#a39888;--line:#3a332d;--accent:#e2905f;--newbg:#ea580c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 56px}
header h1{margin:0;font-size:24px;letter-spacing:.04em}
header p{margin:4px 0 0;color:var(--sub);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}
.chips button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.chips button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.chips button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.card[hidden]{display:none}
.meta{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--sub)}
.new{background:var(--newbg);color:var(--new);font-weight:700;padding:0 8px;border-radius:999px;font-size:11px;letter-spacing:.06em}
h2{margin:2px 0 8px;font-size:17px;line-height:1.4}
.latest{display:flex;justify-content:space-between;gap:12px;color:var(--accent);text-decoration:none;font-size:15px}
.latest:hover span{text-decoration:underline}
time{color:var(--sub);font-size:12px;white-space:nowrap;flex:none}
details{margin-top:8px;font-size:14px}
summary{cursor:pointer;color:var(--sub);font-size:13px}
ul{list-style:none;margin:6px 0 0;padding:0}
li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-top:1px solid var(--line)}
li a{color:var(--text);text-decoration:none}
li a:hover{text-decoration:underline}
.empty{margin:0;color:var(--sub);font-size:14px}
.found{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:12px}
.found summary{font-weight:600;color:var(--text);font-size:15px}
.found li{align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px}
.found li a{flex:1 1 12em;min-width:0}
.found .site{color:var(--sub);font-size:12px}
.kind{font-size:11px;font-weight:700;padding:0 8px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);white-space:nowrap}
.kind.oneshot{border-color:var(--sub);color:var(--sub)}
</style>
</head>
<body>
<main>
<header><h1>マンガ喫茶</h1><p>${rows.length}作品 · 更新 ${esc(updated)}</p></header>
<div class="chips" role="group" aria-label="サイトで絞り込み">
<button type="button" aria-pressed="true" data-filter="">すべて</button>
${sites.map((x) => `<button type="button" aria-pressed="false" data-filter="${esc(x)}">${esc(x)}</button>`).join("\n")}
</div>
${foundSection(view.found ?? [], now)}
${rows.map((r) => card(r.s.name, r.site, r.eps, now)).join("\n")}
</main>
<script>
const chips=[...document.querySelectorAll(".chips button")],cards=[...document.querySelectorAll(".card")];
chips.forEach(b=>b.addEventListener("click",()=>{
  chips.forEach(c=>c.setAttribute("aria-pressed",String(c===b)));
  cards.forEach(c=>{c.hidden=!!b.dataset.filter&&c.dataset.site!==b.dataset.filter});
}));
</script>
</body>
</html>
`;
  await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
  await writeFile(new URL("../dist/index.html", import.meta.url), html);
  console.log(`built dist/index.html (${rows.length} series)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
