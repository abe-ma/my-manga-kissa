import { readFile, writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { discover } from "./discover.js";
import type { ViewData, ViewEpisode, ViewFound } from "./view.js";

// kind 省略時は RSS。"rookie" はジャンプルーキー、"comici" はヤングアニマルWebの作品ページを読む
type Series = { name: string; feed: string; kind?: "rookie" | "comici" };
// tag は新連載・読切(登録していない作品の通知)のとき。guid はその話のURL
type Episode = { guid: string; series: string; title: string; url: string; date?: string; tag?: string };
type State = { feeds: Record<string, string[]>; discovery?: string[] };

const STATE_PATH = new URL("../state/seen.json", import.meta.url);
const VIEW_PATH = new URL("../state/episodes.json", import.meta.url);
const CONFIG_PATH = new URL("../config/series.json", import.meta.url);
const MAX_SEEN_PER_FEED = 200;
const DIGEST_CHUNK = 20;
const VIEW_EPISODES = 5;
const MAX_DISCOVERY = 2000;
const VIEW_FOUND = 30;
const TAG_LABEL = { new: "新連載", oneshot: "読切" } as const;

const UA = { "User-Agent": "my-manga-kissa/0.1 (personal use)" };

async function fetchRss(s: Series): Promise<Episode[]> {
  const res = await fetch(s.feed, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = new XMLParser().parse(await res.text());
  const items = [xml.rss.channel.item ?? []].flat();
  return items.map((i: Record<string, unknown>) => ({
    guid: String(i.guid),
    series: s.name,
    title: String(i.title),
    url: String(i.link),
    date: i.pubDate ? new Date(String(i.pubDate)).toISOString() : undefined,
  }));
}

// ジャンプルーキーはRSSが無いので、作品ページの話一覧を読む
async function fetchRookie(s: Series): Promise<Episode[]> {
  const res = await fetch(s.feed, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const origin = new URL(s.feed).origin;
  const episodes = [
    ...html.matchAll(
      /data-episode-id="(\d+)"[\s\S]*?<a class="episode-content" href="([^"]+)"[\s\S]*?class="episode-title">([^<]*)</g,
    ),
  ].map((m) => ({ guid: m[1], series: s.name, title: m[3].replace(/\s+/g, " ").trim(), url: origin + m[2] }));
  episodes.reverse(); // ページは古い順なので、RSSと同じ新しい順にそろえる
  // 0件はページ構造の変更を疑い、「新着なし」と区別するためエラーにする
  if (episodes.length === 0) throw new Error("no episodes found (page layout changed?)");
  return episodes;
}

// ヤングアニマルWeb(Next.js)はRSSが無いので、作品ページに埋め込まれた最新5話のデータを読む
async function fetchComici(s: Series): Promise<Episode[]> {
  const res = await fetch(s.feed, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const origin = new URL(s.feed).origin;
  const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => JSON.parse(m[1]) as string).join("");
  const start = payload.indexOf('"tailEpisodes":[');
  if (start < 0) throw new Error("tailEpisodes not found (page layout changed?)");
  const arr = extractJsonArray(payload, start + '"tailEpisodes":'.length);
  const episodes = (arr as unknown[])
    .filter((e): e is { id: string; title: string; datePublished: number } => typeof e === "object" && e !== null)
    .map((e) => ({
      guid: e.id,
      series: s.name,
      title: e.title,
      url: `${origin}/episodes/${e.id}`,
      date: new Date(e.datePublished * 1000).toISOString(),
    }));
  if (episodes.length === 0) throw new Error("no episodes found (page layout changed?)");
  return episodes.reverse(); // 古い順なので、新しい順にそろえる
}

// text[start] の "[" から対応する "]" までをJSONとして読む(文字列中の括弧は数えない)
function extractJsonArray(text: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated array");
}

const fetchEpisodes = (s: Series) =>
  s.kind === "rookie" ? fetchRookie(s) : s.kind === "comici" ? fetchComici(s) : fetchRss(s);

// Markdownのリンク文字列に [ ] があると壊れるので、全角にする
const mdText = (t: string) => t.replace(/\[/g, "［").replace(/\]/g, "］");

async function notifyDigest(eps: Episode[]): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC is not set");
  const server = process.env.NTFY_SERVER ?? "https://ntfy.sh";
  const res = await fetch(server, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      title: eps.length === 1 ? eps[0].series : `新着 ${eps.length}話`,
      message: eps
        .map((e) => `- ${e.tag ? `【${e.tag}】` : ""}[${mdText(e.title.includes(e.series) ? e.title : `${e.series} ${e.title}`)}](${e.url})`)
        .join("\n"),
      markdown: true,
      click: eps.length === 1 ? eps[0].url : undefined,
      tags: ["books"],
    }),
  });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
}

