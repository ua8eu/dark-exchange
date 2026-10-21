export type MarketAsset = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  volume: string;
  icon: string;
  color: string;
  sparkline: number[];
  high24h: number;
  low24h: number;
  quoteVolume: number;
};

const series = (seed: number, direction = 1) => Array.from({ length: 34 }, (_, index) => 30 + Math.sin(index * .7 + seed) * 7 + Math.sin(index * 1.7 + seed) * 3 + index * direction * .65);

const referenceAssets = [
  { symbol: "BTC", name: "Bitcoin", price: 67432.8, change: 2.84, volume: "1.42B", icon: "₿", color: "#f7931a", sparkline: series(1) },
  { symbol: "ETH", name: "Ethereum", price: 3521.4, change: 1.62, volume: "682.54M", icon: "Ξ", color: "#8b95ca", sparkline: series(4) },
  { symbol: "SOL", name: "Solana", price: 172.86, change: 5.21, volume: "324.87M", icon: "≋", color: "#9a85f5", sparkline: series(3, 1.5) },
  { symbol: "BNB", name: "BNB", price: 598.42, change: -0.62, volume: "184.32M", icon: "◇", color: "#f4ca4f", sparkline: series(5, -.7) },
  { symbol: "XRP", name: "XRP", price: .5248, change: 1.12, volume: "98.64M", icon: "×", color: "#d3dedb", sparkline: series(2, .5) },
  { symbol: "AVAX", name: "Avalanche", price: 35.82, change: 3.16, volume: "76.21M", icon: "▲", color: "#ed6c72", sparkline: series(6) },
  { symbol: "LINK", name: "Chainlink", price: 16.43, change: 2.17, volume: "52.36M", icon: "⬡", color: "#7193e5", sparkline: series(7) },
  { symbol: "DOGE", name: "Dogecoin", price: .1428, change: -1.32, volume: "65.48M", icon: "Ð", color: "#d9bf68", sparkline: series(8, -.4) },
];

// Reference values only. The public feed replaces these after a successful request.
export const assets: MarketAsset[] = referenceAssets.map(asset => ({ ...asset, high24h: Number((asset.price * 1.0137).toFixed(8)), low24h: Number((asset.price * .9654).toFixed(8)), quoteVolume: Number.parseFloat(asset.volume) * (asset.volume.endsWith("B") ? 1e9 : 1e6) }));

export type FeedStatus = "loading" | "live" | "stale" | "offline";
export type FeedMeta = { source: "Binance"; status: Exclude<FeedStatus, "loading">; updatedAt: string | null; error?: string };
export type MarketCandle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
export type DepthLevel = { price: number; amount: number };
export type MarketBook = { bids: DepthLevel[]; asks: DepthLevel[]; lastUpdateId: number };
export type MarketTrade = { id: number; price: number; amount: number; timestamp: number; isBuyerMaker: boolean };

export const markets = assets;

export function getMarket(symbol = "BTC") {
  return assets.find((asset) => asset.symbol === symbol.split(/[/-]/)[0].replace("USDT", "")) || assets[0];
}

export function formatPrice(value: number, digits?: number) {
  const places = digits ?? (value < 1 ? 4 : 2);
  return value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
}
