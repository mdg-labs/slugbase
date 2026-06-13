/* SlugBase — Folders page */
const lsF = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const FOLDERS_DATA = [
  { id: "inbox", name: "Inbox", color: "#7782f7", count: 6, sharing: "private", owner: "you", modified: "2h ago" },
  { id: "dev", name: "Dev Tools", color: "#45c98a", count: 9, sharing: "team", owner: "you", modified: "1d ago" },
  { id: "reading", name: "Reading List", color: "#e6b24e", count: 7, sharing: "private", owner: "you", modified: "3d ago" },
  { id: "design", name: "Design", color: "#f0686b", count: 5, sharing: "specific", sharedWith: ["Sarah K.", "Tom R."], owner: "you", modified: "5d ago" },
  { id: "infra", name: "Infra & Ops", color: "#56b6e6", count: 4, sharing: "team", owner: "you", modified: "1d ago" },
  { id: "team-resources", name: "Team Resources", color: "#7782f7", count: 14, sharing: "shared-with-me", owner: "Sarah K.", modified: "3h ago" },
  { id: "project-alpha", name: "Project Alpha", color: "#b178f7", count: 8, sharing: "shared-with-me", owner: "Tom R.", modified: "2d ago" },
];

const SCOPES = [
  { id: "all", label: "All folders", icon: "layers" },
  { id: "mine", label: "Mine", icon: "user" },
  { id: "shared-with-me", label: "Shared with me", icon: "users" },
  { id: "shared-by-me", label: "Shared by me", icon: "share-2" },
];
const SORTS = [
  { id: "alpha", label: "Alphabetical" },
  { id: "recent", label: "Recently created" },
  { id: "count", label: "Most bookmarks" },
];

function ScopeLabel({ sharing, sharedWith }) {
  if (sharing === "private") return <span className="f-sharing private"><Icon name="lock" size={12} />Private</span>;
  if (sharing === "team") return <span className="f-sharing team"><Icon name="users" size={12} />Team</span>;
  if (sharing === "specific") return <span className="f-sharing specific"><Icon name="user-plus" size={12} />{sharedWith.length} member{sharedWith.length > 1 ? "s" : ""}</span>;
  if (sharing === "shared-with-me") return <span className="f-sharing shared-with-me"><Icon name="user-plus" size={12} />Shared with you</span>;
  return null;
}

function FolderSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="sk-row" style={{ padding: "var(--sp-5) var(--sp-6)", borderRadius: "var(--r-md)" }}>
          <div className="sk" style={{ width: 12, height: 12, borderRadius: 3 }} />
          <div className="sk" style={{ width: 140, height: 13 }} />
          <div className="sk" style={{ width: 60, height: 20, borderRadius: 99, marginLeft: "auto" }} />
          <div className="sk" style={{ width: 50, height: 12 }} />
        </div>
      ))}
    </div>
  );
}

