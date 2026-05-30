/* SlugBase — Settings root: shell + routing */
const lsSt = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

function SettingsApp() {
  const [ws, setWs]     = useState(SB.workspaces[0]);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme]     = useState(() => lsSt("sb_theme", "dark"));
  const [toasts, setToasts]   = useState([]);
  const [page, setPage]       = useState("account");   // account | workspace | members | audit
  const [section, setSection] = useState("profile");   // nav item id

  // Prototype-level variant toggles
  const [hosted,  setHosted]  = useState(false);       // hosted vs self-hosted
  const [plan, setPlan]       = useState("team");      // free | pro | team
  const [archivedCount, setArchivedCount] = useState(0); // from billing post-downgrade

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("sb_theme", JSON.stringify(theme));
  }, [theme]);

  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(p => !p); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const toast   = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));

  const goTo = (id) => {
    const MAP = { dashboard:"Dashboard.html", bookmarks:"Bookmarks.html", folders:"Folders.html", tags:"Tags.html", settings:"Settings.html" };
    if (MAP[id] && id !== "settings") { window.location.href = MAP[id]; return; }
  };

  const onNav = (pg, sec) => { setPage(pg); setSection(sec); };

  /* Breadcrumb label per page */
  const crumbLabels = { account:"Account", workspace:"Workspace", members:"Members & Teams", audit:"Audit Log", billing:"Plans & Billing" };

  return (
    <div className="app">
      <Sidebar ws={ws} onSwitch={setWs} nav="settings" setNav={goTo} archivedCount={archivedCount}
        folders={SB.folders} activeFolder={null} setFolder={() => {}}
        totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => toast({ icon:"zap", title:"Upgrade to Pro" })} />

      <main className="main">
        <TopBar ws={ws} count={null} crumbIcon="settings" crumbLabel="Settings"
          crumbSub={crumbLabels[page] || "Account"}
          onOpenPalette={() => setPalette(true)} theme={theme}
          onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          onNew={() => toast({ icon:"bookmark-plus", title:"New bookmark" })}
          archivedCount={archivedCount} />

        {/* Prototype variant strip */}
        <div className="dev-strip">
          <strong>Instance:</strong>
          <select value={hosted ? "hosted" : "self"} onChange={e => setHosted(e.target.value === "hosted")}>
            <option value="self">Self-hosted (all panels)</option>
            <option value="hosted">Hosted (SMTP + OIDC hidden)</option>
          </select>
          <strong style={{ marginLeft:"var(--sp-5)" }}>Plan:</strong>
          <select value={plan} onChange={e => setPlan(e.target.value)}>
            <option value="free">Free (Members/Audit gated)</option>
            <option value="pro">Pro (Members/Audit gated)</option>
            <option value="team">Team (all unlocked)</option>
          </select>
        </div>

        {/* Settings shell: secondary nav + content */}
        <div className="settings-layout">
          <SettingsNav page={page} section={section} onNav={onNav} />
          <div className="settings-content">
            {page === "account"    && <AccountSettings   section={section} toast={toast} />}
            {page === "workspace"  && <WorkspaceSettings section={section} hosted={hosted} toast={toast} />}
            {page === "members"    && <MembersSettings   plan={plan} toast={toast} />}
            {page === "audit"      && <AuditSettings     plan={plan} toast={toast} />}
            {page === "billing"    && <BillingPage subSection={section} onArchivedCount={setArchivedCount} toast={toast} />}
          </div>
        </div>
      </main>

      {palette && <CommandPalette onClose={() => setPalette(false)} bookmarks={SB.bookmarks} onAction={() => {}} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<SettingsApp />);
