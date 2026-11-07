import type { Metadata } from "next";
import { headers } from "next/headers";
import { Arimo, IBM_Plex_Mono, VT323 } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// next/font self-hosts the font files at build time: no runtime CDN request.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-plex-mono",
  display: "swap",
});
const arimo = Arimo({ subsets: ["latin"], variable: "--font-arimo", display: "swap" });
const vt323 = VT323({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-vt323",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Séance",
  description: "IRC is dead. Hold a séance.",
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Reading request headers opts the route into dynamic rendering, which the CSP nonce needs.
  // Next.js reads the nonce from the CSP header and applies it to its own scripts; the
  // x-nonce value is exposed on <body> so the policy can be checked in the browser.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${plexMono.variable} ${arimo.variable} ${vt323.variable}`}>
      <body className="font-chrome" data-csp-nonce={nonce}>
        {children}
      </body>
    </html>
  );
}