function FoldersApp() {
  const [ws, setWs] = useState(SB.workspaces[0]);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState(() => lsF("sb_theme", "dark"));
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState(FOLDERS_DATA);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("all");
  const [sort, setSort] = useState("alpha");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const scopeRef = useRef(null);
  const sortRef = useRef(null);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("sb_theme", JSON.stringify(theme)); }, [theme]);
  useEffect(() => { const t = setTimeout(() => setLoading(false), 900); return () => clearTimeout(t); }, []);
  useClickOutside(scopeRef, () => setScopeOpen(false), scopeOpen);
  useClickOutside(sortRef, () => setSortOpen(false), sortOpen);

  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(p => !p); }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === "n" && !/input|textarea/i.test(e.target.tagName)) {
        e.preventDefault(); toast({ icon: "folder-plus", title: "New folder", sub: "Name your folder to get started" });
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));
  const goTo = (id) => {
    const MAP = { dashboard: "Dashboard.html", bookmarks: "Bookmarks.html", folders: "Folders.html", tags: "Tags.html" };
    if (MAP[id]) { window.location.href = MAP[id]; }
  };

  const filtered = React.useMemo(() => {
    let r = folders.slice();
    if (scope === "mine") r = r.filter(f => f.owner === "you" && f.sharing !== "shared-with-me");
    else if (scope === "shared-with-me") r = r.filter(f => f.sharing === "shared-with-me");
    else if (scope === "shared-by-me") r = r.filter(f => f.owner === "you" && f.sharing !== "private");
    if (q) r = r.filter(f => f.name.toLowerCase().includes(q.toLowerCase()));
    if (sort === "alpha") r.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "count") r.sort((a, b) => b.count - a.count);
    return r;
  }, [folders, scope, sort, q]);

  const deleteFolder = (id) => {
    const f = folders.find(x => x.id === id);
    setFolders(fs => fs.filter(x => x.id !== id));
    toast({ icon: "trash-2", title: `Deleted "${f.name}"`, sub: `${f.count} bookmarks moved to Inbox` });
  };

  const currentScope = SCOPES.find(s => s.id === scope);
  const currentSort = SORTS.find(s => s.id === sort);

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav="folders" setNav={goTo}
        folders={SB.folders} activeFolder={null} setFolder={() => {}}
        totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => {}} />

      <main className="main">
        <TopBar ws={ws} count={filtered.length} crumbIcon="folder" crumbLabel="Folders" crumbSub="All"
          onOpenPalette={() => setPalette(true)} theme={theme}
          onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onNew={() => toast({ icon: "folder-plus", title: "New folder" })} />

        {/* Toolbar */}
        <div className="toolbar">
          <div className="field" style={{ width: 240 }}>
            <Icon name="search" size={15} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search folders…" />
            {q && <span style={{ cursor: "pointer", color: "var(--fg-faint)" }} onClick={() => setQ("")}><Icon name="x" size={14} /></span>}
          </div>

          {/* Scope dropdown */}
          <div style={{ position: "relative" }} ref={scopeRef}>
            <button className={"chip" + (scope !== "all" ? " on" : "")} onClick={() => setScopeOpen(o => !o)}>
              <Icon name={currentScope.icon} size={14} />{currentScope.label}
              <Icon name="chevron-down" size={13} className="ic-r" />
            </button>
            {scopeOpen && (
              <div className="menu" style={{ left: 0, top: "calc(100% + 6px)", minWidth: 200 }}>
                <div className="menu-head">Scope</div>
                {SCOPES.map(s => (
                  <MenuItem key={s.id} icon={s.icon} check={scope === s.id}
                    onClick={() => { setScope(s.id); setScopeOpen(false); }}>{s.label}</MenuItem>
                ))}
              </div>
            )}
          </div>

          <div className="toolbar-spacer" />
          <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>
            {filtered.length} folder{filtered.length !== 1 ? "s" : ""}
          </span>

          {/* Sort dropdown */}
          <div style={{ position: "relative" }} ref={sortRef}>
            <button className="chip" onClick={() => setSortOpen(o => !o)}>
              <Icon name="arrow-up-down" size={14} />{currentSort.label}
              <Icon name="chevron-down" size={13} className="ic-r" />
            </button>
            {sortOpen && (
              <div className="menu" style={{ right: 0, top: "calc(100% + 6px)", minWidth: 200 }}>
                <div className="menu-head">Sort by</div>
                {SORTS.map(s => (
                  <MenuItem key={s.id} check={sort === s.id}
                    onClick={() => { setSort(s.id); setSortOpen(false); }}>{s.label}</MenuItem>
                ))}
              </div>
            )}
          </div>

          <button className="btn btn--primary btn--sm" onClick={() => toast({ icon: "folder-plus", title: "New folder" })}>
            <Icon name="folder-plus" size={15} />New folder<Kbd>N</Kbd>
          </button>
        </div>

        <div className="content">
          {loading ? <FolderSkeleton /> : filtered.length === 0 ? (
            <div className="folder-empty">
              <Icon name="folder-open" size={40} strokeWidth={1.25} />
              <h3>{q || scope !== "all" ? "No folders match" : "No folders yet"}</h3>
              <p>{q || scope !== "all" ? "Try a different search or scope filter." : "Create a folder to organise your bookmarks."}</p>
              {!q && scope === "all" && <button className="btn btn--primary" onClick={() => toast({ icon: "folder-plus", title: "New folder" })}><Icon name="folder-plus" size={15} />New folder</button>}
              {(q || scope !== "all") && <button className="btn btn--secondary" onClick={() => { setQ(""); setScope("all"); }}><Icon name="filter-x" size={15} />Clear filters</button>}
            </div>
          ) : (
            <div className="folder-list">
              {filtered.map(f => (
                <FolderRow key={f.id} f={f}
                  onOpen={() => goTo("bookmarks")}
                  onEdit={() => toast({ icon: "pencil", title: `Edit "${f.name}"` })}
                  onShare={() => toast({ icon: "share-2", title: `Share "${f.name}"` })}
                  onDelete={() => deleteFolder(f.id)} />
              ))}
            </div>
          )}
        </div>
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} bookmarks={SB.bookmarks} onAction={() => {}} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

function FolderRow({ f, onOpen, onEdit, onShare, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setMenuOpen(false), menuOpen);
  return (
    <div className="folder-row" onDoubleClick={onOpen}>
      <span className="f-dot" style={{ background: f.color }} />
      <span className="f-name">{f.name}</span>
      <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
        {f.count} bookmark{f.count !== 1 ? "s" : ""}
      </span>
      <ScopeLabel sharing={f.sharing} sharedWith={f.sharedWith} />
      {f.sharing === "shared-with-me" && (
        <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", display: "flex", alignItems: "center", gap: 4 }}>
          <Icon name="user" size={12} />{f.owner}
        </span>
      )}
      <span className="f-modified">{f.modified}</span>
      <div className="f-actions" ref={ref}>
        <button className="icon-btn icon-btn--sm" title="Open" onClick={onOpen}><Icon name="external-link" size={15} /></button>
        <button className="icon-btn icon-btn--sm" title="Edit" onClick={onEdit}><Icon name="pencil" size={15} /></button>
        <button className="icon-btn icon-btn--sm" title="Share" onClick={onShare}><Icon name="share-2" size={15} /></button>
        <div style={{ position: "relative" }}>
          <button className="icon-btn icon-btn--sm" title="More" onClick={() => setMenuOpen(o => !o)}><Icon name="more-horizontal" size={15} /></button>
          {menuOpen && (
            <div className="menu" style={{ right: 0, top: "calc(100% + 4px)", minWidth: 180 }}>
              <MenuItem icon="external-link" onClick={() => { onOpen(); setMenuOpen(false); }}>Open in Bookmarks</MenuItem>
              <MenuItem icon="pencil" onClick={() => { onEdit(); setMenuOpen(false); }}>Rename</MenuItem>
              <MenuItem icon="share-2" onClick={() => { onShare(); setMenuOpen(false); }}>Share settings</MenuItem>
              <div className="menu-sep" />
              <MenuItem icon="trash-2" danger onClick={() => { onDelete(); setMenuOpen(false); }}>Delete folder</MenuItem>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<FoldersApp />);
