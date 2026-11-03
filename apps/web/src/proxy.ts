import { NextResponse, type NextRequest } from "next/server";
import { homeDestination, SESSION_COOKIE } from "@/auth/home-redirect";
import { customerIdFromSessionToken } from "@/auth/session";
import { withClient } from "@/db/pg";

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

// Next.js calls proxy(request, event). The event is not a session lookup.
export function proxy(request: NextRequest) {
  return redirectSignedOut(request);
}

export const config = {
  matcher: [
    "/",
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
