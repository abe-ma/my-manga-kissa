// 使い方: npx tsx scripts/find-series.ts <host> <検索語> ...
// 検索結果の話ページから、作品名とRSS(作品別)のURLを探して表示する
const UA = { "User-Agent": "my-manga-kissa/0.1 (personal use)" };
const [host, ...queries] = process.argv.slice(2);

const text = async (url: string) => (await fetch(url, { headers: UA })).text();
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

for (const q of queries) {
  const html = await text(`https://${host}/search?q=${encodeURIComponent(q)}`);
  const eps = [...new Set([...html.matchAll(/href="(https:\/\/[^"]*\/episode\/\d+)"/g)].map((m) => m[1]))].slice(0, 8);
  const seen = new Map<string, string>();
  for (const url of eps) {
    const page = await text(url);
    const rss = page.match(/type="application\/rss\+xml" title="RSS2.0" href="([^"]+)"/)?.[1];
    if (!rss || seen.has(rss)) continue;
    const feed = await text(decode(rss));
    seen.set(rss, decode(feed.match(/<channel>\s*<title>([^<]*)/)?.[1] ?? ""));
  }
  console.log(`# ${q}`);
  for (const [rss, title] of seen) console.log(`  ${rss}\t${title}`);
  if (!seen.size) console.log("  (見つからず)");
}
