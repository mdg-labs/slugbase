/* SlugBase — Slug Disambiguation + Error pages (app + marketing context) */

/* ---- Slug Disambiguation ---- */
const DISAMBIG_BMS = [
  {
    id: 1,
    title: "Gmail — personal inbox",
    url: "mail.google.com",
    slug: "mail",
    owner: "You",
    ownerIcon: "user",
    folder: "Inbox",
    folderColor: "#7782f7",
    fav: "#e06060",
    mono: "G",
  },
  {
    id: 2,
    title: "Front — Acme shared support inbox",
    url: "app.frontapp.com/inboxes/shared/acme-support",
    slug: "mail",
    owner: "Sarah K. (shared by)",
    ownerIcon: "share-2",
    folder: "Team Resources",
    folderColor: "#45c98a",
    fav: "#4a7cc7",
    mono: "F",
  },
];

function SlugDisambig({ toast }) {
  const [sel, setSel] = useState(0);
  const [always, setAlways] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    const b = DISAMBIG_BMS[sel];
    return (
      <div className="disambig-page">
        <div className="disambig-card">
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"var(--sp-5)", textAlign:"center", padding:"var(--sp-9)" }}>
            <Icon name="check-circle" size={36} style={{ color:"var(--success-text)" }} />
            <div>
              <div style={{ fontWeight:"var(--weight-semi)", fontSize:"var(--text-h3)", color:"var(--fg)", marginBottom:"var(--sp-3)" }}>Opening {b.title}</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:"var(--text-small)", color:"var(--fg-subtle)" }}>{b.url}</div>
            </div>
            {always && <div style={{ fontSize:"var(--text-small)", color:"var(--fg-subtle)", display:"flex", alignItems:"center", gap:"var(--sp-3)" }}><Icon name="check" size={13} style={{ color:"var(--success-text)" }} />Preference saved — <b style={{ fontFamily:"var(--font-mono)", color:"var(--accent-text)" }}>mail</b> will always resolve to {b.owner === "You" ? "your bookmark" : b.owner + "'s bookmark"}</div>}
            <button className="btn btn--ghost btn--sm" onClick={() => setDone(false)}><Icon name="arrow-left" size={14}/>Back to disambiguation</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="disambig-page">
      <div className="disambig-card">
        <div>
          <div className="disambig-icon"><Icon name="git-fork" size={24} /></div>
        </div>
        <div>
          <div style={{ marginBottom:"var(--sp-4)", display:"flex", alignItems:"center", gap:"var(--sp-4)", flexWrap:"wrap" }}>
            <h2 style={{ margin:0, font:"var(--weight-semi) var(--text-h2)/var(--lh-h2) var(--font-sans)", color:"var(--fg)" }}>Slug matches multiple bookmarks</h2>
          </div>
          <p style={{ margin:0, fontSize:"var(--text-body-lg)", color:"var(--fg-muted)", lineHeight:1.55 }}>
            The slug <span className="disambig-slug">mail</span> resolves to more than one bookmark you have access to. Choose which one to open.
          </p>
        </div>

        <div className="disambig-options">
          {DISAMBIG_BMS.map((b, i) => (
            <div key={b.id} className={"disambig-opt" + (sel === i ? " selected" : "")} onClick={() => setSel(i)}>
              <div className="disambig-opt-radio" />
              <div style={{ width:36, height:36, borderRadius:6, background:b.fav, display:"grid", placeItems:"center", flexShrink:0, fontWeight:700, fontSize:16, color:"#fff" }}>{b.mono}</div>
              <div className="disambig-opt-body">
                <div className="disambig-opt-title">{b.title}</div>
                <div className="disambig-opt-url">{b.url}</div>
                <div className="disambig-opt-meta">
                  <span style={{ display:"flex", alignItems:"center", gap:4 }}><Icon name={b.ownerIcon} size={12}/>{b.owner}</span>
                  <span style={{ display:"flex", alignItems:"center", gap:4 }}><span style={{ width:8, height:8, borderRadius:2, background:b.folderColor, flexShrink:0 }} />{b.folder}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <label className="disambig-always" onClick={() => setAlways(a => !a)}>
          <Check on={always} onChange={setAlways} />
          Always open <b style={{ marginLeft:4, marginRight:4, fontFamily:"var(--font-mono)", color:"var(--accent-text)" }}>mail</b> with {DISAMBIG_BMS[sel].owner === "You" ? "my bookmark" : DISAMBIG_BMS[sel].owner + "'s bookmark"}, skip this in future
        </label>

        <div style={{ display:"flex", alignItems:"center", gap:"var(--sp-5)", flexWrap:"wrap" }}>
          <button className="btn btn--primary" onClick={() => { setDone(true); toast({ icon:"external-link", title:`Opening ${DISAMBIG_BMS[sel].title}` }); }}>
            <Icon name="external-link" size={15}/>Open this bookmark
          </button>
          <div className="disambig-footer">
            <a onClick={() => toast({ icon:"settings", title:"Opening slug preferences" })}>Manage remembered slug preferences →</a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Error pages ---- */
const ERROR_DEFS = {
  "404": {
    code: "404",
    title: "Not found.",
    desc: "This URL didn't resolve. The page, resource, or slug doesn't exist — or it was moved.",
    icon: "file-question",
    flavor: "go.slugbase.app/this-does-not-exist",
    appAction: "Go to Bookmarks",
    mkAction: "Back to home",
  },
  "403": {
    code: "403",
    title: "Access denied.",
    desc: "You're signed in, but you don't have permission to view this. You may need to ask a workspace owner to share access.",
    icon: "lock",
    flavor: "/workspaces/acme/folders/restricted-data",
    appAction: "Go to your workspace",
    mkAction: "Back to home",
  },
  "500": {
    code: "500",
    title: "Something broke.",
    desc: "An unexpected error occurred on our end. This isn't your fault. We've logged it and will look into it.",
    icon: "server-crash",
    flavor: null,
    appAction: "Reload the page",
    mkAction: "Reload the page",
  },
};

function AppError({ code, toast }) {
  const e = ERROR_DEFS[code];
  return (
    <div className="error-page">
      <div className="error-mark"><img src="../assets/slugbase_icon.svg" alt="" /></div>
      <div className="error-code">{e.code}</div>
      <h1 className="error-title">{e.title}</h1>
      <p className="error-desc">{e.desc}</p>
      {e.flavor && <div className="error-path">{e.flavor}</div>}
      <div className="error-actions">
        <a className="btn btn--primary" href="Dashboard.html"><Icon name="home" size={15}/>{e.appAction}</a>
        {code !== "500"
          ? <button className="btn btn--secondary" onClick={() => toast({ kind:"info", icon:"arrow-left", title:"Going back" })}><Icon name="arrow-left" size={15}/>Go back</button>
          : <button className="btn btn--secondary" onClick={() => window.location.reload()}><Icon name="refresh-cw" size={15}/>Reload</button>}
        <button className="btn btn--ghost btn--sm error-report" onClick={() => toast({ icon:"bug", title:"Issue reported — thanks" })}><Icon name="bug" size={14}/>Report this error</button>
      </div>
    </div>
  );
}

function MkErrorNav() {
  return (
    <nav style={{ position:"sticky", top:0, zIndex:100, background:"rgba(10,11,16,0.88)", backdropFilter:"blur(14px)", borderBottom:"1px solid var(--border-subtle)" }}>
      <div style={{ maxWidth:1080, margin:"0 auto", padding:"0 40px", display:"flex", alignItems:"center", gap:24, height:60 }}>
        <a href="../marketing/Marketing.html" style={{ display:"flex", alignItems:"center", gap:10, textDecoration:"none" }}>
          <img src="../assets/slugbase_icon.svg" width={24} height={24} alt="" />
          <span style={{ fontWeight:600, fontSize:16, color:"var(--fg)" }}>SlugBase</span>
        </a>
        <div style={{ marginLeft:"auto", display:"flex", gap:16, fontSize:14 }}>
          {["Features","Pricing","Contact"].map(l => <span key={l} style={{ color:"var(--fg-muted)", cursor:"pointer" }}>{l}</span>)}
        </div>
        <a className="btn btn--primary btn--sm" href="Auth.html" style={{ display:"inline-flex", alignItems:"center", gap:6, height:32, padding:"0 14px", borderRadius:6, background:"var(--accent)", color:"var(--accent-fg)", fontWeight:600, fontSize:13, textDecoration:"none" }}>Get started</a>
      </div>
    </nav>
  );
}

function MkErrorFooter() {
  return (
    <footer style={{ background:"var(--base)", borderTop:"1px solid var(--border-subtle)", padding:"28px 40px", display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:13, color:"var(--fg-subtle)" }}>
      <span>© 2026 SlugBase. AGPL-3.0.</span>
      <span style={{ display:"flex", gap:16 }}>
        {["Impressum","Datenschutz","AGB"].map(l=><span key={l} style={{cursor:"pointer"}}>{l}</span>)}
      </span>
    </footer>
  );
}

function MkError({ code }) {
  const e = ERROR_DEFS[code];
  return (
    <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", background:"var(--canvas)", color:"var(--fg)", fontFamily:"var(--font-sans)" }}>
      <MkErrorNav />
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"80px 40px", gap:24 }}>
        <img src="../assets/slugbase_icon.svg" width={52} height={52} alt="" style={{ opacity:0.3 }} />
        <div className="error-code">{e.code}</div>
        <h1 className="error-title">{e.title}</h1>
        <p className="error-desc">{e.desc}</p>
        {e.flavor && <div className="error-path">{e.flavor}</div>}
        <div className="error-actions">
          <a className="btn btn--primary" href="../marketing/Marketing.html"><Icon name="home" size={15}/>{e.mkAction}</a>
          <a className="btn btn--secondary" href="Auth.html"><Icon name="log-in" size={15}/>Sign in</a>
        </div>
      </div>
      <MkErrorFooter />
    </div>
  );
}

Object.assign(window, { SlugDisambig, AppError, MkError });
