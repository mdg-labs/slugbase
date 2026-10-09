/* SlugBase — Edge States prototype root + harness */
const lsE = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const SURFACES = [
  { group:"Onboarding", id:"onboarding", label:"First login" },
  { group:"Workspace", id:"ws-open", label:"Switcher open" },
  { group:"Workspace", id:"ws-loading", label:"Switching…" },
  { group:"Workspace", id:"ws-create", label:"Create workspace" },
  { group:"Workspace", id:"ws-blocked", label:"Entitlement blocked" },
  { group:"Disambiguation", id:"disambig", label:"Slug: mail" },
  { group:"App errors", id:"app-404", label:"App 404" },
  { group:"App errors", id:"app-403", label:"App 403" },
  { group:"App errors", id:"app-500", label:"App 500" },
  { group:"Marketing errors", id:"mk-404", label:"Mkt 404" },
  { group:"Marketing errors", id:"mk-403", label:"Mkt 403" },
  { group:"Marketing errors", id:"mk-500", label:"Mkt 500" },
];

function EdgeHarness({ surface, setSurface }) {
  const groups = [...new Set(SURFACES.map(s => s.group))];
  return (
    <div className="edge-harness">
      {groups.map((g, gi) => (
        <React.Fragment key={g}>
          {gi > 0 && <div className="edge-harness-sep" />}
          <span className="edge-harness-label">{g}</span>
          {SURFACES.filter(s => s.group === g).map(s => (
            <button key={s.id} className={"edge-btn" + (surface === s.id ? " on" : "")} onClick={() => setSurface(s.id)}>{s.label}</button>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function EdgeStatesApp() {
  const [surface, setSurface] = useState("onboarding");
  const [wsVariant, setWsVariant] = useState("open");
  const [theme, setTheme] = useState(() => lsE("sb_theme", "dark"));
  const [toasts, setToasts] = useState([]);
  const [ws, setWs] = useState(SB.workspaces[0]);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  const toast = (o) => { const id = Math.random(); setToasts(t => [...t, { id, ...o }]); };
  const dismiss = (id) => setToasts(t => t.filter(x => x.id !== id));
  const goTo = (id) => {
    const MAP = { dashboard:"Dashboard.html", bookmarks:"Bookmarks.html", folders:"Folders.html", tags:"Tags.html", settings:"Settings.html" };
    if (MAP[id]) { window.location.href = MAP[id]; }
  };

  /* ---- workspace-variant sync from harness ---- */
  useEffect(() => {
    if (surface === "ws-open")    setWsVariant("open");
    if (surface === "ws-loading") setWsVariant("loading");
    if (surface === "ws-create")  setWsVariant("create");
    if (surface === "ws-blocked") setWsVariant("create-blocked");
  }, [surface]);

  const isAppShell = ["ws-open","ws-loading","ws-create","ws-blocked","disambig","app-404","app-403","app-500"].includes(surface);
  const isMkError  = surface.startsWith("mk-");
  const isOnboarding = surface === "onboarding";

  /* ---- Routing ---- */
  if (isOnboarding) {
    return (
      <>
        {/* Faint shell visible behind the onboarding overlay to show it's "replacing" the viewport */}
        <div className="app" style={{ position:"fixed", inset:0, opacity:0.08, pointerEvents:"none" }}>
          <Sidebar ws={ws} onSwitch={setWs} nav="dashboard" setNav={() => {}} folders={SB.folders} activeFolder={null} setFolder={() => {}} totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => {}} />
          <main className="main">
            <TopBar ws={ws} count={null} crumbIcon="home" crumbLabel="Home" crumbSub={null} onOpenPalette={() => {}} theme={theme} onToggleTheme={() => {}} onNew={() => {}} />
          </main>
        </div>
        <OnboardingFlow onDone={() => { toast({ icon:"check", title:"Onboarding complete" }); setSurface("ws-open"); }} />
        <EdgeHarness surface={surface} setSurface={setSurface} />
        <Toasts items={toasts} onDismiss={dismiss} />
      </>
    );
  }

  if (isMkError) {
    const code = surface.replace("mk-", "");
    return (
      <>
        <MkError code={code} />
        <EdgeHarness surface={surface} setSurface={setSurface} />
      </>
    );
  }

  /* ---- App shell for ws-switcher, disambig, app errors ---- */
  const isWs   = surface.startsWith("ws-");
  const isDisambig = surface === "disambig";
  const appError = surface.startsWith("app-") ? surface.replace("app-", "") : null;

  const shellNav  = isDisambig ? "bookmarks" : isWs ? "dashboard" : "bookmarks";
  const crumbIcon = isDisambig ? "link" : "home";
  const crumbLabel= isDisambig ? "Slug redirect" : appError ? `Error ${appError}` : "Home";

  return (
    <>
      <div className="app" style={{ position:"relative" }}>
        <Sidebar ws={ws} onSwitch={setWs} nav={shellNav} setNav={goTo}
          folders={SB.folders} activeFolder={null} setFolder={() => {}}
          totalCount={SB.bookmarks.length} plan={SB.plan} onUpgrade={() => {}} />
        <main className="main">
          <TopBar ws={ws} count={null} crumbIcon={crumbIcon} crumbLabel={crumbLabel} crumbSub={null}
            onOpenPalette={() => {}} theme={theme}
            onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
            onNew={() => toast({ icon:"bookmark-plus", title:"New bookmark" })} />

          {isDisambig && <SlugDisambig toast={toast} />}
          {appError && <AppError code={appError} toast={toast} />}

          {/* Light background "content" behind ws overlay */}
          {isWs && (
            <div className="content" style={{ opacity:0.25, pointerEvents:"none", userSelect:"none" }}>
              <div className="section-head"><span className="t-label">Bookmarks</span><span className="rule" /></div>
              <div className="grid">
                {SB.bookmarks.slice(0, 6).map(b => (
                  <div key={b.id} className="card" style={{ cursor:"default" }}>
                    <div className="card-top"><Favicon b={b} size={32} /><div><div className="card-title">{b.title}</div></div></div>
                    <SlugLine b={b} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* Workspace switcher overlay (rendered inside .app for correct positioning) */}
        {isWs && (
          <WorkspaceSwitcherOverlay
            variant={wsVariant}
            setVariant={(v) => {
              setWsVariant(v);
              const map = { open:"ws-open", loading:"ws-loading", create:"ws-create", "create-blocked":"ws-blocked" };
              if (map[v]) setSurface(map[v]);
            }}
            toast={toast}
          />
        )}
      </div>

      <EdgeHarness surface={surface} setSurface={setSurface} />
      <Toasts items={toasts} onDismiss={dismiss} />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<EdgeStatesApp />);
