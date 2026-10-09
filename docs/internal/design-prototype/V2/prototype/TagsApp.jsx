/* SlugBase — Tags page */
const lsT = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const TAG_SORTS = [
  { id: "used", label: "Most used" },
  { id: "alpha", label: "Alphabetical" },
  { id: "recent", label: "Recently created" },
];

function TagSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="sk-row" style={{ padding: "var(--sp-4)", borderRadius: "var(--r-md)", display: "grid", gridTemplateColumns: "1fr 180px 90px 90px", gap: "var(--sp-5)", alignItems: "center" }}>
          <div className="sk" style={{ width: 80 + i * 12, height: 12 }} />
          <div className="sk" style={{ height: 5, borderRadius: 99 }} />
          <div className="sk" style={{ width: 28, height: 12, margin: "0 auto" }} />
          <div className="sk" style={{ width: 50, height: 22, borderRadius: 99, marginLeft: "auto" }} />
        </div>
      ))}
    </div>
  );
}

function TagsApp() {
  const [ws, setWs] = useState(SB.workspaces[0]);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState(() => lsT("sb_theme", "dark"));
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState("used");
  const [q, setQ] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [selected, setSelected] = useState(null); // selected tag name
  const [tags, setTags] = useState(SB.tags);
  const [renaming, setRenaming] = useState(null); // tag name being renamed
  const [renameVal, setRenameVal] = useState("");
  const [delConfirm, setDelConfirm] = useState(null); // tag name pending delete
  const sortRef = useRef(null);
  const renameRef = useRef(null);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("sb_theme", JSON.stringify(theme)); }, [theme]);
  useEffect(() => { const t = setTimeout(() => setLoading(false), 900); return () => clearTimeout(t); }, []);
  useClickOutside(sortRef, () => setSortOpen(false), sortOpen);

  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(p => !p); }
      if (e.key === "Escape") { setSelected(null); setRenaming(null); setDelConfirm(null); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  // Focus rename input when renaming starts
  useEffect(() => { if (renaming && renameRef.current) renameRef.current.focus(); }, [renaming]);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));
  const goTo = (id) => {
    const MAP = { dashboard: "Dashboard.html", bookmarks: "Bookmarks.html", folders: "Folders.html", tags: "Tags.html" };
    if (MAP[id]) { window.location.href = MAP[id]; }
  };

  const tagCounts = React.useMemo(() => {
    const c = {};
    SB.bookmarks.forEach(b => b.tags.forEach(t => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, []);

  const maxCount = Math.max(...Object.values(tagCounts), 1);

  const sortedTags = React.useMemo(() => {
    let r = tags.filter(t => !q || t.includes(q.toLowerCase()));
    if (sort === "used") r.sort((a, b) => (tagCounts[b] || 0) - (tagCounts[a] || 0));
    else if (sort === "alpha") r.sort((a, b) => a.localeCompare(b));
    return r;
  }, [tags, sort, q, tagCounts]);

  const selectedBMs = React.useMemo(() =>
    selected ? SB.bookmarks.filter(b => b.tags.includes(selected)) : []
  , [selected]);

  const startRename = (tag, e) => { e.stopPropagation(); setRenaming(tag); setRenameVal(tag); setDelConfirm(null); };
  const commitRename = () => {
    if (!renameVal.trim() || renameVal === renaming) { setRenaming(null); return; }
    setTags(ts => ts.map(t => t === renaming ? renameVal.trim() : t));
    if (selected === renaming) setSelected(renameVal.trim());
    toast({ icon: "pencil", title: `Renamed #${renaming} → #${renameVal.trim()}` });
    setRenaming(null);
  };
  const confirmDelete = (tag, e) => { e.stopPropagation(); setDelConfirm(tag); setRenaming(null); };
  const doDelete = (tag) => {
    setTags(ts => ts.filter(t => t !== tag));
    if (selected === tag) setSelected(null);
    toast({ icon: "trash-2", title: `Deleted #${tag}`, sub: `${tagCounts[tag] || 0} bookmarks untagged` });
    setDelConfirm(null);
  };

  const currentSort = TAG_SORTS.find(s => s.id === sort);
  const hasPanel = !!selected;

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav="tags" setNav={goTo}
        folders={SB.folders} activeFolder={null} setFolder={() => {}}
        totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => {}} />

      <main className="main" style={{ overflow: "hidden" }}>
        <TopBar ws={ws} count={sortedTags.length} crumbIcon="hash" crumbLabel="Tags" crumbSub="All"
          onOpenPalette={() => setPalette(true)} theme={theme}
          onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onNew={() => toast({ icon: "hash", title: "New tag" })} />

        {/* Toolbar */}
        <div className="toolbar">
          <div className="field" style={{ width: 220 }}>
            <Icon name="search" size={15} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search tags…" />
            {q && <span style={{ cursor: "pointer", color: "var(--fg-faint)" }} onClick={() => setQ("")}><Icon name="x" size={14} /></span>}
          </div>
          <div className="toolbar-spacer" />
          <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>
            {sortedTags.length} tag{sortedTags.length !== 1 ? "s" : ""}
          </span>
          <div style={{ position: "relative" }} ref={sortRef}>
            <button className="chip" onClick={() => setSortOpen(o => !o)}>
              <Icon name="arrow-up-down" size={14} />{currentSort.label}
              <Icon name="chevron-down" size={13} className="ic-r" />
            </button>
            {sortOpen && (
              <div className="menu" style={{ right: 0, top: "calc(100% + 6px)", minWidth: 190 }}>
                <div className="menu-head">Sort by</div>
                {TAG_SORTS.map(s => (
                  <MenuItem key={s.id} check={sort === s.id} onClick={() => { setSort(s.id); setSortOpen(false); }}>{s.label}</MenuItem>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn--primary btn--sm" onClick={() => toast({ icon: "hash", title: "New tag" })}>
            <Icon name="plus" size={15} />New tag
          </button>
        </div>

        {/* Two-panel layout */}
        <div className="tags-layout" style={{ gridTemplateColumns: hasPanel ? "1fr 360px" : "1fr" }}>
          <div className="tags-list-col">
            {loading ? <TagSkeleton /> : sortedTags.length === 0 ? (
              <div className="tags-placeholder">
                <Icon name="hash" size={36} strokeWidth={1.25} />
                <p>{q ? `No tags match "${q}"` : "No tags yet — create one to start organizing."}</p>
                {q && <button className="btn btn--secondary btn--sm" onClick={() => setQ("")}><Icon name="x" size={13} />Clear search</button>}
              </div>
            ) : (
              <div className="tag-table">
                <div className="tag-thead">
                  {["alpha", "used"].map((id, i) => (
                    <div key={id + i} className={sort === (i === 0 ? "alpha" : "used") ? "sorted" : ""}
                      onClick={() => { setSort(i === 0 ? "alpha" : "used"); }}
                      style={{ cursor: "pointer" }}>
                      {i === 0 ? "Tag" : i === 1 ? "Usage" : ""}
                      {sort === (i === 0 ? "alpha" : "used") && <Icon name="arrow-down" size={12} />}
                    </div>
                  ))}
                  <div style={{ cursor: "pointer" }} className={sort === "used" ? "sorted" : ""} onClick={() => setSort("used")}>
                    Count {sort === "used" && <Icon name="arrow-down" size={12} />}
                  </div>
                  <div />
                </div>
                <div>
                  {sortedTags.map(tag => {
                    const cnt = tagCounts[tag] || 0;
                    const pct = Math.round((cnt / maxCount) * 100);
                    const isRenaming = renaming === tag;
                    const isDeleting = delConfirm === tag;
                    return (
                      <div key={tag}>
                        <div className={"tag-trow" + (selected === tag ? " on" : "")}
                          onClick={() => { if (!isRenaming) { setSelected(s => s === tag ? null : tag); setDelConfirm(null); } }}>
                          <div className="tag-name-cell">
                            {isRenaming ? (
                              <input ref={renameRef} className="tag-rename-input" value={renameVal}
                                onChange={e => setRenameVal(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                                onBlur={commitRename} onClick={e => e.stopPropagation()} />
                            ) : tag}
                          </div>
                          <div>
                            <div className="tag-usage-bar">
                              <div className="tag-usage-fill" style={{ width: pct + "%" }} />
                            </div>
                          </div>
                          <div className="tag-count-cell" style={{ textAlign: "center" }}>{cnt}</div>
                          <div className="tag-row-actions">
                            <button className="icon-btn icon-btn--sm" title="Rename" onClick={e => startRename(tag, e)}><Icon name="pencil" size={14} /></button>
                            <button className="icon-btn icon-btn--sm" title="Delete" onClick={e => confirmDelete(tag, e)} style={{ color: "var(--danger-text)" }}><Icon name="trash-2" size={14} /></button>
                          </div>
                        </div>
                        {isDeleting && (
                          <div className="tag-del-confirm">
                            <Icon name="alert-triangle" size={14} />
                            <span>Delete <b>#{tag}</b>? This will untag <b>{cnt}</b> bookmark{cnt !== 1 ? "s" : ""}.</span>
                            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                              <button className="btn btn--danger btn--sm" onClick={() => doDelete(tag)}>Delete</button>
                              <button className="btn btn--ghost btn--sm" onClick={() => setDelConfirm(null)}>Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Tag detail panel */}
          {hasPanel && (
            <div className="tags-detail" key={selected}>
              <div className="tags-detail-head">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--sp-4)" }}>
                  <span className="tag-name-lg">{selected}</span>
                  <button className="icon-btn icon-btn--sm" onClick={() => setSelected(null)} title="Close"><Icon name="x" size={15} /></button>
                </div>
                <div style={{ display: "flex", gap: "var(--sp-5)", fontSize: "var(--text-small)", color: "var(--fg-muted)" }}>
                  <span><b style={{ color: "var(--fg)", fontFamily: "var(--font-mono)" }}>{selectedBMs.length}</b> bookmark{selectedBMs.length !== 1 ? "s" : ""}</span>
                  <span style={{ color: "var(--fg-faint)" }}>•</span>
                  <span>User-private</span>
                </div>
              </div>
              <div className="tags-detail-body">
                {selectedBMs.length === 0 ? (
                  <div className="tags-placeholder" style={{ padding: "32px 0" }}>
                    <Icon name="hash" size={28} strokeWidth={1.25} />
                    <p>No bookmarks tagged <b>#{selected}</b> yet.</p>
                  </div>
                ) : selectedBMs.map(b => (
                  <div key={b.id} className="tag-bm-item" onClick={() => toast({ icon: "external-link", title: "Opening", sub: b.title })}>
                    <Favicon b={b} size={24} />
                    <div className="tag-bm-info">
                      <div className="tag-bm-title">{b.title}</div>
                      <div className="tag-bm-url">{b.url}</div>
                    </div>
                    {b.slug && <span className="slug-line" style={{ fontSize: 11, flexShrink: 0 }}><Icon name="link" size={11} /><span className="addr">{SB.FWD}/{b.slug}</span></span>}
                  </div>
                ))}
              </div>
              <div className="tags-detail-actions">
                <button className="btn btn--secondary btn--sm" onClick={() => goTo("bookmarks")}><Icon name="external-link" size={14} />View all in Bookmarks</button>
                <button className="btn btn--ghost btn--sm" onClick={e => startRename(selected, { stopPropagation: () => {} })}><Icon name="pencil" size={14} />Rename</button>
                <button className="btn btn--ghost btn--sm" style={{ color: "var(--danger-text)" }} onClick={e => confirmDelete(selected, { stopPropagation: () => {} })}><Icon name="trash-2" size={14} />Delete</button>
              </div>
            </div>
          )}
        </div>
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} bookmarks={SB.bookmarks} onAction={() => {}} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<TagsApp />);
