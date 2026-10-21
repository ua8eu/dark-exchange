import { getDepth, InvalidMarketRequest, validateSymbol } from "@/lib/server/market-feed";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return Response.json(await getDepth(validateSymbol(new URL(request.url).searchParams.get("symbol"))), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { if (error instanceof InvalidMarketRequest) return Response.json({ error: error.message }, { status: 400 }); throw error; }
}
