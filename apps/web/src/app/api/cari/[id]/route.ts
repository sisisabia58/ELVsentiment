import { customerIdFromSessionToken } from "@/auth/session";
import { readSessionToken } from "@/auth/request-session";
import { withClient } from "@/db/pg";
import { loadSearchSnapshot } from "@/monitor/search/load";

export const dynamic = "force-dynamic";

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return errorResponse(401, "unauthenticated");
  const { id } = await context.params;
  const customerId = await withClient(async (db) => {
    try {
      return await customerIdFromSessionToken(db, token);
    } catch {
      return null;
    }
  });
  if (!customerId) return errorResponse(401, "unauthenticated");
  const snapshot = await withClient((db) => loadSearchSnapshot(db, customerId, id));
  if (!snapshot) return errorResponse(404, "not_found");
  return Response.json(snapshot, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
