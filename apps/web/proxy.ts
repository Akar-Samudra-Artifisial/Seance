import { NextResponse, type NextRequest } from "next/server";
import { computeConnectConfig } from "./src/config/connect-src";
import { buildCsp } from "./src/config/csp";

/** The client needs no powerful browser feature. */
const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

/**
 * Sets a per-request CSP nonce and Content-Security-Policy header.
 * Headers only: it never reads or forwards IRC traffic.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === "development";
  const { allowedOrigins } = computeConnectConfig(process.env);
  const csp = buildCsp({ nonce, connectOrigins: allowedOrigins, dev });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
