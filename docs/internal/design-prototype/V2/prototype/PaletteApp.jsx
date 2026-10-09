/* SlugBase — Command Palette demo page: all 4 states */
const lsP = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const PAL_ACTIONS = [
  { id: "new-bm", group: "Create", icon: "plus", title: "New bookmark", hint: "C" },
  { id: "new-folder", group: "Create", icon: "folder-plus", title: "New folder", hint: "F" },
  { id: "new-tag", group: "Create", icon: "hash", title: "New tag" },
  { id: "go-bookmarks", group: "Go to", icon: "bookmark", title: "Go to Bookmarks" },
  { id: "go-folders", group: "Go to", icon: "folder", title: "Go to Folders" },
  { id: "go-tags", group: "Go to", icon: "hash", title: "Go to Tags" },
  { id: "go-settings", group: "Go to", icon: "settings", title: "Go to Settings" },
  { id: "switch-ws", group: "Workspace", icon: "chevrons-up-down", title: "Switch workspace", hint: "⌥W" },
];

const PAL_FOLDERS = [
  { id: "dev", name: "Dev Tools", color: "#45c98a", count: 9 },
  { id: "reading", name: "Reading List", color: "#e6b24e", count: 7 },
  { id: "design", name: "Design", color: "#f0686b", count: 5 },
];

// Disambiguation: two bookmarks sharing slug "ddia"
const DISAMBIG_BMS = [
  { ...SB.bookmarks[2], ownerLabel: "You (owner)" },
  { id: 100, title: "DDIA summary notes — Notion", url: "notion.so/ddia-notes-sarah", slug: "ddia", fav: "#b178f7", mono: "N", ownerLabel: "Sarah K. (shared with you)" },
];

