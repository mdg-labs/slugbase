/* SlugBase — Onboarding flow + Workspace Switcher/Create */

/* ---- Onboarding (4-step fullscreen flow) ---- */
function OnboardingFlow({ onDone }) {
  const [step, setStep] = useState(0); // 0–3
  const [fileReady, setFileReady] = useState(false);
  const [drag, setDrag] = useState(false);
  const [shortcutCopied, setShortcutCopied] = useState(false);
  const [skipped, setSkipped] = useState({ import: false, shortcut: false });
  const TOTAL = 4;
  const SHORTCUT_URL = "go.slugbase.app/go/%s";

  const next = () => { if (step < TOTAL - 1) setStep(s => s + 1); else onDone(); };
  const skip = (key) => { setSkipped(s => ({ ...s, [key]: true })); setStep(st => st + 1); };
  const copyShortcut = () => { navigator.clipboard.writeText(SHORTCUT_URL).catch(() => {}); setShortcutCopied(true); setTimeout(() => setShortcutCopied(false), 2000); };

  const STEPS = [
    {
      eyebrow: "First login",
      title: "Welcome to SlugBase.",
      body: null,
      content: (
        <div style={{ display:"flex", flexDirection:"column", gap:"var(--sp-5)" }}>
          <p className="onb-body">
            Your workspace <b style={{ color:"var(--fg)" }}>Acme Engineering</b> is ready. SlugBase lets you save bookmarks, assign personal short slugs, and jump to any link directly from your address bar or keyboard.
          </p>
          <div style={{ display:"flex", gap:"var(--sp-4)", flexWrap:"wrap", padding:"var(--sp-5)", background:"var(--raised)", borderRadius:"var(--r-md)", border:"1px solid var(--border-subtle)" }}>
            {[["26","Bookmarks ready to import","bookmark"],["1","Workspace created","building-2"],["∞","Slugs you can create","link"]].map(([n,l,ic])=>(
              <div key={l} style={{ flex:1, minWidth:100, display:"flex", flexDirection:"column", gap:"var(--sp-2)", alignItems:"center", textAlign:"center" }}>
                <span style={{ font:"700 22px/1 var(--font-mono)", color:"var(--accent-text)" }}>{n}</span>
                <span style={{ fontSize:"var(--text-small)", color:"var(--fg-subtle)" }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      ),
      cta: "Get started",
      noSkip: true,
    },
    {
      eyebrow: "Step 2 of 4",
      title: "Import your bookmarks",
      content: (
        <div style={{ display:"flex", flexDirection:"column", gap:"var(--sp-5)" }}>
          <p className="onb-body">Drop a browser export and your bookmarks will be imported in one go. Or start fresh — you can always import later.</p>
          <div className={"drop-zone" + (drag ? " drag" : "") + (fileReady ? " drag" : "")}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); setFileReady(true); }}
            onClick={() => setFileReady(true)}>
            {fileReady ? (
              <div className="drop-file-name"><Icon name="check-circle" size={18}/> bookmarks_export.html ready</div>
            ) : (
              <>
                <Icon name="cloud-upload" size={32} strokeWidth={1.5} />
                <div className="drop-zone-label"><b>Drop a file here</b> or click to browse</div>
                <div className="drop-zone-sub">Netscape HTML (.html) or JSON export · Chrome, Firefox, Safari</div>
                <button className="btn btn--secondary btn--sm" onClick={e => { e.stopPropagation(); setFileReady(true); }}><Icon name="folder-open" size={14}/>Browse files</button>
              </>
            )}
          </div>
          {fileReady && (
            <div style={{ display:"flex", gap:"var(--sp-3)", fontSize:"var(--text-small)", color:"var(--success-text)", alignItems:"center" }}>
              <Icon name="check-circle" size={14}/>Ready to import 248 bookmarks from Chrome
            </div>
          )}
        </div>
      ),
      cta: fileReady ? "Import & continue" : "Continue without importing",
      skipKey: "import",
    },
    {
      eyebrow: "Step 3 of 4",
      title: "Set up the browser shortcut",
      content: (
        <div className="browser-steps">
          <p className="onb-body">Type <b style={{ fontFamily:"var(--font-mono)", color:"var(--fg)" }}>s react19</b> in your browser address bar to jump to any slug instantly. Takes 30 seconds to set up.</p>
          <div className="bstep">
            <span className="bstep-num">1</span>
            <div className="bstep-body">
              <div className="bstep-label">Open Chrome search engine settings</div>
              <div className="chrome-bar"><Icon name="search" size={12}/>chrome://settings/searchEngines</div>
            </div>
          </div>
          <div className="bstep">
            <span className="bstep-num">2</span>
            <div className="bstep-body">
              <div className="bstep-label">Add a new search engine</div>
              <div className="bstep-sub">Click "Add" and fill in the fields:</div>
              {[["Name","SlugBase"],["Keyword","s"],["URL with %s",SHORTCUT_URL]].map(([fl,fv])=>(
                <div key={fl} className="chrome-field-row">
                  <span className="fl">{fl}</span>
                  <div className="fv">
                    <span style={{ flex:1 }}>{fv}</span>
                    {fl==="URL with %s" && <button className="btn btn--secondary btn--sm" style={{padding:"0 var(--sp-3)",height:22,fontSize:11}} onClick={copyShortcut}><Icon name={shortcutCopied?"check":"copy"} size={12}/>{shortcutCopied?"Copied":"Copy"}</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bstep">
            <span className="bstep-num">3</span>
            <div className="bstep-body">
              <div className="bstep-label">Test it</div>
              <div className="bstep-sub">Type <b style={{ fontFamily:"var(--font-mono)" }}>s react19</b> in the address bar and press Enter. It should redirect to <b style={{ fontFamily:"var(--font-mono)", color:"var(--accent-text)" }}>go.slugbase.app/go/react19</b>.</div>
            </div>
          </div>
        </div>
      ),
      cta: "Done, continue",
      skipKey: "shortcut",
    },
    {
      eyebrow: "All set",
      title: "You're ready.",
      content: (
        <div className="onb-check-list">
          <div className="onb-check-item"><Icon name="check-circle" size={18}/>Workspace <b style={{ color:"var(--fg)", marginLeft:4 }}>Acme Engineering</b> created</div>
          <div className={"onb-check-item" + (skipped.import ? " skip" : "")}>
            <Icon name={skipped.import ? "minus" : "check-circle"} size={18}/>
            {skipped.import ? "Bookmark import skipped — do it any time from the dashboard" : "248 bookmarks imported from Chrome"}
          </div>
          <div className={"onb-check-item" + (skipped.shortcut ? " skip" : "")}>
            <Icon name={skipped.shortcut ? "minus" : "check-circle"} size={18}/>
            {skipped.shortcut ? "Browser shortcut not set up — available in Settings" : "Browser shortcut configured (keyword: s)"}
          </div>
        </div>
      ),
      cta: "Go to dashboard",
      noSkip: true,
    },
  ];

  const s = STEPS[step];
  return (
    <div className="onb">
      <div className="onb-inner">
        <div className="onb-mark"><img src="../assets/slugbase_icon.svg" alt="" /></div>
        <div className="onb-progress">
          {STEPS.map((_, i) => <div key={i} className={"onb-dot" + (i === step ? " active" : i < step ? " done" : "")} />)}
        </div>
        <div className="onb-card" key={step}>
          <span className="onb-eyebrow">{s.eyebrow}</span>
          <h2 className="onb-title">{s.title}</h2>
          {s.content}
          <div className="onb-actions">
            <button className="btn btn--primary" onClick={next}>{s.cta}</button>
            {!s.noSkip && s.skipKey && <span className="onb-skip" onClick={() => skip(s.skipKey)}>Skip for now</span>}
          </div>
          <div className="onb-step-num">{step + 1} / {TOTAL}</div>
        </div>
      </div>
    </div>
  );
}

/* ---- Workspace Switcher Overlay ---- */
const WS_LIST = [
  { id:"personal",  name:"Personal",          letter:"P", color:"#7782f7", role:"Owner",  plan:"Free",   active:true  },
  { id:"acme",      name:"Acme Engineering",  letter:"A", color:"#45c98a", role:"Admin",  plan:"Team",   active:false },
  { id:"side",      name:"Side Projects",     letter:"S", color:"#e6b24e", role:"Member", plan:"Pro",    active:false },
];

function WorkspaceSwitcherOverlay({ variant, setVariant, toast }) {
  // variant: "open" | "loading" | "create" | "create-blocked"
  const [newName, setNewName] = useState("");
  const [switching, setSwitching] = useState(null);

  const doSwitch = (ws) => {
    setSwitching(ws);
    setVariant("loading");
    setTimeout(() => { setVariant("open"); setSwitching(null); toast({ icon:"building-2", title:`Switched to ${ws.name}` }); }, 1600);
  };
  const create = () => { if (!newName.trim()) return; toast({ icon:"building-2", title:`Workspace "${newName}" created` }); setNewName(""); setVariant("open"); };

  return (
    <div className="ws-overlay">
      <div className="ws-overlay-backdrop" onClick={() => setVariant("open")} />
      {(variant === "open") && (
        <div className="ws-panel">
          <div className="ws-panel-head">Workspaces</div>
          {WS_LIST.map(ws => (
            <div key={ws.id} className={"ws-item" + (ws.active ? " active" : "")} onClick={() => !ws.active && doSwitch(ws)}>
              <div className="ws-avatar" style={{ background:ws.color }}>{ws.letter}</div>
              <div className="ws-info">
                <div className="ws-name">{ws.name}</div>
                <div className="ws-role">
                  <span className={"badge " + (ws.plan==="Team" ? "badge--success" : ws.plan==="Pro" ? "badge--accent" : "badge--neutral")} style={{ height:16, fontSize:10 }}>{ws.plan}</span>
                  {ws.role}
                </div>
              </div>
              {ws.active && <Icon name="check" size={15} style={{ color:"var(--accent-text)", flexShrink:0 }} />}
            </div>
          ))}
          <div className="ws-panel-foot">
            <div className="menu-sep" style={{ marginTop:0, marginBottom:"var(--sp-3)" }} />
            <div className="menu-item" onClick={() => setVariant("create")}><Icon name="plus" size={15}/>Create workspace</div>
          </div>
        </div>
      )}
      {variant === "loading" && (
        <div className="ws-switching">
          <div className="ws-switching-ic"><Icon name="loader" size={22} className="spin" /></div>
          <span style={{ fontSize:"var(--text-body)", color:"var(--fg-muted)" }}>Switching to <b style={{ color:"var(--fg)" }}>{switching?.name}</b>…</span>
        </div>
      )}
      {(variant === "create" || variant === "create-blocked") && (
        <div className="create-ws-scrim">
          <div className="create-ws-card">
            <h3>{variant === "create-blocked" ? "Upgrade to create more workspaces" : "Create workspace"}</h3>
            {variant === "create-blocked" ? (
              <>
                <p style={{ margin:0, color:"var(--fg-muted)", fontSize:"var(--text-body)", lineHeight:1.6 }}>Your Free plan includes one workspace. Upgrade to Personal or Team to create additional workspaces.</p>
                <div style={{ display:"flex", gap:"var(--sp-4)" }}>
                  <button className="btn btn--primary btn--sm" onClick={() => toast({ icon:"zap", title:"Upgrade to Personal" })}><Icon name="zap" size={14}/>Upgrade to Personal</button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setVariant("open")}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="fg"><label className="lbl">Workspace name</label>
                  <div className="field ff" style={{ height:36 }}><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Side Projects" autoFocus /></div>
                </div>
                <div style={{ display:"flex", gap:"var(--sp-4)" }}>
                  <button className="btn btn--primary btn--sm" disabled={!newName.trim()} style={!newName.trim()?{opacity:.4,cursor:"not-allowed"}:undefined} onClick={create}><Icon name="plus" size={14}/>Create workspace</button>
                  <button className="btn btn--ghost btn--sm" onClick={() => setVariant("open")}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { OnboardingFlow, WorkspaceSwitcherOverlay });