async function main() {
  const series: Series[] = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const state: State = JSON.parse(await readFile(STATE_PATH, "utf8"));

  const pending: Episode[] = [];
  const nextFeeds: Record<string, string[]> = {};
  const failed: string[] = [];
  const prevView: ViewData = await readFile(VIEW_PATH, "utf8").then(JSON.parse, () => ({ series: {} }));
  const now = new Date().toISOString();
  const view: ViewData = { updatedAt: now, series: {} };

  for (const s of series) {
    const known = state.feeds[s.feed];
    // 取得失敗でも既存の既読状態は保持する
    nextFeeds[s.feed] = known ?? [];
    let episodes: Episode[];
    try {
      episodes = await fetchEpisodes(s);
    } catch (e) {
      console.error(`fetch failed: ${s.name}`, e);
      failed.push(s.name);
      continue;
    }
    const guids = episodes.map((e) => e.guid);
    const prevEps = new Map(prevView.series[s.feed]?.episodes.map((e) => [e.guid, e]));
    view.series[s.feed] = {
      name: s.name,
      episodes: episodes.slice(0, VIEW_EPISODES).map((e): ViewEpisode => ({
        guid: e.guid,
        title: e.title,
        url: e.url,
        date: e.date ?? null,
        // 既読済みの話は、いつ見つけたか分からないので null にする(新着だけ現在時刻)
        firstSeen: prevEps.get(e.guid)?.firstSeen ?? (known && !known.includes(e.guid) ? now : null),
      })),
    };
    if (!known) {
      // 新規に追加した作品は、既存の話を通知せず登録だけする
      nextFeeds[s.feed] = guids;
      console.log(`seeded: ${s.name} (${guids.length})`);
      continue;
    }
    const seen = new Set(known);
    pending.push(...episodes.filter((e) => !seen.has(e.guid)));
  }

  // 登録していない作品の新連載・読切。初回(既読リストが無いとき)は通知せず登録だけする
  const watched = new Set(series.map((s) => s.name));
  const { found, failed: discoverFailed } = await discover();
  const nextDiscovery = [...(state.discovery ?? [])];
  const knownKeys = new Set(nextDiscovery);
  const freshFound = found.filter((f) => !knownKeys.has(f.key));
  const seedingDiscovery = !state.discovery;
  const viewFound: ViewFound[] = freshFound.map((f) => ({ ...f, firstSeen: seedingDiscovery ? null : now }));
  if (seedingDiscovery) {
    nextDiscovery.push(...freshFound.map((f) => f.key));
    console.log(`seeded discovery: ${freshFound.length}`);
  } else {
    for (const f of freshFound) {
      // 登録済みの作品の話は、作品ごとの通知で届くので除く
      if (f.kind === "new" && watched.has(f.series)) nextDiscovery.push(f.key);
      else pending.push({ guid: f.key, series: f.series, title: f.title, url: f.url, tag: TAG_LABEL[f.kind] });
    }
  }
  const shown = viewFound.filter((f) => !(f.kind === "new" && watched.has(f.series)));
  const shownKeys = new Set(shown.map((f) => f.key));
  view.found = [...shown, ...(prevView.found ?? []).filter((f) => !shownKeys.has(f.key))].slice(0, VIEW_FOUND);

  // 通知に失敗した話は既読にせず、次回に再試行する
  const feedOf = new Map(series.map((s) => [s.name, s.feed]));
  for (let i = 0; i < pending.length; i += DIGEST_CHUNK) {
    const chunk = pending.slice(i, i + DIGEST_CHUNK);
    try {
      await notifyDigest(chunk);
      console.log(`notified: ${chunk.length} episodes`);
    } catch (e) {
      console.error(`notify failed (${chunk.length} episodes)`, e);
      continue;
    }
    for (const ep of chunk) (ep.tag ? nextDiscovery : nextFeeds[feedOf.get(ep.series)!]).push(ep.guid);
  }
  for (const feed of Object.keys(nextFeeds)) nextFeeds[feed] = nextFeeds[feed].slice(-MAX_SEEN_PER_FEED);

  // 取得に失敗した作品は、前回の表示データを残す
  for (const s of series) view.series[s.feed] ??= prevView.series[s.feed];
  await writeFile(VIEW_PATH, JSON.stringify(view, null, 1) + "\n");
  await writeFile(STATE_PATH, JSON.stringify({ feeds: nextFeeds, discovery: nextDiscovery.slice(-MAX_DISCOVERY) }, null, 1) + "\n");
  if (failed.length || discoverFailed.length) console.error(`failed: ${[...failed, ...discoverFailed].join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
