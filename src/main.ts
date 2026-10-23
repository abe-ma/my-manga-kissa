import { readFile, writeFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

// kind 省略時は RSS。"rookie" はジャンプルーキーの作品ページ(HTML)を読む
type Series = { name: string; feed: string; kind?: "rookie" };
type Episode = { guid: string; series: string; title: string; url: string };
type State = { feeds: Record<string, string[]> };

const STATE_PATH = new URL("../state/seen.json", import.meta.url);
const CONFIG_PATH = new URL("../config/series.json", import.meta.url);
const MAX_SEEN_PER_FEED = 200;
const DIGEST_CHUNK = 20;

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
  // 0件はページ構造の変更を疑い、「新着なし」と区別するためエラーにする
  if (episodes.length === 0) throw new Error("no episodes found (page layout changed?)");
  return episodes;
}

const fetchEpisodes = (s: Series) => (s.kind === "rookie" ? fetchRookie(s) : fetchRss(s));

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
      message: eps.map((e) => `- [${e.title.includes(e.series) ? e.title : `${e.series} ${e.title}`}](${e.url})`).join("\n"),
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
    if (!known) {
      // 新規に追加した作品は、既存の話を通知せず登録だけする
      nextFeeds[s.feed] = guids;
      console.log(`seeded: ${s.name} (${guids.length})`);
      continue;
    }
    const seen = new Set(known);
    pending.push(...episodes.filter((e) => !seen.has(e.guid)));
  }

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
    for (const ep of chunk) nextFeeds[feedOf.get(ep.series)!].push(ep.guid);
  }
  for (const feed of Object.keys(nextFeeds)) nextFeeds[feed] = nextFeeds[feed].slice(-MAX_SEEN_PER_FEED);

  await writeFile(STATE_PATH, JSON.stringify({ feeds: nextFeeds }, null, 1) + "\n");
  if (failed.length) console.error(`failed feeds: ${failed.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
