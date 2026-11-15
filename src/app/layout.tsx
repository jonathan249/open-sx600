import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { BikeProvider } from "@/components/bike-provider";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "SX600 Dashboard",
  description: "Live dashboard, workouts and ride history for the Sportstech SX600",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: THEME_SCRIPT adds the `dark` class before React hydrates.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <BikeProvider>
          <AppShell>{children}</AppShell>
        </BikeProvider>
      </body>
    </html>
  );
}
