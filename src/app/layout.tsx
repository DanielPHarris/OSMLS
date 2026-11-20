import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "./actions";
import { getCurrentMember } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "OSMLS",
  description: "An open-source MLS platform",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const current = await getCurrentMember();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-white print:hidden">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/search" className="text-lg font-bold text-brand">
              OSMLS
            </Link>
            {current && (
              <>
                <nav className="flex gap-4 text-sm font-medium">
                  <Link href="/search">Search</Link>
                  <Link href="/saved-searches">Saved searches</Link>
                  <Link href="/collections">Collections</Link>
                  {current.OsmlsRole === "agent" && (
                    <>
                      <Link href="/search?mine=1&s=1">My listings</Link>
                      <Link href="/listings/new">New listing</Link>
                    </>
                  )}
                  {current.OsmlsRole === "staff" && (
                    <>
                      <Link href="/admin/members">Members</Link>
                      <Link href="/admin/offices">Offices</Link>
                    </>
                  )}
                </nav>
                <div className="ml-auto flex items-center gap-3 text-sm">
                  <span className="text-muted">
                    {current.MemberFullName} · {current.OsmlsRole === "staff" ? "MLS staff" : "Agent"}
                  </span>
                  <form action={signOut}>
                    <button className="btn-secondary !px-3 !py-1">Sign out</button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-muted print:hidden">
          OSMLS 0.1 development build. All people, offices, and listings are synthetic demo data.
        </footer>
      </body>
    </html>
  );
}
