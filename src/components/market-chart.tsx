"use client";

import { useEffect, useRef, useState } from "react";
import { formatPrice, getMarket, type MarketCandle } from "@/lib/market-data";
import { useMarketFeed } from "@/lib/use-markets";

type MarketChartProps = { symbol?: string; timeframe?: string; mode?: "candles" | "line" };

export function MarketChart({ symbol = "BTC", timeframe = "1H", mode = "candles" }: MarketChartProps) {
  const asset = getMarket(symbol);
  const feed = useMarketFeed<{ candles: MarketCandle[] }>(`/api/market/candles?symbol=${encodeURIComponent(asset.symbol)}&interval=${encodeURIComponent(timeframe)}`);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 700, mobile: false });
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const resize = () => setViewport({ width: Math.max(260, element.getBoundingClientRect().width), mobile: window.matchMedia("(max-width: 740px)").matches });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);
  const width = viewport.width;
  const height = viewport.mobile ? 270 : 330;
  const candles = feed.data?.candles;
  if (!candles?.length) return <div ref={chartRef} style={{ minWidth: 0, height: height + 54, position: "relative", backgroundImage: "linear-gradient(#27302755 1px, transparent 1px),linear-gradient(90deg,#27302755 1px,transparent 1px)", backgroundSize: "100% 55px, 14.28% 100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}><span style={{ color: "#aab5a9", fontSize: 12 }}>{feed.status === "loading" ? "Connecting to Binance…" : "Market chart unavailable"}</span><span style={{ color: "#71806e", fontSize: 10, maxWidth: 240, textAlign: "center", lineHeight: 1.7 }}>{feed.status === "loading" ? "Retrieving public price candles" : "The public data provider is temporarily unavailable. We will reconnect automatically."}</span></div>;
  const currentPrice = candles[candles.length - 1].close;
  const volumeScale = 35 / Math.max(1, ...candles.map(candle => candle.volume));
  const left = 14;
  const right = width - 76;
  const top = 20;
  const bottom = height - 76;
  const volumeBase = height - 30;
  const gridCount = width < 450 ? 5 : 7;
  const min = Math.min(...candles.map(c => c.low)) * .9992;
  const max = Math.max(...candles.map(c => c.high)) * 1.0008;
  const py = (value: number) => top + (max - value) / (max - min) * (bottom - top);
  const step = (right - left) / candles.length;
  const px = (index: number) => left + index * step + step / 2;
  const active = candles[Math.min(hover?.index ?? candles.length - 1, candles.length - 1)];
  const averagePath = (length: number) => candles.map((_, index) => {
    const items = candles.slice(Math.max(0, index - length + 1), index + 1);
    const average = items.reduce((total, candle) => total + candle.close, 0) / items.length;
    return `${index ? "L" : "M"}${px(index).toFixed(1)},${py(average).toFixed(1)}`;
  }).join(" ");
  const closePath = candles.map((c, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(c.close).toFixed(1)}`).join(" ");
  const priceDigits = currentPrice < 1 ? 4 : 2;

  return <div ref={chartRef} style={{ minWidth: 0, position: "relative" }}>
    <div style={{ display: "flex", gap: "5px 10px", padding: "13px 14px 0", alignItems: "center", flexWrap: "wrap", fontSize: 9, color: "#7e8782", fontFamily: "inherit", minHeight: 25 }}>
      <span style={{ color: "#b9c1bc", fontSize: 11 }}>{asset.symbol}/USDT · {timeframe}</span>
      {([["O", active.open], ["H", active.high], ["L", active.low], ["C", active.close]] as [string, number][]).map(([label, value]) => <span key={label}>{label} <span style={{ color: active.close >= active.open ? "#47b99b" : "#e96c78", fontVariantNumeric: "tabular-nums" }}>{formatPrice(value, priceDigits)}</span></span>)}
      <span title={feed.updatedAt ? `Snapshot: ${feed.updatedAt}` : undefined} style={{ marginLeft: "auto", fontSize: 8, color: feed.status === "live" ? "#8faf71" : "#c4a770", letterSpacing: ".03em" }}>BINANCE · {feed.status === "live" ? "PUBLIC DATA" : "STALE"}</span>
    </div>
    <svg role="img" aria-label={`${asset.name} price chart from Binance${feed.status === "stale" ? ", stale snapshot" : ""}`} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", width: "100%", height, overflow: "visible", cursor: "crosshair" }} onMouseLeave={() => setHover(null)} onMouseMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width * width;
      const y = (event.clientY - rect.top) / rect.height * height;
      setHover({ index: Math.max(0, Math.min(candles.length - 1, Math.round((x - left) / step - .5))), y: Math.max(top, Math.min(bottom, y)) });
    }}>
      <defs>
        <linearGradient id={`chart-fill-${asset.symbol}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c4f36b" stopOpacity=".19" /><stop offset="100%" stopColor="#c4f36b" stopOpacity="0" /></linearGradient>
      </defs>
      {Array.from({ length: 6 }, (_, i) => {
        const y = top + i * (bottom - top) / 5;
        return <g key={`horizontal-${i}`}><line x1={left} x2={right} y1={y} y2={y} stroke="#252c27" strokeWidth=".7" strokeDasharray="3 5" /><text x={right + 12} y={y + 3} fill="#68726b" fontSize="9.5" fontFamily="inherit">{formatPrice(max - i * (max - min) / 5, priceDigits)}</text></g>;
      })}
      {Array.from({ length: gridCount }, (_, i) => {
        const x = left + i * (right - left) / (gridCount - 1);
        const candle = candles[Math.round(i * (candles.length - 1) / (gridCount - 1))];
        const date = new Date(candle.timestamp);
        const label = timeframe === "1D" || timeframe === "1W" ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
        return <g key={`vertical-${i}`}><line x1={x} x2={x} y1={top} y2={volumeBase} stroke="#252c27" strokeWidth=".7" strokeDasharray="3 5" /><text x={x} y={height - 10} fill="#68726b" fontSize="9" textAnchor={i === 0 ? "start" : "middle"} fontFamily="inherit">{label}</text></g>;
      })}
      {candles.map((candle, i) => <rect key={`vol-${i}`} x={px(i) - step * .3} y={volumeBase - candle.volume * volumeScale} width={step * .6} height={candle.volume * volumeScale} fill={candle.close >= candle.open ? "#31876c" : "#b25461"} opacity=".33" />)}
      <text x="20" y={bottom + 19} fill="#68726b" fontSize="9" fontFamily="inherit">Vol ({asset.symbol})</text>
      {mode === "line" ? <g><path d={`${closePath} L ${px(candles.length - 1)},${bottom} L ${px(0)},${bottom} Z`} fill={`url(#chart-fill-${asset.symbol})`} /><path d={closePath} stroke="#c4f36b" strokeWidth="1.8" fill="none" /></g> : candles.map((candle, i) => {
        const bullish = candle.close >= candle.open;
        const color = bullish ? "#42b69a" : "#e46775";
        return <g key={`candle-${i}`}><line x1={px(i)} x2={px(i)} y1={py(candle.high)} y2={py(candle.low)} stroke={color} strokeWidth="1" /><rect x={px(i) - step * .29} y={Math.min(py(candle.open), py(candle.close))} width={step * .58} height={Math.max(1.3, Math.abs(py(candle.open) - py(candle.close)))} fill={color} rx=".5" /></g>;
      })}
      <path d={averagePath(8)} stroke="#c7ad63" strokeWidth="1" fill="none" opacity=".85" />
      <path d={averagePath(22)} stroke="#6d8caf" strokeWidth="1" fill="none" opacity=".85" />
      <line x1={left} x2={right + 3} y1={py(currentPrice)} y2={py(currentPrice)} stroke="#9ed75e" strokeWidth=".7" strokeDasharray="4 4" opacity=".65" />
      <rect x={right + 3} y={py(currentPrice) - 10} width="68" height="20" fill="#c4f36b" rx="2" />
      <text x={right + 37} y={py(currentPrice) + 3.5} fill="#182111" fontSize="10" fontFamily="inherit" fontWeight="600" textAnchor="middle">{formatPrice(currentPrice, priceDigits)}</text>
      {hover && <g pointerEvents="none"><line x1={px(hover.index)} x2={px(hover.index)} y1={top} y2={volumeBase} stroke="#9aa59b" strokeWidth=".7" strokeDasharray="4 4" /><line x1={left} x2={right} y1={hover.y} y2={hover.y} stroke="#9aa59b" strokeWidth=".7" strokeDasharray="4 4" /><circle cx={px(hover.index)} cy={py(active.close)} r="3" fill="#d4f79a" stroke="#111413" strokeWidth="1.5" /><rect x={right + 3} y={hover.y - 9} width="68" height="18" fill="#39433a" rx="2" /><text x={right + 37} y={hover.y + 3.5} fill="#e5eae4" fontSize="9.5" textAnchor="middle">{formatPrice(max - (hover.y - top) / (bottom - top) * (max - min), priceDigits)}</text></g>}
    </svg>
    <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "0 14px 12px", fontSize: 9, color: "#69746b" }}><span style={{ whiteSpace: "nowrap" }}><span style={{ color: "#c7ad63" }}>●</span> MA 8</span><span style={{ whiteSpace: "nowrap" }}><span style={{ color: "#6d8caf" }}>●</span> MA 22</span><span style={{ marginLeft: "auto", fontSize: 8 }}>{feed.status === "stale" ? "Stale Binance snapshot" : "Source: Binance · UTC"}</span></div>
  </div>;
}

export default MarketChart;
