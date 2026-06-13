/* SlugBase — Sidebar: workspace switcher, nav, entitlement meter */

function WorkspaceSwitcher({ ws, all, onSwitch }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <div className="ws-switch" onClick={() => setOpen(o => !o)}>
        <span className="ws-logo"><img src="../assets/slugbase_icon.svg" alt="" /></span>
        <span className="ws-meta">
          <div className="ws-name">{ws.name}</div>
          <div className="ws-plan">{ws.plan} plan</div>
        </span>
        <Icon name="chevrons-up-down" size={15} style={{ color: "var(--fg-subtle)" }} />
      </div>
      {open && (
        <Menu style={{ left: 12, right: 12, top: "calc(100% - 4px)", minWidth: 0 }}>
          <div className="menu-head">Workspaces</div>
          {all.map(w => (
            <MenuItem key={w.id} onClick={() => { onSwitch(w); setOpen(false); }}
              check={w.id === ws.id}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, background: w.color,
                  color: "#0b0c14", display: "grid", placeItems: "center", fontSize: 11,
                  fontWeight: 700 }}>{w.letter}</span>
                {w.name}
              </span>
            </MenuItem>
          ))}
          <div className="menu-sep" />
          <MenuItem icon="plus">New workspace</MenuItem>
          <MenuItem icon="settings-2">Workspace settings</MenuItem>
        </Menu>
      )}
    </div>
  );
}

function NavItem({ icon, dot, label, count, active, onClick }) {
  return (
    <div className={"nav-item" + (active ? " active" : "")} onClick={onClick}>
      {icon && <Icon name={icon} size={16} />}
      {dot && <span className="folder-dot" style={{ background: dot }} />}
      <span>{label}</span>
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

function Sidebar({ ws, onSwitch, nav, setNav, folders, activeFolder, setFolder, totalCount, plan, onUpgrade, archivedCount = 0 }) {
  const pct = Math.min(100, Math.round((plan.used / plan.cap) * 100));
  const meterCls = pct >= 100 ? "full" : pct >= 90 ? "warn" : "";
  return (
    <aside className="sidebar">
      <WorkspaceSwitcher ws={ws} all={SB.workspaces} onSwitch={onSwitch} />

      <nav className="nav">
        <NavItem icon="home" label="Home" active={nav === "dashboard"} onClick={() => setNav("dashboard")} />
        <NavItem icon="bookmark" label="Bookmarks" count={totalCount}
          active={nav === "bookmarks"} onClick={() => setNav("bookmarks")} />
        <NavItem icon="folder" label="Folders" active={nav === "folders"} onClick={() => setNav("folders")} />
        <NavItem icon="hash" label="Tags" active={nav === "tags"} onClick={() => setNav("tags")} />
        <NavItem icon="link" label="Forwarding" active={nav === "fwd"} onClick={() => setNav("fwd")} />

        <div className="nav-label">Folders</div>
        <div className="nav-sub">
          {folders.map(f => (
            <NavItem key={f.id} dot={f.color} label={f.name} count={f.count}
              active={nav === "bookmarks" && activeFolder === f.id}
              onClick={() => { setNav("bookmarks"); setFolder(activeFolder === f.id ? null : f.id); }} />
          ))}
        </div>

        <div className="nav-label">Account</div>
        <NavItem icon="settings" label="Settings" active={nav === "settings"} onClick={() => setNav("settings")} />
        <NavItem icon="users-round" label="Members" active={nav === "members"} onClick={() => setNav("members")} />
      </nav>

      <div className="sidebar-foot">
        {archivedCount > 0 && (
          <div className="sidebar-archived" onClick={() => setNav("billing")}>
            <Icon name="archive" size={14}/>{archivedCount} bookmarks archived — upgrade to restore
          </div>
        )}
        {plan.name === "Free" && (
          <div className="usage">
            <div className="usage-top">
              <span className="usage-count"><b>{plan.used}</b> / {plan.cap}</span>
              <span className="usage-cap">bookmarks</span>
            </div>
            <div className={"meter " + meterCls}><i style={{ width: pct + "%" }} /></div>
            <div className="usage-cta">
              {pct >= 100
                ? <span><Icon name="alert-triangle" size={12} style={{ color: "var(--danger-text)", marginRight: 4, verticalAlign: "-2px" }} />Limit reached — <a onClick={onUpgrade}>Upgrade</a></span>
                : <span>{plan.cap - plan.used} left on Free — <a onClick={onUpgrade}>Upgrade to Pro</a></span>}
            </div>
          </div>
        )}
        <NavItem icon="life-buoy" label="Help & docs" />
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar });
