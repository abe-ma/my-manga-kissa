// 登録していない作品の「新連載の第1話」と「読切」を、サイト全体のフィードとトップページから見つける
import { XMLParser } from "fast-xml-parser";

export type Found = {
  key: string; // 話のURL。既読管理に使う
  kind: "new" | "oneshot";
  site: string;
  series: string;
  title: string;
  url: string;
};

const SITES = [
  { site: "ジャンプ+", rss: "https://shonenjumpplus.com/rss", top: "https://shonenjumpplus.com/" },
  { site: "サンデーうぇぶり", rss: "https://www.sunday-webry.com/rss", top: "https://www.sunday-webry.com/" },
  { site: "となりのYJ", rss: "https://tonarinoyj.jp/rss", top: "https://tonarinoyj.jp/" },
];

const UA = { "User-Agent": "my-manga-kissa/0.1 (personal use)" };
const FIRST_EPISODE = /(?<![0-9\-－.])第?1話/; // 「第1話」「[1話＋2話]」。「11話」「第18-1話」「第1.5話」は除く
const ONESHOT_TITLE = /読切|読み切り/;

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").trim();

// トップページの「読切」バッジ付きの話。ジャンプ+・サンデーうぇぶりで同じ形のバッジが使われている
export function oneshotsFromTop(html: string): { url: string; title: string }[] {
  const found = new Map<string, string>();
  for (const m of html.matchAll(/<a href="(https:\/\/[^"]*\/episode\/\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const block = m[2];
    if (!/series-badge[^>]*>\s*(?:<span>)?\s*読切/.test(block)) continue;
    const title = block.match(/(?:daily-series-title|<h4)[^>]*>\s*(?:<span>)?\s*([^<]+)/)?.[1];
    if (title && !found.has(m[1])) found.set(m[1], decode(title));
  }
  return [...found].map(([url, title]) => ({ url, title }));
}

async function discoverSite(s: (typeof SITES)[number]): Promise<Found[]> {
  const found = new Map<string, Found>();

  // 読切: トップページのバッジ、またはフィードのタイトル
  const top = await get(s.top).then(oneshotsFromTop, (e) => {
    console.error(`discover: top page failed (${s.site})`, e);
    return [];
  });
  for (const o of top) found.set(o.url, { key: o.url, kind: "oneshot", site: s.site, series: o.title, title: o.title, url: o.url });

  const xml = new XMLParser().parse(await get(s.rss));
  for (const i of [xml.rss.channel.item ?? []].flat() as Record<string, unknown>[]) {
    const url = String(i.link);
    if (found.has(url)) continue;
    const title = String(i.title);
    const series = String(i.description);
    const kind = ONESHOT_TITLE.test(title) ? "oneshot" : FIRST_EPISODE.test(title) ? "new" : null;
    if (kind) found.set(url, { key: url, kind, site: s.site, series, title, url });
  }
  return [...found.values()];
}

export async function discover(): Promise<{ found: Found[]; failed: string[] }> {
  const results = await Promise.allSettled(SITES.map(discoverSite));
  const found: Found[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") found.push(...r.value);
    else {
      console.error(`discover failed (${SITES[i].site})`, r.reason);
      failed.push(SITES[i].site);
    }
  });
  return { found, failed };
}
