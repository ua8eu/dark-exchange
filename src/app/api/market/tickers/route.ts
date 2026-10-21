import { getTickers } from "@/lib/server/market-feed";
export const runtime = "nodejs";
export async function GET() { return Response.json(await getTickers(), { headers: { "Cache-Control": "no-store" } }); }
