import type { Metadata, Viewport } from "next";
import "./globals.css";
import "../../../ui/editor-shell.css";
import "../../../ui/editor-controls.css";
import "./lab-editor.css";

export const metadata: Metadata = {
  title: "VoxelBench — Visual physics tests",
  description: "A sparse 3D world editor and visual unit-test runner for turn-based puzzle physics.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = { themeColor: "#111418", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
