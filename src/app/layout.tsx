import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { Providers } from "@/components/providers";
import { env } from "@/lib/env";

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

// Dark is the application's default now, whatever the operating system
// prefers, so splitting this on `prefers-color-scheme` would paint the browser
// chrome white above a dark app. One value, matching `--background` in the dark
// palette.
export const viewport: Viewport = {
  themeColor: "#090c12",
};

/*
 * There is no auth provider here, and none is needed.
 *
 * Clerk required one: `<ClerkProvider>` fetched a session into React context so
 * its hooks and components could read it. Supabase has no equivalent
 * requirement — a client component that needs the session builds its own client
 * with `createSupabaseBrowserClient()`, which is a singleton reading the same
 * cookies the server reads, so there is nothing for a provider to carry.
 *
 * Adding one anyway would mean a context whose only job is to hold a value the
 * consumer can already obtain, and a wrapper that has to be kept in sync with
 * whatever the server believes about the same request.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
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
}
