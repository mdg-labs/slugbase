import { Link, useLocation } from "react-router";

import type { CSSProperties, ReactNode } from "react";

const shellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "220px 1fr",
  minHeight: "100%",
};

const sidebarStyle: CSSProperties = {
  background: "var(--base)",
  borderRight: "1px solid var(--border-subtle)",
  padding: "var(--sp-6) var(--sp-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--sp-6)",
};

const brandStyle: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: 600,
  margin: 0,
};

const taglineStyle: CSSProperties = {
  margin: "var(--sp-1) 0 0",
  fontSize: "var(--text-xs)",
  color: "var(--fg-subtle)",
  lineHeight: 1.4,
};

const navStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--sp-1)",
};

const navLinkStyle = (active: boolean): CSSProperties => ({
  display: "block",
  padding: "var(--sp-2) var(--sp-3)",
  borderRadius: "var(--radius-sm)",
  color: active ? "var(--fg)" : "var(--fg-muted)",
  background: active ? "var(--accent-subtle)" : "transparent",
  textDecoration: "none",
  fontSize: "var(--text-sm)",
  fontWeight: active ? 500 : 400,
});

const mainStyle: CSSProperties = {
  padding: "var(--sp-6) var(--sp-8)",
  overflow: "auto",
};

const footerStyle: CSSProperties = {
  marginTop: "auto",
  paddingTop: "var(--sp-4)",
  borderTop: "1px solid var(--border-subtle)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-subtle)",
};

export type NavItem = {
  to: string;
  label: string;
  end?: boolean;
};

export function AppShell({
  navItems,
  userEmail,
  onLogout,
  children,
}: {
  navItems: NavItem[];
  userEmail: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  const location = useLocation();

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <div>
          <h1 style={brandStyle}>SlugBase Admin</h1>
          <p style={taglineStyle}>Platform operator — not workspace admin</p>
        </div>
        <nav style={navStyle} aria-label="Main">
          {navItems.map((item) => {
            const active = item.end
              ? location.pathname === item.to
              : location.pathname === item.to ||
                location.pathname.startsWith(`${item.to}/`);
            return (
              <Link key={item.to} to={item.to} style={navLinkStyle(active)}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div style={footerStyle}>
          <div>{userEmail}</div>
          <button
            type="button"
            onClick={onLogout}
            style={{
              marginTop: "var(--sp-2)",
              background: "none",
              border: "none",
              color: "var(--accent-text)",
              padding: 0,
              fontSize: "var(--text-xs)",
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main style={mainStyle}>{children}</main>
    </div>
  );
}
