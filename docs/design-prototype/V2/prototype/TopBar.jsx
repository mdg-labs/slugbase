/* SlugBase — Top bar: context, command palette trigger, account */

function TopBar({ ws, count, onOpenPalette, theme, onToggleTheme, onNew }) {
  const [acct, setAcct] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setAcct(false), acct);
  return (
    <header className="topbar">
      <div className="crumbs">
        <Icon name="bookmark" size={15} style={{ color: "var(--accent-text)" }} />
        <b>Bookmarks</b>
        <Icon name="chevron-right" size={14} />
        <span>All</span>
        <span className="badge badge--neutral" style={{ marginLeft: 2 }}>{count}</span>
      </div>

      <div className="cmd-trigger" onClick={onOpenPalette}>
        <Icon name="search" size={15} />
        <span className="ph">Search bookmarks or run a command…</span>
        <Kbd>⌘K</Kbd>
      </div>

      <div className="topbar-right">
        <button className="icon-btn" title="Toggle theme" onClick={onToggleTheme}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
        </button>
        <button className="icon-btn" title="Notifications">
          <Icon name="bell" size={17} />
        </button>
        <button className="btn btn--primary btn--sm" onClick={onNew}>
          <Icon name="plus" size={15} strokeWidth={2.25} /> New bookmark
          <Kbd>C</Kbd>
        </button>
        <div style={{ position: "relative" }} ref={ref}>
          <div className="avatar" onClick={() => setAcct(a => !a)} title="Account">AK</div>
          {acct && (
            <Menu align="right" style={{ minWidth: 220 }}>
              <div style={{ padding: "8px 8px 10px", display: "flex", gap: 10, alignItems: "center" }}>
                <div className="avatar" style={{ cursor: "default" }}>AK</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Alex Kerr</div>
                  <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>alex@inboxops.app</div>
                </div>
              </div>
              <div className="menu-sep" />
              <MenuItem icon="user">Account</MenuItem>
              <MenuItem icon="sliders-horizontal">Preferences</MenuItem>
              <MenuItem icon="keyboard" hint="?">Shortcuts</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="zap">Upgrade plan</MenuItem>
              <MenuItem icon="log-out">Sign out</MenuItem>
            </Menu>
          )}
        </div>
      </div>
    </header>
  );
}

Object.assign(window, { TopBar });
