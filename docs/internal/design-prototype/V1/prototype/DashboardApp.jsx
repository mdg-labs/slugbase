/* SlugBase — Dashboard (Home) page */
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const CHECKLIST = [
  { id: "bm", label: "Add your first bookmark", desc: "Press C anywhere to save a link." },
  { id: "folder", label: "Create a folder", desc: "Organize bookmarks into folders." },
  { id: "shortcut", label: "Set up browser search shortcut", desc: "Type \"s react\" in your address bar." },
  { id: "import", label: "Import from browser", desc: "Migrate your existing bookmarks in one step." },
];

function DashboardApp() {
  const [ws, setWs] = useState(SB.workspaces[0]);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState(() => ls("sb_theme", "dark"));
  const [toasts, setToasts] = useState([]);
  const [checked, setChecked] = useState(() => ls("sb_checklist", { bm: true, folder: true, shortcut: false, import: false }));
  const [clDismissed, setClDismissed] = useState(() => ls("sb_cl_dismissed", false));
  const [entState, setEntState] = useState("approaching"); // off | approaching | cap

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("sb_theme", JSON.stringify(theme)); }, [theme]);
  useEffect(() => { localStorage.setItem("sb_checklist", JSON.stringify(checked)); }, [checked]);
  useEffect(() => { localStorage.setItem("sb_cl_dismissed", JSON.stringify(clDismissed)); }, [clDismissed]);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));
  const goTo = (id) => {
    const MAP = { dashboard: "Dashboard.html", bookmarks: "Bookmarks.html", folders: "Folders.html", tags: "Tags.html" };
    if (MAP[id]) { window.location.href = MAP[id]; }
  };

  useEffect(() => {
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(p => !p); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const tagCounts = React.useMemo(() => {
    const c = {};
    SB.bookmarks.forEach(b => b.tags.forEach(t => { c[t] = (c[t] || 0) + 1; }));
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, []);

  const quickSlugs = React.useMemo(() =>
    [...SB.bookmarks].filter(b => b.slug).sort((a, b) => b.hits - a.hits).slice(0, 6), []);
  const pinnedBMs = SB.bookmarks.filter(b => b.pinned);
  const sharedWithMe = SB.bookmarks.filter(b => b.scope === "shared-with-me");
  const sharedByMe = SB.bookmarks.filter(b => b.scope === "shared-by-me");

  const doneCount = Object.values(checked).filter(Boolean).length;
  const allDone = doneCount === CHECKLIST.length;

  const planUsed = entState === "cap" ? 100 : entState === "approaching" ? 94 : 0;
  const planCap = SB.plan.cap;

  const toggleCheck = (id) => setChecked(p => ({ ...p, [id]: !p[id] }));

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav="dashboard" setNav={goTo}
        folders={SB.folders} activeFolder={null} setFolder={() => {}}
        totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => toast({ icon: "zap", title: "Upgrade to Pro" })} />

      <main className="main">
        <TopBar ws={ws} count={null} crumbIcon="home" crumbLabel="Home" crumbSub={null}
          onOpenPalette={() => setPalette(true)} theme={theme}
          onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onNew={() => toast({ icon: "bookmark-plus", title: "New bookmark" })} />

        {/* Entitlement banner */}
        {entState !== "off" && (
          <div className={"upsell" + (entState === "cap" ? " at-cap" : "")} style={{ margin: "var(--sp-5) var(--sp-7) 0" }}>
            <span className="upsell-ic"><Icon name={entState === "cap" ? "alert-triangle" : "zap"} size={18} strokeWidth={2.25} /></span>
            <div className="upsell-txt">
              <b>{entState === "cap" ? "Bookmark limit reached" : `${planCap - planUsed} bookmark${planCap - planUsed !== 1 ? "s" : ""} left on Free`}</b>
              <p style={{ fontFamily: "var(--font-mono)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                {entState === "cap"
                  ? `You've used all ${planCap} bookmarks on Free. Upgrade to keep saving.`
                  : `You're approaching the ${planCap}-bookmark cap (${planUsed} used). Upgrade to Pro for unlimited saves.`}
              </p>
            </div>
            <button className="btn btn--primary btn--sm" onClick={() => toast({ icon: "zap", title: "Upgrade to Pro" })}>Upgrade</button>
          </div>
        )}

        {/* Dev toggle for entitlement state */}
        <div className="ent-demo">
          <span>Entitlement demo:</span>
          <select value={entState} onChange={e => setEntState(e.target.value)}>
            <option value="off">Pro (no banner)</option>
            <option value="approaching">Approaching cap (94/100)</option>
            <option value="cap">At cap (100/100)</option>
          </select>
        </div>

        <div className="content" style={{ paddingTop: "var(--sp-3)" }}>
          {/* Stats row */}
          <div className="stat-row">
            <div className="stat-tile" onClick={() => goTo("bookmarks")} style={{ cursor: "pointer" }}>
              <div className="stat-num">{SB.bookmarks.length}</div>
              <div className="stat-label"><Icon name="bookmark" size={13} />Bookmarks</div>
            </div>
            <div className="stat-tile" onClick={() => goTo("folders")} style={{ cursor: "pointer" }}>
              <div className="stat-num">{SB.folders.length}</div>
              <div className="stat-label"><Icon name="folder" size={13} />Folders</div>
            </div>
            <div className="stat-tile" onClick={() => goTo("tags")} style={{ cursor: "pointer" }}>
              <div className="stat-num">{SB.tags.length}</div>
              <div className="stat-label"><Icon name="hash" size={13} />Tags</div>
            </div>
          </div>

          <div className="dash-grid">
            {/* Left column */}
            <div className="dash-col">
              {/* Quick-access slugs */}
              <div className="dash-section">
                <div className="dash-section-head">
                  <h3><Icon name="zap" size={15} />Quick access</h3>
                  <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)" }}>Most used slugs</span>
                </div>
                <div className="slug-ql">
                  {quickSlugs.map(b => (
                    <div key={b.id} className="slug-ql-item" onClick={() => toast({ icon: "external-link", title: `Opening ${SB.FWD}/${b.slug}`, sub: b.title })}>
                      <Favicon b={b} size={24} />
                      <span className="slug-ql-title">{b.title}</span>
                      <span className="slug-ql-addr">{SB.FWD}/{b.slug}</span>
                      <span className="slug-ql-hits"><Icon name="flame" size={11} />{b.hits}</span>
                      <span className="slug-ql-open"><Icon name="arrow-up-right" size={14} /></span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Pinned bookmarks */}
              <div className="dash-section">
                <div className="dash-section-head">
                  <h3><Icon name="pin" size={15} />Pinned</h3>
                  <a style={{ fontSize: "var(--text-small)", color: "var(--accent-text)", cursor: "pointer" }}
                    onClick={() => goTo("bookmarks")}>View all →</a>
                </div>
                <div className="pinned-mini-grid">
                  {pinnedBMs.map(b => (
                    <div key={b.id} className="pinned-mini"
                      onClick={() => toast({ icon: "external-link", title: "Opening bookmark", sub: b.title })}>
                      <div className="pinned-mini-top">
                        <Favicon b={b} size={22} />
                        <span className="pinned-mini-title">{b.title}</span>
                      </div>
                      <div className="pinned-mini-meta">
                        {b.slug && <span className="slug-line" style={{ fontSize: 11 }}><Icon name="link" size={11} /><span className="addr">{SB.FWD}/{b.slug}</span></span>}
                        <span style={{ fontSize: 11, color: "var(--fg-faint)", marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{b.last} ago</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right column */}
            <div className="dash-col">
              {/* Onboarding checklist */}
              {!clDismissed && !allDone && (
                <div className="checklist-card">
                  <div className="checklist-head">
                    <h3><Icon name="list-checks" size={15} />Getting started</h3>
                    <span style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{doneCount}/{CHECKLIST.length}</span>
                    <button className="icon-btn icon-btn--sm" onClick={() => setClDismissed(true)} title="Dismiss"><Icon name="x" size={15} /></button>
                  </div>
                  <div className="checklist-prog"><i style={{ width: `${(doneCount / CHECKLIST.length) * 100}%` }} /></div>
                  <div className="checklist-items">
                    {CHECKLIST.map(item => (
                      <div key={item.id} className="check-item" onClick={() => toggleCheck(item.id)}>
                        <Check on={checked[item.id]} onChange={() => toggleCheck(item.id)} />
                        <div>
                          <div className={"check-item-label" + (checked[item.id] ? " done" : "")}>{item.label}</div>
                          {!checked[item.id] && <div className="check-item-desc">{item.desc}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(clDismissed || allDone) && (
                <div className="checklist-card">
                  <div className="checklist-head">
                    <h3><Icon name="list-checks" size={15} />Getting started</h3>
                    <span className="badge badge--success">Complete</span>
                  </div>
                  <div style={{ padding: "var(--sp-5) var(--sp-6)", color: "var(--fg-subtle)", fontSize: "var(--text-body)" }}>
                    You're all set. SlugBase is ready to use.
                    {clDismissed && <a style={{ marginLeft: 8, color: "var(--accent-text)", cursor: "pointer", fontSize: "var(--text-small)" }} onClick={() => setClDismissed(false)}>Show again</a>}
                  </div>
                </div>
              )}

              {/* Most used tags */}
              <div className="dash-section">
                <div className="dash-section-head">
                  <h3><Icon name="hash" size={15} />Most used tags</h3>
                  <a style={{ fontSize: "var(--text-small)", color: "var(--accent-text)", cursor: "pointer" }}
                    onClick={() => goTo("tags")}>All tags →</a>
                </div>
                <div className="tag-cloud">
                  {tagCounts.map(([tag, count]) => (
                    <span key={tag} className="tag-cloud-item"
                      onClick={() => toast({ icon: "hash", title: `Filtering by #${tag}` })}>
                      {tag}<span className="tc">{count}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Sharing stats */}
              <div className="dash-section">
                <div className="dash-section-head">
                  <h3><Icon name="share-2" size={15} />Sharing</h3>
                </div>
                <div className="share-rows">
                  <div className="share-row" onClick={() => goTo("bookmarks")}>
                    <Icon name="users" size={15} />
                    <span>Shared with you</span>
                    <span className="cnt">{sharedWithMe.length}</span>
                    <Icon name="chevron-right" size={14} className="arr" />
                  </div>
                  <div className="share-row" onClick={() => goTo("bookmarks")}>
                    <Icon name="share-2" size={15} />
                    <span>Shared by you</span>
                    <span className="cnt">{sharedByMe.length}</span>
                    <Icon name="chevron-right" size={14} className="arr" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} bookmarks={SB.bookmarks} onAction={() => {}} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<DashboardApp />);
