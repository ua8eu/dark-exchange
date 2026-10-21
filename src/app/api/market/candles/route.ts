import { getCandles, InvalidMarketRequest, validateInterval, validateSymbol } from "@/lib/server/market-feed";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const query = new URL(request.url).searchParams; return Response.json(await getCandles(validateSymbol(query.get("symbol")), validateInterval(query.get("interval"))), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { if (error instanceof InvalidMarketRequest) return Response.json({ error: error.message }, { status: 400 }); throw error; }
}
