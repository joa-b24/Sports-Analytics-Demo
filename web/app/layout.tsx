import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { MobileInit } from "@/components/MobileInit";
import { Shell } from "@/components/Shell";
import { MOBILE } from "@/lib/mobile";
import { THEME_BOOT } from "@/lib/teamColors";
import "./globals.css";

// One family: Archivo at normal width for reading and condensed (font-stretch 75%) for figures, the score and
// section heads. A mono only for code and file names.
// Self-hosted (app/fonts, latin subset, variable): next/font/google needs internet and failed on this laptop.
const archivo = localFont({ src: "./fonts/Archivo-latin.woff2", variable: "--font-archivo", weight: "100 900", style: "normal", display: "swap", declarations: [{ prop: "font-stretch", value: "62% 125%" }] });
const jetbrains = localFont({ src: "./fonts/JetBrainsMono-latin.woff2", variable: "--font-jetbrains", weight: "100 800", style: "normal", display: "swap" });

export const metadata: Metadata = {
  title: "Rendimiento · Fútbol",
  description: "Análisis de rivales, partidos propios y entrenamientos a partir de video y sensores.",
  // The installable app (mobile build only).
  ...(MOBILE ? { manifest: "/manifest.webmanifest" } : {}),
};

export const viewport: Viewport = { themeColor: "#1d4ed8" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme and team colors are set by THEME_BOOT before paint, so the server markup differs on purpose.
    <html lang="es" className={`${archivo.variable} ${jetbrains.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full">
        <MobileInit />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
