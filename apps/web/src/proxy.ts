import { NextResponse, type NextRequest } from "next/server";
import { homeDestination, SESSION_COOKIE } from "@/auth/home-redirect";
import { customerIdFromSessionToken } from "@/auth/session";
import { platformAdminForSession, sessionTokenHash } from "@/auth/admin";
import { withCustomer } from "@/db/migrate";
import { withClient } from "@/db/pg";
import { cariSekarangEnabled } from "@/monitor/search/feature";

async function lookupCustomer(token: string): Promise<string | null> {
  try {
    return await withClient((db) => customerIdFromSessionToken(db, token));
  } catch (error) {
    if (!(error instanceof Error && error.message === "unauthenticated")) {
      console.error("session lookup failed", error instanceof Error ? error.message : error);
    }
    return null;
  }
}

// Cache Components sends the static shell before a Suspense redirect, so `/`
// decides here, from the session cookie and a database check, and returns 307
// before any page HTML.
type SessionLookup = (token: string) => Promise<string | null>;

export async function redirectHome(request: NextRequest, lookup: SessionLookup = lookupCustomer) {
  if (request.nextUrl.pathname !== "/") return NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const destination = await homeDestination(token, lookup);
  const url = request.nextUrl.clone();
  url.pathname = destination;
  url.search = "";
  return NextResponse.redirect(url);
}

const PROTECTED_PREFIXES = [
  "/dasbor",
  "/sebutan",
  "/perlu-perhatian",
  "/belum-yakin",
  "/pengumpulan",
  "/proyek",
  "/akun",
  "/onboarding",
  "/sumber",
];

export function isProtectedAppPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// App pages redirect inside Suspense, which paints an empty shell first.
// Decide here, from the session cookie, and return 307 before any page HTML.
export async function redirectSignedOut(request: NextRequest, lookup: SessionLookup = lookupCustomer) {
  if (request.nextUrl.pathname === "/") return redirectHome(request, lookup);
  if (!isProtectedAppPath(request.nextUrl.pathname)) return NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const destination = await homeDestination(token, lookup);
  if (destination === "/dasbor") return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/masuk";
  url.search = "";
  return NextResponse.redirect(url);
}

export function isCariPath(pathname: string): boolean {
  return pathname === "/cari" || pathname.startsWith("/cari/");
}

function notFoundResponse(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const CARI_NOT_FOUND_PATH = "/cari-tidak-ditemukan";

// Keep the real 404 status but render the app-styled card: rewrite to a small
// internal page. The flag-off gate above still returns the plain unknown-route
// response, so the feature is not revealed when it is disabled.
function cariNotFoundResponse(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = CARI_NOT_FOUND_PATH;
  const response = NextResponse.rewrite(url, { status: 404 });
  response.headers.set("cache-control", "no-store");
  return response;
}

// notFound() inside <Suspense> runs after the PPR shell streamed, so the status
// was 200. The flag is decided here, before any HTML, for a real 404.
export function cariGate(request: NextRequest): NextResponse | null {
  if (cariSekarangEnabled()) return null;
  const pathname = request.nextUrl.pathname;
  if (!isCariPath(pathname) && pathname !== "/pengaturan/provider") return null;
  return notFoundResponse();
}

type AdminLookup = (token: string) => Promise<boolean | null>;

async function lookupPlatformAdmin(token: string): Promise<boolean | null> {
  try {
    return await withClient(async (db) => {
      const customerId = await customerIdFromSessionToken(db, token);
      const admin = await platformAdminForSession(db, customerId, sessionTokenHash(token));
      return admin !== null;
    });
  } catch {
    return null;
  }
}

// A signed-in non-admin gets a real 404 here, before the PPR shell streams.
// An unusable session is left to the page's normal sign-in redirect.
export async function providerAdminGate(
  request: NextRequest,
  lookup: AdminLookup = lookupPlatformAdmin,
): Promise<NextResponse | null> {
  if (request.nextUrl.pathname !== "/pengaturan/provider") return null;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  if ((await lookup(token)) !== false) return null;
  return notFoundResponse();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /cari/<one segment> other than the history page. Multi-segment paths and the
// list page keep their normal handling.
function cariDetailSegment(pathname: string): string | null {
  const prefix = "/cari/";
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length);
  if (!segment || segment.includes("/") || segment === "riwayat") return null;
  return segment;
}

type SearchLookup = (token: string, searchId: string) => Promise<boolean | null>;

async function lookupOwnedSearch(token: string, searchId: string): Promise<boolean | null> {
  try {
    return await withClient(async (db) => {
      const customerId = await customerIdFromSessionToken(db, token);
      return await withCustomer(db, customerId, async () => {
        const found = await db.query<{ id: string }>(
          "select id from instant_searches where id = $1 and customer_id = $2 limit 1",
          [searchId, customerId],
        );
        return found.rows.length > 0;
      });
    });
  } catch {
    return null;
  }
}

// notFound() inside the PPR/Suspense tree leaves the HTTP status at 200. Decide
// here, before the shell streams: a malformed id is a real 404, and a UUID that
// is not this session's search is a real 404 too. An unusable session or a
// lookup error is left to the page's normal handling.
export async function cariIdGate(
  request: NextRequest,
  lookup: SearchLookup = lookupOwnedSearch,
): Promise<NextResponse | null> {
  const segment = cariDetailSegment(request.nextUrl.pathname);
  if (!segment) return null;
  if (!UUID_PATTERN.test(segment)) return cariNotFoundResponse(request);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let owned: boolean | null;
  try {
    owned = await lookup(token, segment);
  } catch {
    return null;
  }
  return owned === false ? cariNotFoundResponse(request) : null;
}

// Next.js calls proxy(request, event). The event is not a session lookup.
export async function proxy(request: NextRequest) {
  const gated = cariGate(request);
  if (gated) return gated;
  const missing = await cariIdGate(request);
  if (missing) return missing;
  const provider = await providerAdminGate(request);
  if (provider) return provider;
  return redirectSignedOut(request);
}

export const config = {
  matcher: [
    "/",
    "/cari",
    "/cari/:path*",
    "/pengaturan/provider",
    "/dasbor",
    "/dasbor/:path*",
    "/sebutan",
    "/sebutan/:path*",
    "/perlu-perhatian",
    "/perlu-perhatian/:path*",
    "/belum-yakin",
    "/belum-yakin/:path*",
    "/pengumpulan",
    "/pengumpulan/:path*",
    "/proyek",
    "/proyek/:path*",
    "/akun",
    "/akun/:path*",
    "/onboarding",
    "/onboarding/:path*",
    "/sumber",
    "/sumber/:path*",
  ],
};
