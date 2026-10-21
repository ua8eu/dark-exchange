"use client";
import { useEffect, useState } from "react";
import { assets, type FeedMeta, type FeedStatus, type MarketAsset } from "./market-data";

type State<T> = { key: string; data: T | null; status: FeedStatus; updatedAt: string | null; error?: string };
const cache = new Map<string, { data: unknown; status: FeedStatus; updatedAt: string | null; error?: string }>();

export function useMarketFeed<T extends object>(endpoint: string, pollMs = 30000) {
  const [state, setState] = useState<State<T>>({ key: endpoint, data: null, status: "loading", updatedAt: null });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const cached = cache.get(endpoint);
    setState({ key: endpoint, data: (cached?.data as T) || null, status: cached ? "stale" : "loading", updatedAt: cached?.updatedAt || null });
    const load = async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Market feed unavailable.");
        const body = await response.json() as T & FeedMeta;
        if (!active) return;
        if (body.source !== "Binance" || !["live", "stale", "offline"].includes(body.status)) throw new Error("Invalid market feed response.");
        if (body.status === "offline") {
          setState(previous => ({ ...previous, status: previous.data ? "stale" : "offline", error: body.error || "Public market feed unavailable." }));
          return;
        }
        const next = { key: endpoint, data: body as T, status: body.status, updatedAt: body.updatedAt, error: body.error };
        cache.set(endpoint, next);
        setState(next);
      } catch {
        if (active) setState(previous => ({ ...previous, status: previous.data ? "stale" : "offline", error: "Market feed unavailable. Values may be out of date." }));
      }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, pollMs);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", resume);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [endpoint, pollMs]);
  return state.key === endpoint ? state : { key: endpoint, data: null, status: "loading" as FeedStatus, updatedAt: null };
}

export function useMarkets(): { markets: MarketAsset[]; status: FeedStatus; updatedAt: string | null; source: "Binance"; error?: string } {
  const { data, status, updatedAt, error } = useMarketFeed<{ markets: MarketAsset[] }>("/api/market/tickers");
  return { markets: data?.markets || assets, status, updatedAt, source: "Binance", error };
}
