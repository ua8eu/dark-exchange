import { assets, type FeedMeta, type MarketAsset, type MarketBook, type MarketCandle, type MarketTrade } from "../market-data";

const BASE = "https://data-api.binance.vision/api/v3/";
const allowedSymbols = new Set(assets.map(asset => asset.symbol));
const intervals: Record<string, string> = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
const snapshots = new Map<string, { data: unknown; updatedAt: string; expires: number }>();
const pending = new Map<string, Promise<unknown>>();

export class InvalidMarketRequest extends Error {}

export function validateSymbol(value: string | null) {
  const symbol = value || "BTC";
  if (!allowedSymbols.has(symbol)) throw new InvalidMarketRequest("Unsupported market symbol.");
  return `${symbol}USDT`;
}

export function validateInterval(value: string | null) {
  const key = value || "1H";
  if (!Object.hasOwn(intervals, key)) throw new InvalidMarketRequest("Unsupported chart interval.");
  return intervals[key];
}

export function numeric(value: unknown, positive = true): number {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") throw new Error("Invalid market response.");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (positive && parsed <= 0)) throw new Error("Invalid market response.");
  return parsed;
}

const nonnegative = (value: unknown) => { const result = numeric(value, false); if (result < 0) throw new Error("Invalid market response."); return result; };
type Snapshot<T> = FeedMeta & T;

async function feed<T extends object>(key: string, path: "ticker/24hr" | "klines" | "depth" | "trades", parameters: Record<string, string>, parse: (value: unknown) => T, ttl = 30): Promise<Snapshot<T>> {
  const previous = snapshots.get(key);
  if (previous && previous.expires > Date.now()) return { ...(previous.data as T), source: "Binance", status: Date.now() - Date.parse(previous.updatedAt) > 90000 ? "stale" : "live", updatedAt: previous.updatedAt };
  const existing = pending.get(key);
  if (existing) return existing as Promise<Snapshot<T>>;
  const task = (async (): Promise<Snapshot<T>> => {
    try {
      const url = new URL(path, BASE);
      url.search = new URLSearchParams(parameters).toString();
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000), next: { revalidate: ttl } });
      if (!response.ok) throw new Error(`Public market provider unavailable (${response.status}).`);
      const data = parse(await response.json());
      const headerDate = response.headers.get("date");
      const updatedAt = headerDate && Number.isFinite(Date.parse(headerDate)) ? new Date(headerDate).toISOString() : new Date().toISOString();
      snapshots.set(key, { data, updatedAt, expires: Date.now() + ttl * 1000 });
      return { ...data, source: "Binance", status: Date.now() - Date.parse(updatedAt) > 90000 ? "stale" : "live", updatedAt };
    } catch {
      if (previous) return { ...(previous.data as T), source: "Binance", status: "stale", updatedAt: previous.updatedAt, error: "Binance is temporarily unavailable. Showing the last received snapshot." };
      return { source: "Binance", status: "offline", updatedAt: null, error: "Binance market data is temporarily unavailable." } as Snapshot<T>;
    } finally { pending.delete(key); }
  })();
  pending.set(key, task);
  return task;
}

export function getTickers() {
  return feed("tickers", "ticker/24hr", { symbols: JSON.stringify(assets.map(asset => `${asset.symbol}USDT`)) }, raw => {
    if (!Array.isArray(raw) || raw.length !== assets.length) throw new Error("Incomplete market response.");
    const markets: MarketAsset[] = assets.map(asset => {
      const ticker = raw.find(row => row?.symbol === `${asset.symbol}USDT`);
      if (!ticker) throw new Error("Incomplete market response.");
      const quoteVolume = nonnegative(ticker.quoteVolume);
      return { ...asset, price: numeric(ticker.lastPrice), change: numeric(ticker.priceChangePercent, false), high24h: numeric(ticker.highPrice), low24h: numeric(ticker.lowPrice), quoteVolume, volume: quoteVolume >= 1e9 ? `${(quoteVolume / 1e9).toFixed(2)}B` : `${(quoteVolume / 1e6).toFixed(2)}M`, sparkline: [] };
    });
    return { markets };
  }, 20);
}

export function getCandles(symbol: string, interval: string) {
  return feed(`candles:${symbol}:${interval}`, "klines", { symbol, interval, limit: "88" }, raw => {
    if (!Array.isArray(raw) || !raw.length) throw new Error("Invalid candles.");
    const candles: MarketCandle[] = raw.map(row => {
      if (!Array.isArray(row) || row.length < 6) throw new Error("Invalid candle.");
      const candle = { timestamp: numeric(row[0]), open: numeric(row[1]), high: numeric(row[2]), low: numeric(row[3]), close: numeric(row[4]), volume: nonnegative(row[5]) };
      if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) throw new Error("Invalid candle range.");
      return candle;
    });
    return { candles };
  });
}

export function getDepth(symbol: string) {
  return feed(`depth:${symbol}`, "depth", { symbol, limit: "10" }, raw => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid depth.");
    const data = raw as Record<string, unknown>;
    const levels = (value: unknown) => {
      if (!Array.isArray(value) || !value.length) throw new Error("Invalid depth levels.");
      return value.map(row => { if (!Array.isArray(row) || row.length < 2) throw new Error("Invalid depth level."); return { price: numeric(row[0]), amount: nonnegative(row[1]) }; });
    };
    const book: MarketBook = { bids: levels(data.bids), asks: levels(data.asks), lastUpdateId: numeric(data.lastUpdateId) };
    return { book };
  }, 10);
}

export function getTrades(symbol: string) {
  return feed(`trades:${symbol}`, "trades", { symbol, limit: "20" }, raw => {
    if (!Array.isArray(raw)) throw new Error("Invalid trades.");
    const trades: MarketTrade[] = raw.map(row => { if (!row || typeof row.isBuyerMaker !== "boolean") throw new Error("Invalid trade."); return { id: nonnegative(row.id), price: numeric(row.price), amount: nonnegative(row.qty), timestamp: numeric(row.time), isBuyerMaker: row.isBuyerMaker }; });
    return { trades };
  }, 10);
}
