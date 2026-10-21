"use client";

import { ArrowDownUp, ChevronDown } from "lucide-react";
import { formatPrice, getMarket, type DepthLevel, type MarketBook, type MarketTrade } from "@/lib/market-data";
import { useMarketFeed } from "@/lib/use-markets";

type OrderBookProps = { symbol?: string; onPriceSelect?: (price: number) => void };
const green = "#45b699";
const red = "#e5707e";
const muted = "#737e76";
const amountText = (amount: number) => amount.toLocaleString("en-US", { minimumFractionDigits: amount < 100 ? 5 : 2, maximumFractionDigits: amount < 100 ? 5 : 2 });
const totalText = (total: number) => total >= 1000 ? `${(total / 1000).toFixed(2)}K` : total.toFixed(2);

export function OrderBook({ symbol = "BTC", onPriceSelect }: OrderBookProps) {
  const asset = getMarket(symbol);
  const feed = useMarketFeed<{ book: MarketBook }>(`/api/market/depth?symbol=${encodeURIComponent(asset.symbol)}`, 15000);
  const book = feed.data?.book;
  const asks = book?.asks.slice(0, 7).reverse() || [];
  const bids = book?.bids.slice(0, 7) || [];
  const mid = book ? (book.asks[0].price + book.bids[0].price) / 2 : null;
  const buyAmount = bids.reduce((sum, row) => sum + row.amount, 0);
  const sellAmount = asks.reduce((sum, row) => sum + row.amount, 0);
  const buyPercent = (buyAmount + sellAmount) > 0 ? buyAmount / (buyAmount + sellAmount) * 100 : 50;
  const maximum = Math.max(1, ...asks.map(row => row.amount), ...bids.map(row => row.amount));
  const renderRow = (row: DepthLevel, index: number, ask: boolean) => <button type="button" onClick={() => onPriceSelect?.(row.price)} key={`${ask}-${index}`} aria-label={`Select Binance price ${formatPrice(row.price)}`} style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", width: "100%", alignItems: "center", border: 0, background: "transparent", padding: "0 15px", color: "#b4beb6", fontSize: 10, height: 20, fontVariantNumeric: "tabular-nums", cursor: onPriceSelect ? "pointer" : "default", fontFamily: "inherit", textAlign: "right" }}><span style={{ position: "absolute", width: `${Math.max(2, row.amount / maximum * 84)}%`, height: "19px", right: 0, background: ask ? "rgba(203,78,99,.095)" : "rgba(59,163,124,.105)", transition: "width .5s ease", pointerEvents: "none" }} /><span style={{ color: ask ? red : green, textAlign: "left", position: "relative" }}>{formatPrice(row.price)}</span><span style={{ position: "relative" }}>{amountText(row.amount)}</span><span style={{ position: "relative" }}>{totalText(row.amount * row.price)}</span></button>;
  return <div style={{ minWidth: 0, overflow: "hidden" }}>
    <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 15px 8px", alignItems: "center" }}><div style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ display: "grid", gap: 2 }}>{[red, green].map(color => <i key={color} style={{ display: "block", width: 11, height: 3, background: color, borderRadius: 1 }} />)}</span><span title={feed.updatedAt || undefined} style={{ fontSize: 8, color: feed.status === "live" ? muted : "#c5aa78", marginLeft: 5 }}>Binance{feed.status === "stale" ? " · Stale" : feed.status === "offline" ? " · Offline" : ""}</span></div><span style={{ color: "#acb6ad", display: "flex", gap: 5, alignItems: "center", fontSize: 10 }}>{(mid || asset.price) < 1 ? "0.0001" : "0.01"}<ChevronDown size={10} color={muted} /></span></div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "0 15px 8px", color: muted, fontSize: 9 }}><span>Price (USDT)</span><span style={{ textAlign: "right" }}>Amount ({asset.symbol})</span><span style={{ textAlign: "right" }}>Total</span></div>
    {book ? <>{asks.map((row, index) => renderRow(row, index, true))}
      <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "8px 15px", borderTop: "1px solid #212721", borderBottom: "1px solid #212721", margin: "3px 0" }}><strong style={{ fontSize: 18, color: green, fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "-.6px" }}>{formatPrice(mid!)}</strong><ArrowDownUp size={12} color={muted} style={{ flexShrink: 0 }} /><span style={{ color: muted, fontSize: 8.5, marginLeft: "auto", whiteSpace: "nowrap" }}>Mid-price</span></div>
      {bids.map((row, index) => renderRow(row, index, false))}
      <div style={{ padding: "8px 15px" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 5 }}><span style={{ color: green }}>B <span style={{ marginLeft: 5 }}>{buyPercent.toFixed(1)}%</span></span><span style={{ color: red }}>{(100 - buyPercent).toFixed(1)}% <span style={{ marginLeft: 5 }}>S</span></span></div><div style={{ height: 3, display: "flex", gap: 3 }}><div style={{ background: "#378c70", flex: buyPercent, borderRadius: "2px 0 0 2px" }} /><div style={{ background: "#994b5b", flex: 100 - buyPercent, borderRadius: "0 2px 2px 0" }} /></div></div></> : <FeedUnavailable loading={feed.status === "loading"} />}
    <p style={{ color: muted, fontSize: 8, padding: "7px 15px 10px", margin: 0 }}>External Binance order book · Not platform orders</p>
  </div>;
}

function FeedUnavailable({ loading }: { loading: boolean }) {
  return <div style={{ height: 320, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, color: muted, textAlign: "center", fontSize: 10, lineHeight: 1.7 }}><span style={{ color: "#a3b19a" }}>{loading ? "Connecting to Binance…" : "Public feed unavailable"}</span><span style={{ fontSize: 9 }}>{loading ? "Retrieving public market data" : "We will reconnect automatically. No sample orders are shown."}</span></div>;
}

export function RecentTrades({ symbol = "BTC" }: { symbol?: string }) {
  const asset = getMarket(symbol);
  const feed = useMarketFeed<{ trades: MarketTrade[] }>(`/api/market/trades?symbol=${encodeURIComponent(asset.symbol)}`, 15000);
  return <div style={{ padding: "15px", minWidth: 0 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 15 }}><span style={{ fontSize: 12, fontWeight: 600 }}>External trades</span><span title={feed.updatedAt || undefined} style={{ fontSize: 9, color: feed.status === "stale" ? "#c5aa78" : muted }}>Binance{feed.status === "stale" ? " · Stale" : ""}</span></div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", color: muted, fontSize: 9, marginBottom: 9 }}><span>Price (USDT)</span><span style={{ textAlign: "right" }}>Amount</span><span style={{ textAlign: "right" }}>Time (UTC)</span></div>{feed.data?.trades ? feed.data.trades.slice(-14).reverse().map(trade => <div key={trade.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", lineHeight: "24px", fontSize: 10, fontVariantNumeric: "tabular-nums" }}><span style={{ color: trade.isBuyerMaker ? red : green }}>{formatPrice(trade.price)}</span><span style={{ textAlign: "right", color: "#b5bdb5" }}>{amountText(trade.amount)}</span><span style={{ textAlign: "right", color: muted }}>{new Date(trade.timestamp).toLocaleTimeString("en-GB", { timeZone: "UTC" })}</span></div>) : <FeedUnavailable loading={feed.status === "loading"} />}<p style={{ fontSize: 8, color: muted, marginTop: 12, lineHeight: 1.6 }}>Trades executed on Binance. No executions occur on this platform.</p></div>;
}

export default OrderBook;
