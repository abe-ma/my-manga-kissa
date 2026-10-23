// state/episodes.json の形。取得処理(main.ts)が書き、ページ生成(build.ts)が読む
export type ViewEpisode = {
  guid: string;
  title: string;
  url: string;
  date: string | null; // サイトが公開日を返すとき
  firstSeen: string | null; // このツールが初めて見つけた時刻
};
export type ViewData = {
  updatedAt?: string;
  series: Record<string, { name: string; episodes: ViewEpisode[] } | undefined>;
};
