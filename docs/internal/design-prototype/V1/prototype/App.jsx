/* SlugBase — App root: state, filtering, selection, shortcuts, entitlement */

function SectionHead({ icon, label, count }) {
  return (
    <div className="section-head">
      {icon && <Icon name={icon} size={15} />}
      <span className="t-label">{label}</span>
      {count != null && <span className="badge badge--neutral">{count}</span>}
      <span className="rule" />
    </div>
  );
}

function UpsellModal({ plan, onClose }) {
  return (
    <div className="scrim" onMouseDown={onClose} style={{ alignItems: "center", paddingTop: 0 }}>
      <div className="palette" style={{ width: "min(440px, 92vw)", padding: 0 }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: "28px 28px 22px" }}>
          <div className="upsell-ic" style={{ width: 44, height: 44, marginBottom: 18 }}><Icon name="zap" size={22} strokeWidth={2.25} /></div>
          <h2 className="t-h1" style={{ margin: "0 0 8px" }}>You're near your Free limit</h2>
          <p className="t-body" style={{ color: "var(--fg-muted)", margin: 0, lineHeight: 1.55 }}>
            You've used <b style={{ color: "var(--fg)" }}>{plan.used}</b> of <b style={{ color: "var(--fg)" }}>{plan.cap}</b> bookmarks on the
            Free plan. Upgrade to <b style={{ color: "var(--accent-text)" }}>Pro</b> for unlimited bookmarks,
            custom forwarding domains, and shared workspaces.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            <button className="btn btn--primary" style={{ flex: 1 }}><Icon name="zap" size={15} />Upgrade to Pro — $6/mo</button>
            <button className="btn btn--secondary" onClick={onClose}>Maybe later</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

  const [theme, setTheme] = useState(() => ls("sb_theme", "dark"));
  const [view, setView] = useState(() => ls("sb_view", "grid"));
  const [loading, setLoading] = useState(true);
  const [nav, setNav] = useState("bookmarks");
  const goTo = (id) => {
    const PAGES = { dashboard: "Dashboard.html", bookmarks: "Bookmarks.html", folders: "Folders.html", tags: "Tags.html" };
    if (PAGES[id]) { window.location.href = PAGES[id]; return; }
    setNav(id);
  };
  const [ws, setWs] = useState(SB.workspaces[0]);
  const [bookmarks, setBookmarks] = useState(SB.bookmarks);
  const [plan] = useState(SB.plan);

  const [f, setF] = useState({ q: "", folder: null, tags: [], pinnedOnly: false, scope: "all", sort: "recent" });
  const set = (patch) => { setF(p => ({ ...p, ...patch })); setPage(0); setSel(new Set()); setSelAll(false); };

  const [sel, setSel] = useState(new Set());
  const [selAll, setSelAll] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => ls("sb_psize", 12));
  const [palette, setPalette] = useState(false);
  const [upsell, setUpsell] = useState(false);
  const [toasts, setToasts] = useState([]);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("sb_theme", JSON.stringify(theme)); }, [theme]);
  useEffect(() => { localStorage.setItem("sb_view", JSON.stringify(view)); }, [view]);
  useEffect(() => { localStorage.setItem("sb_psize", JSON.stringify(pageSize)); }, [pageSize]);
  useEffect(() => { const t = setTimeout(() => setLoading(false), 1100); return () => clearTimeout(t); }, []);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));

  /* ----- filter + sort ----- */
  const filtered = React.useMemo(() => {
    let r = bookmarks.slice();
    if (f.folder) r = r.filter(b => b.folder === f.folder);
    if (f.tags.length) r = r.filter(b => f.tags.every(t => b.tags.includes(t)));
    if (f.pinnedOnly) r = r.filter(b => b.pinned);
    if (f.scope !== "all") r = r.filter(b => b.scope === f.scope);
    if (f.q) { const q = f.q.toLowerCase(); r = r.filter(b => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || (b.slug || "").includes(q)); }
    const cmp = {
      recent: (a, b) => b.id - a.id,
      alpha: (a, b) => a.title.localeCompare(b.title),
      used: (a, b) => b.hits - a.hits,
      accessed: (a, b) => parseLast(a.last) - parseLast(b.last),
    }[f.sort];
    r.sort(cmp);
    // pinned-first (stable) unless filtering by pinned only
    if (!f.pinnedOnly) r.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return r;
  }, [bookmarks, f]);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const curPage = Math.min(page, pages - 1);
  const start = total === 0 ? 0 : curPage * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  /* ----- selection ----- */
  const selCount = selAll ? total : sel.size;
  const pageIds = pageItems.map(b => b.id);
  const allPageSel = pageIds.length > 0 && pageIds.every(id => selAll || sel.has(id));
  const somePageSel = pageIds.some(id => selAll || sel.has(id));

  const toggleOne = (id, on) => {
    setSelAll(false);
    setSel(prev => {
      const n = new Set(selAll ? filtered.map(b => b.id) : prev);
      on ? n.add(id) : n.delete(id);
      return n;
    });
  };
  const toggleAllPage = () => {
    setSelAll(false);
    setSel(prev => {
      const n = new Set(prev);
      if (allPageSel) pageIds.forEach(id => n.delete(id));
      else pageIds.forEach(id => n.add(id));
      return n;
    });
  };
  const selectAllPages = () => { setSelAll(true); setSel(new Set(filtered.map(b => b.id))); };
  const clearSel = () => { setSel(new Set()); setSelAll(false); };

  const togglePin = (id) => {
    setBookmarks(bs => bs.map(b => b.id === id ? { ...b, pinned: !b.pinned } : b));
    const b = bookmarks.find(x => x.id === id);
    toast({ icon: b.pinned ? "pin-off" : "pin", title: b.pinned ? "Unpinned" : "Pinned to top", sub: b.title });
  };

  const bulkAct = (kind) => {
    const n = selCount;
    if (kind === "delete") { const ids = selAll ? new Set(filtered.map(b => b.id)) : sel; setBookmarks(bs => bs.filter(b => !ids.has(b.id))); toast({ icon: "trash-2", title: `Deleted ${n} bookmark${n > 1 ? "s" : ""}` }); }
    else if (kind === "pin") { const ids = selAll ? new Set(filtered.map(b => b.id)) : sel; setBookmarks(bs => bs.map(b => ids.has(b.id) ? { ...b, pinned: true } : b)); toast({ icon: "pin", title: `Pinned ${n} bookmark${n > 1 ? "s" : ""}` }); }
    else { const verb = { move: "Moved", tag: "Tagged", share: "Shared" }[kind]; toast({ icon: kind === "move" ? "folder-input" : kind === "tag" ? "hash" : "share-2", title: `${verb} ${n} bookmark${n > 1 ? "s" : ""}` }); }
    clearSel();
  };

  const newBookmark = () => {
    if (plan.name === "Free" && plan.used >= plan.cap) { setUpsell(true); return; }
    toast({ kind: "info", icon: "bookmark-plus", title: "New bookmark", sub: "Paste a URL and assign a slug" });
  };

  /* ----- keyboard shortcuts ----- */
  useEffect(() => {
    function onKey(e) {
      const typing = /input|textarea/i.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(p => !p); return; }
      if (typing) return;
      if (e.key === "Escape") { clearSel(); return; }
      if (e.key === "c" || e.key === "C") { e.preventDefault(); newBookmark(); }
      if (e.key === "g" || e.key === "G") setView("grid");
      if (e.key === "t" || e.key === "T") setView("table");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [plan, filtered]);

  const clearFilters = () => set({ q: "", folder: null, tags: [], pinnedOnly: false, scope: "all" });

  const onPaletteAction = (it) => {
    if (it.type === "bm") { toast({ kind: "info", icon: "external-link", title: "Opening", sub: it.data.title }); return; }
    const id = it.data.id;
    if (id === "new") newBookmark();
    else if (id === "grid") setView("grid");
    else if (id === "table") setView("table");
    else if (id === "pinned") set({ pinnedOnly: true });
    else toast({ kind: "info", icon: it.data.icon, title: it.data.title });
  };

  /* ----- render ----- */
  const pinnedPage = pageItems.filter(b => b.pinned);
  const restPage = pageItems.filter(b => !b.pinned);
  const splitPinned = curPage === 0 && pinnedPage.length > 0 && !f.pinnedOnly && view === "grid";
  const remaining = plan.cap - plan.used;

  const cardOf = (b) => (
    <BookmarkCard key={b.id} b={b} selected={selAll || sel.has(b.id)}
      onSelect={(on) => toggleOne(b.id, on)} onPin={() => togglePin(b.id)} />
  );

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav={nav} setNav={goTo}
        folders={SB.folders} activeFolder={f.folder} setFolder={(id) => set({ folder: id })}
        totalCount={bookmarks.length} plan={plan} onUpgrade={() => setUpsell(true)} />

      <main className="main" style={{ position: "relative" }}>
        <TopBar ws={ws} count={total} onOpenPalette={() => setPalette(true)}
          theme={theme} onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")} onNew={newBookmark} />

        <Toolbar f={f} set={set} view={view} setView={setView}
          folders={SB.folders} allTags={SB.tags} resultCount={total} onClear={clearFilters} />

        {plan.name === "Free" && remaining <= 10 && !loading && (
          <div className="upsell">
            <span className="upsell-ic"><Icon name="zap" size={18} strokeWidth={2.25} /></span>
            <div className="upsell-txt">
              <b>{remaining} bookmark{remaining !== 1 ? "s" : ""} left on Free</b>
              <p>You're approaching the {plan.cap}-bookmark cap. Upgrade to Pro for unlimited saves and custom slugs.</p>
            </div>
            <button className="btn btn--primary btn--sm" onClick={() => setUpsell(true)}>Upgrade</button>
          </div>
        )}

        <div className="content">
          {loading ? <SkeletonGrid />
            : pageItems.length === 0
              ? <EmptyState filtered={bookmarks.length > 0} onClear={clearFilters} onNew={newBookmark} />
              : view === "grid"
                ? (splitPinned ? (<>
                    <SectionHead icon="pin" label="Pinned" count={pinnedPage.length} />
                    <div className="grid">{pinnedPage.map(cardOf)}</div>
                    {restPage.length > 0 && <SectionHead label="All bookmarks" />}
                    <div className="grid" style={{ marginTop: 16 }}>{restPage.map(cardOf)}</div>
                  </>) : <div className="grid">{pageItems.map(cardOf)}</div>)
                : (<div className="table">
                    <TableHead sort={f.sort} setSort={(s) => set({ sort: s })}
                      allSel={allPageSel} someSel={somePageSel} onToggleAll={toggleAllPage} />
                    <div style={{ marginTop: 6 }}>
                      {pageItems.map(b => (
                        <BookmarkRow key={b.id} b={b} selected={selAll || sel.has(b.id)} sort={f.sort}
                          onSelect={(on) => toggleOne(b.id, on)} onPin={() => togglePin(b.id)} />
                      ))}
                    </div>
                  </div>)}
        </div>

        {!loading && total > 0 && (
          <Pager page={curPage} pages={pages} pageSize={pageSize} total={total}
            start={start + 1} end={Math.min(start + pageSize, total)}
            setPage={setPage} setPageSize={(n) => { setPageSize(n); setPage(0); }} />
        )}

        {selCount > 0 && (
          <BulkBar count={selCount} total={total} allSelected={selAll || selCount >= total}
            onSelectAll={selectAllPages} onClear={clearSel} onAct={bulkAct} />
        )}
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} bookmarks={bookmarks} onAction={onPaletteAction} />}
      {upsell && <UpsellModal plan={plan} onClose={() => setUpsell(false)} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

function parseLast(s) { const n = parseFloat(s); if (s.includes("h")) return n; if (s.includes("d")) return n * 24; return n; }

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
