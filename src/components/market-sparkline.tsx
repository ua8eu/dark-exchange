'use client';

import { useEffect, useId, useState } from 'react';

type Trend = { values: number[]; status: 'live' | 'stale' | 'offline'; checkedAt: number };
const snapshots = new Map<string, Trend>();
const pending = new Map<string, Promise<Trend>>();

async function getTrend(symbol: string): Promise<Trend> {
  const cached = snapshots.get(symbol);
  if (cached && Date.now() - cached.checkedAt < 45_000) return cached;
  const previous = pending.get(symbol);
  if (previous) return previous;
  const request = (async () => {
    try {
      const response = await fetch(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&interval=1H`, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('Trend unavailable');
      const data = await response.json();
      const values = Array.isArray(data.candles) ? data.candles.slice(-24).map((c: { close: number }) => c.close) : [];
      if (values.length < 2 || values.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) throw new Error('Trend unavailable');
      const next: Trend = { values, status: data.status === 'live' ? 'live' : 'stale', checkedAt: Date.now() };
      snapshots.set(symbol, next);
      return next;
    } catch {
      const next: Trend = { values: cached?.values || [], status: cached?.values.length ? 'stale' : 'offline', checkedAt: Date.now() };
      snapshots.set(symbol, next);
      return next;
    } finally { pending.delete(symbol); }
  })();
  pending.set(symbol, request);
  return request;
}

export function MarketSparkline({ symbol, up = true }: { symbol: string; up?: boolean }) {
  const [trend, setTrend] = useState<Trend>({ values: [], status: 'offline', checkedAt: 0 });
  const id = useId().replaceAll(':', '');
  useEffect(() => {
    let active = true;
    const update = () => { if (document.visibilityState === 'hidden') return; void getTrend(symbol).then(next => { if (active) setTrend(next); }); };
    update();
    const interval = setInterval(update, 60_000);
    return () => { active = false; clearInterval(interval); };
  }, [symbol]);
  if (trend.values.length < 2) return <svg className="sparkline sparkline-unavailable" viewBox="0 0 104 42" role="img" aria-label={`${symbol} trend unavailable`}><title>Waiting for Binance price history</title><line x1="4" x2="100" y1="24" y2="24" stroke="#43523a" strokeWidth="1" strokeDasharray="3 4"/></svg>;
  const min = Math.min(...trend.values);
  const range = Math.max(...trend.values) - min || 1;
  const points = trend.values.map((v, i) => `${(i / (trend.values.length - 1) * 102).toFixed(2)},${(35 - (v - min) / range * 28).toFixed(2)}`).join(' ');
  const color = up ? '#67be9b' : '#d5767b';
  return <svg className="sparkline" viewBox="0 0 104 42" role="img" aria-label={`${symbol} last 24 hourly closes from Binance${trend.status === 'stale' ? ', delayed' : ''}`} style={{ opacity: trend.status === 'stale' ? .5 : undefined }}><title>Binance · last 24 hourly closes{trend.status === 'stale' ? ' · delayed data' : ''}</title><defs><linearGradient id={`trend-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".15"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs><polygon points={`0,42 ${points} 102,42`} fill={`url(#trend-${id})`}/><polyline points={points} fill="none" stroke={color} strokeWidth="1.5"/></svg>;
}
