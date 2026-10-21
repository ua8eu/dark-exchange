import assert from "node:assert/strict";
import test from "node:test";
import { getCandles, getDepth, getTickers, getTrades, InvalidMarketRequest, numeric, validateInterval, validateSymbol } from "../src/lib/server/market-feed";

test("market inputs permit supported pairs and reject arbitrary upstream parameters", () => {
  assert.equal(validateSymbol("BTC"), "BTCUSDT");
  assert.equal(validateSymbol("DOGE"), "DOGEUSDT");
  assert.equal(validateInterval("1H"), "1h");
  assert.equal(validateInterval("1W"), "1w");
  for (const input of ["https://example.com", "BTCUSDT", "BTC&limit=1000", "__proto__"]) assert.throws(() => validateSymbol(input), InvalidMarketRequest);
  for (const input of ["1s", "toString", "__proto__"]) assert.throws(() => validateInterval(input), InvalidMarketRequest);
  for (const value of ["", "NaN", "Infinity", -1, 0, null, true]) assert.throws(() => numeric(value));
  assert.equal(numeric("1.234"), 1.234);
  assert.equal(numeric("-2.8", false), -2.8);
});

test("provider snapshots validate data, preserve stale values and never invent offline values", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  let unavailable = false;
  Date.now = () => now;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://data-api.binance.vision");
    if (unavailable) throw new Error("Network unavailable");
    let data: unknown;
    if (url.pathname.endsWith("/klines")) data = [[now - 3600000, "100", "110", "90", "105", "25"]];
    else if (url.pathname.endsWith("/depth")) data = { lastUpdateId: 1, bids: [["100", "-1"]], asks: [["101", "2"]] };
    else if (url.pathname.endsWith("/trades")) data = [{ id: 1, price: "105", qty: "2", time: now, isBuyerMaker: false }];
    else data = [{ symbol: "BTCUSDT", lastPrice: "105" }];
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", Date: new Date(now).toUTCString() } });
  }) as typeof fetch;
  try {
    const live = await getCandles("BTCUSDT", "1h");
    assert.equal(live.status, "live");
    assert.equal(live.source, "Binance");
    assert.equal(live.candles[0].close, 105);
    assert.equal(live.candles[0].volume, 25);
    const malformedDepth = await getDepth("BTCUSDT");
    assert.equal(malformedDepth.status, "offline");
    assert.equal(malformedDepth.book, undefined);
    const incompleteTickers = await getTickers();
    assert.equal(incompleteTickers.status, "offline");
    assert.equal(incompleteTickers.markets, undefined);
    const trades = await getTrades("BTCUSDT");
    assert.equal(trades.trades[0].price, 105);
    unavailable = true;
    now += 31000;
    const stale = await getCandles("BTCUSDT", "1h");
    assert.equal(stale.status, "stale");
    assert.equal(stale.updatedAt, live.updatedAt);
    assert.deepEqual(stale.candles, live.candles);
    const offline = await getCandles("SOLUSDT", "1h");
    assert.equal(offline.status, "offline");
    assert.equal(offline.updatedAt, null);
    assert.equal(offline.candles, undefined);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});
