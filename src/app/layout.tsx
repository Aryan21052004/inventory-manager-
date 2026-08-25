import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";

import { Providers } from "@/components/providers";
import { authEnabled, env } from "@/lib/env";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: env.NEXT_PUBLIC_APP_NAME,
    template: `%s · ${env.NEXT_PUBLIC_APP_NAME}`,
  },
  description:
    "Stock control for products, orders, purchases and suppliers, with automatic inventory adjustment.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111318" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const tree = (
    <html
      lang="en"
      // next-themes writes the theme class here after mount; without this the
      // server-rendered markup and the client disagree and React complains.
      suppressHydrationWarning
      className={`${inter.variable} ${jetBrainsMono.variable}`}
    >
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );

  // ClerkProvider throws without a publishable key, so in setup mode the tree
  // is rendered without it and the auth-dependent UI falls back. See env.ts —
  // production refuses to start in that state.
  return authEnabled ? <ClerkProvider>{tree}</ClerkProvider> : tree;
}