function CommandPaletteExt({ q, setQ, active, setActive, onClose, onAction }) {
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  // Mode detection
  const isGoMode = /^go\s/i.test(q);
  const goSlug = isGoMode ? q.trim().slice(3).trim().toLowerCase() : "";
  const isDisambig = isGoMode && (goSlug === "ddia");
  const ql = q.trim().toLowerCase();

  // Search results
  const bmHits = !q || isGoMode ? [] : SB.bookmarks.filter(b =>
    b.title.toLowerCase().includes(ql) || b.url.toLowerCase().includes(ql) || (b.slug || "").includes(ql)
  );
  const folderHits = !q || isGoMode ? [] : PAL_FOLDERS.filter(f => f.name.toLowerCase().includes(ql));
  const tagHits = !q || isGoMode ? [] : SB.tags.filter(t => t.includes(ql));

  // Go mode slug results
  const slugBMs = isGoMode && !isDisambig
    ? SB.bookmarks.filter(b => b.slug && (goSlug ? b.slug.startsWith(goSlug) : true)).slice(0, 6)
    : [];

  // Disambiguation state
  const [disambigSel, setDisambigSel] = useState(0);
  const [alwaysThis, setAlwaysThis] = useState(false);

  const isSearch = !!q && !isGoMode;
  const isEmpty = !q;
  const hasNoResults = isSearch && !bmHits.length && !folderHits.length && !tagHits.length;

  // Flat list for keyboard nav (non-go non-disambig modes)
  const flat = isEmpty
    ? PAL_ACTIONS.map((a, i) => ({ type: "action", data: a, i }))
    : isSearch
      ? [
          ...bmHits.slice(0, 3).map((b, i) => ({ type: "bm", data: b, i })),
          ...(bmHits.length > 3 ? [{ type: "see-all-bm", count: bmHits.length, i: 3 }] : []),
          ...folderHits.slice(0, 3).map((f, i) => ({ type: "folder", data: f, i: 3 + (bmHits.length > 3 ? 1 : 0) + i })),
          ...tagHits.slice(0, 3).map((t, i) => ({ type: "tag", data: t, i: 3 + (bmHits.length > 3 ? 1 : 0) + folderHits.length + i })),
        ]
      : [];

  useEffect(() => {
    const k = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = flat[active]; if (it && onAction) onAction(it); }
      else if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [flat, active]);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        {/* Input row */}
        <div className="palette-input">
          {isGoMode
            ? <span className="pal-mode"><Icon name="arrow-right" size={11} />go</span>
            : <Icon name="search" size={18} />}
          <input ref={inputRef} value={q} placeholder={isGoMode ? "Type a slug to redirect…" : "Search bookmarks or type a command…"}
            onChange={e => { setQ(e.target.value); setActive(0); }} />
          {q
            ? <span style={{ cursor: "pointer", display: "inline-grid", placeItems: "center", color: "var(--fg-faint)" }} onClick={() => setQ("")}><Icon name="x" size={16} /></span>
            : <Kbd>Esc</Kbd>}
        </div>

        {/* Content */}
        <div className="palette-list">

          {/* ---- DEFAULT state ---- */}
          {isEmpty && (() => {
            const groups = [...new Set(PAL_ACTIONS.map(a => a.group))];
            let idx = -1;
            return groups.map(g => (
              <div key={g}>
                <div className="pal-group-label">{g}</div>
                {PAL_ACTIONS.filter(a => a.group === g).map(a => {
                  idx++;
                  const i = idx;
                  return (
                    <div key={a.id} className={"pal-item" + (active === i ? " active" : "")}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => { onAction && onAction({ type: "action", data: a }); }}>
                      <Icon name={a.icon} size={16} />
                      <span className="pal-title">{a.title}</span>
                      {a.hint && <Kbd>{a.hint}</Kbd>}
                      <Icon name="corner-down-left" size={13} style={{ marginLeft: a.hint ? 0 : "auto", opacity: active === i ? 0.6 : 0 }} />
                    </div>
                  );
                })}
              </div>
            ));
          })()}

          {/* ---- SEARCH state ---- */}
          {isSearch && !hasNoResults && (() => {
            let idx = -1;
            return (
              <>
                {bmHits.length > 0 && <>
                  <div className="pal-group-label">Bookmarks</div>
                  {bmHits.slice(0, 3).map(b => { idx++; const i = idx; return (
                    <div key={"b" + b.id} className={"pal-item" + (active === i ? " active" : "")}
                      onMouseEnter={() => setActive(i)} onClick={() => onAction && onAction({ type: "bm", data: b })}>
                      <Favicon b={b} size={22} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="pal-title" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</span>
                        <span style={{ fontSize: 11, color: "var(--fg-faint)", fontFamily: "var(--font-mono)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.url}</span>
                      </span>
                      {b.slug && <span className="pal-hint">{SB.FWD}/{b.slug}</span>}
                      <Icon name="corner-down-left" size={13} style={{ opacity: active === i ? 0.6 : 0 }} />
                    </div>
                  ); })}
                  {bmHits.length > 3 && <div className="pal-see-all" onClick={() => onAction && onAction({ type: "see-all", kind: "bookmarks" })}><Icon name="search" size={13} />See all {bmHits.length} bookmarks matching "{q}"</div>}
                </>}
                {folderHits.length > 0 && <>
                  <div className="pal-group-label">Folders</div>
                  {folderHits.slice(0, 3).map(f => { idx++; const i = idx; return (
                    <div key={"f" + f.id} className={"pal-item" + (active === i ? " active" : "")}
                      onMouseEnter={() => setActive(i)} onClick={() => onAction && onAction({ type: "folder", data: f })}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, background: f.color, display: "inline-grid", placeItems: "center", flexShrink: 0 }}><Icon name="folder" size={13} style={{ color: "#0b0c14" }} /></span>
                      <span className="pal-title">{f.name}</span>
                      <span className="pal-hint">{f.count} bookmarks</span>
                    </div>
                  ); })}
                </>}
                {tagHits.length > 0 && <>
                  <div className="pal-group-label">Tags</div>
                  {tagHits.slice(0, 3).map(t => { idx++; const i = idx; return (
                    <div key={"t" + t} className={"pal-item" + (active === i ? " active" : "")}
                      onMouseEnter={() => setActive(i)} onClick={() => onAction && onAction({ type: "tag", data: t })}>
                      <Icon name="hash" size={16} />
                      <span className="pal-title" style={{ fontFamily: "var(--font-mono)" }}>#{t}</span>
                      <span className="pal-hint">{SB.bookmarks.filter(b => b.tags.includes(t)).length} bookmarks</span>
                    </div>
                  ); })}
                </>}
              </>
            );
          })()}

          {/* ---- NO RESULTS ---- */}
          {hasNoResults && (
            <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
              No results for <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>"{q}"</span>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-faint)" }}>Try a different search, or press <Kbd>C</Kbd> to create a new bookmark.</div>
            </div>
          )}

          {/* ---- GO MODE ---- */}
          {isGoMode && !isDisambig && (
            <>
              {goSlug && <div className="pal-group-label">Slug resolution — go.slugbase.app/{goSlug || "…"}</div>}
              {!goSlug && <div className="pal-group-label">All slugs — type to filter</div>}
              {slugBMs.length === 0 && (
                <div style={{ padding: "20px 16px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
                  No slug matching <span style={{ fontFamily: "var(--font-mono)" }}>"{goSlug}"</span>
                </div>
              )}
              {slugBMs.map((b, i) => (
                <div key={b.id} className={"pal-go-item" + (active === i ? " active" : "")}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onAction && onAction({ type: "go", data: b })}>
                  <Favicon b={b} size={22} />
                  <span className="pal-go-slug">{SB.FWD}/{b.slug}</span>
                  <Icon name="arrow-right" size={13} className="pal-go-arr" />
                  <span className="pal-go-url">{b.url}</span>
                  <Icon name="corner-down-left" size={13} style={{ opacity: active === i ? 0.7 : 0, flexShrink: 0 }} />
                </div>
              ))}
            </>
          )}

          {/* ---- DISAMBIGUATION ---- */}
          {isDisambig && (
            <>
              <div className="pal-disambig-head">
                <p><b>go.slugbase.app/ddia</b> resolves to more than one accessible bookmark. Choose which one to open.</p>
              </div>
              <div style={{ padding: "var(--sp-3)" }}>
                {DISAMBIG_BMS.map((b, i) => (
                  <div key={b.id} className={"disambig-item" + (disambigSel === i ? " sel" : "")}
                    onClick={() => setDisambigSel(i)}>
                    <div style={{ paddingTop: 2 }}>
                      <div className={"cb" + (disambigSel === i ? " on" : "")} style={{ width: 17, height: 17, borderRadius: 99, marginTop: 1 }}>
                        {disambigSel === i && <div style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent-fg)" }} />}
                      </div>
                    </div>
                    <Favicon b={b} size={26} />
                    <div className="disambig-info">
                      <div className="disambig-title">{b.title}</div>
                      <div className="disambig-url">{b.url}</div>
                      <div className="disambig-owner"><Icon name="user" size={11} />{b.ownerLabel}</div>
                    </div>
                    {disambigSel === i && <Icon name="check" size={16} style={{ color: "var(--accent-text)", flexShrink: 0 }} />}
                  </div>
                ))}
              </div>
              <div className="disambig-always">
                <Check on={alwaysThis} onChange={setAlwaysThis} />
                <span>Always use <b>{DISAMBIG_BMS[disambigSel]?.ownerLabel.split(" ")[0]}'s version</b> for <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent-text)" }}>go.slugbase.app/ddia</span></span>
                <button className="btn btn--primary btn--sm" style={{ marginLeft: "auto" }}
                  onClick={() => onAction && onAction({ type: "go", data: DISAMBIG_BMS[disambigSel] })}>
                  Open this one
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="palette-foot">
          <span className="fk"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="fk"><Kbd>↵</Kbd> select</span>
          {isSearch && <span className="pal-mod-hint"><Kbd>⌘</Kbd><Kbd>↵</Kbd> open in new tab</span>}
          {isGoMode && !isDisambig && <span className="pal-mod-hint"><Kbd>↵</Kbd> redirect</span>}
          <span className="fk" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Kbd>esc</Kbd> close
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <img src="../assets/slugbase_icon.svg" width="14" height="14" alt="" /> SlugBase
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---- Palette demo harness ---- */
const DEMO_STATES = [
  { id: "default", label: "Default", q: "" },
  { id: "search", label: 'Search: "react"', q: "react" },
  { id: "noresults", label: "No results", q: "xyzzy404" },
  { id: "go", label: "Go mode", q: "go " },
  { id: "disambig", label: "Disambiguation", q: "go ddia" },
];

function PaletteApp() {
  const [ws, setWs] = useState(SB.workspaces[0]);
  const [theme, setTheme] = useState(() => lsP("sb_theme", "dark"));
  const [toasts, setToasts] = useState([]);
  const [paletteQ, setPaletteQ] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(true);
  const [demoId, setDemoId] = useState("default");

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("sb_theme", JSON.stringify(theme)); }, [theme]);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));
  const goTo = (id) => {
    const MAP = { dashboard: "Dashboard.html", bookmarks: "Bookmarks.html", folders: "Folders.html", tags: "Tags.html" };
    if (MAP[id]) { window.location.href = MAP[id]; }
  };

  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(o => !o); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  // Re-open palette automatically if closed
  useEffect(() => { if (!open) { const t = setTimeout(() => setOpen(true), 600); return () => clearTimeout(t); } }, [open]);

  const setDemo = (state) => {
    setDemoId(state.id);
    setPaletteQ(state.q);
    setActive(0);
    setOpen(true);
  };

  const onAction = (it) => {
    if (it.type === "bm" || it.type === "go") toast({ icon: "external-link", title: "Opening", sub: it.data.title || it.data.url });
    else if (it.type === "action") {
      const nav = { "go-bookmarks": "bookmarks", "go-folders": "folders", "go-tags": "tags" }[it.data.id];
      if (nav) goTo(nav);
      else toast({ icon: it.data.icon, title: it.data.title });
    } else if (it.type === "folder") toast({ icon: "folder", title: it.data.name });
    else if (it.type === "tag") toast({ icon: "hash", title: `#${it.data}` });
    else if (it.type === "see-all") toast({ kind: "info", icon: "search", title: `Show all bookmarks matching "${paletteQ}"` });
    setOpen(false);
  };

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav="bookmarks" setNav={goTo}
        folders={SB.folders} activeFolder={null} setFolder={() => {}}
        totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => {}} />

      <main className="main">
        <TopBar ws={ws} count={SB.bookmarks.length} crumbIcon="search" crumbLabel="Command Palette" crumbSub={null}
          onOpenPalette={() => setOpen(true)} theme={theme}
          onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onNew={() => toast({ icon: "bookmark-plus", title: "New bookmark" })} />

        {/* Static background content — blurred by palette scrim */}
        <div className="content" style={{ opacity: 0.4, pointerEvents: "none", userSelect: "none" }}>
          <div className="section-head"><Icon name="pin" size={15} /><span className="t-label">Pinned</span><span className="badge badge--neutral">3</span><span className="rule" /></div>
          <div className="grid">
            {SB.bookmarks.filter(b => b.pinned).map(b => (
              <div key={b.id} className="card pinned">
                <div className="card-top"><Favicon b={b} size={32} /><div><div className="card-title">{b.title}</div></div></div>
                <SlugLine b={b} />
              </div>
            ))}
          </div>
          <div className="section-head" style={{ marginTop: 24 }}><span className="t-label">All bookmarks</span><span className="rule" /></div>
          <div className="grid">
            {SB.bookmarks.slice(3, 9).map(b => (
              <div key={b.id} className="card">
                <div className="card-top"><Favicon b={b} size={32} /><div><div className="card-title">{b.title}</div></div></div>
                <SlugLine b={b} />
              </div>
            ))}
          </div>
        </div>
      </main>

      {open && (
        <CommandPaletteExt q={paletteQ} setQ={setPaletteQ} active={active} setActive={setActive}
          onClose={() => setOpen(false)} onAction={onAction} />
      )}

      {/* Demo harness */}
      <div className="pal-harness">
        <span className="pal-harness-label">Demo state:</span>
        {DEMO_STATES.map(s => (
          <button key={s.id} className={demoId === s.id ? "on" : ""} onClick={() => setDemo(s)}>{s.label}</button>
        ))}
      </div>

      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<PaletteApp />);
