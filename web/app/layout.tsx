import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { Shell } from "@/components/Shell";
import { THEME_BOOT } from "@/lib/teamColors";
import "./globals.css";

// One family: Archivo at normal width for reading and condensed (font-stretch 75%) for figures, the score and
// section heads. A mono only for code and file names.
const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], axes: ["wdth"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Rendimiento · Fútbol",
  description: "Análisis de rivales, partidos propios y entrenamientos a partir de video y sensores.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme and team colors are set by THEME_BOOT before paint, so the server markup differs on purpose.
    <html lang="es" className={`${archivo.variable} ${jetbrains.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
