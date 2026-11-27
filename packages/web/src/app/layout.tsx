import type { Metadata } from "next";
import type { ReactNode } from "react";
import { apiConfig } from "../lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContractPulse",
  description: "Contract version history and impact on registered consumers",
};

// Every page reads live registry data.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const { workspace } = apiConfig();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            ContractPulse
          </a>
          <span className="muted" data-testid="workspace">
            Workspace <code>{workspace}</code>
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
