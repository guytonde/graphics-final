import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Squishy Jenga — CS 354H",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: "#07070e", overflow: "hidden" }}>
        {children}
      </body>
    </html>
  );
}
