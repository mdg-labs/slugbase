/* SlugBase Marketing — Landing Page */

const HERO_DEMOS = [
  { q:"go react19", results:[
    { slug:"react19", dest:"react.dev/blog/2024/04/25/react-19" },
    { slug:"react-conf", dest:"react.dev/conf" },
  ]},
  { q:"go ddia", results:[
    { slug:"ddia", dest:"dataintensive.net" },
  ]},
  { q:"go rustperf", results:[
    { slug:"rustperf", dest:"nnethercote.github.io/perf-book" },
  ]},
];

function HeroPalette() {
  const [q, setQ] = useState("");
  const [demo, setDemo] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const target = HERO_DEMOS[demo].q;
    let i = 0;
    const typeNext = () => {
      if (cancelled) return;
      if (i <= target.length) { setQ(target.slice(0, i)); i++; setTimeout(typeNext, 70); }
      else {
        setTimeout(() => {
          if (cancelled) return;
          let j = target.length;
          const erase = () => {
            if (cancelled) return;
            if (j >= 0) { setQ(target.slice(0, j)); j--; setTimeout(erase, 30); }
            else { setDemo(d => (d + 1) % HERO_DEMOS.length); }
          };
          erase();
        }, 2000);
      }
    };
    const t = setTimeout(typeNext, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [demo]);

  const cur = HERO_DEMOS[demo];
  const isGo = /^go\s/i.test(q);
  const goSlug = isGo ? q.slice(3).trim().toLowerCase() : "";
  const results = isGo ? cur.results.filter(r => r.slug.startsWith(goSlug) || goSlug === "") : [];

  return (
    <div className="hero-pal-wrap">
      <div className="hero-pal">
        <div className="hero-pal-input">
          {isGo
            ? <><span className="hero-pal-mode"><Icon name="arrow-right" size={11}/>go</span></>
            : <Icon name="search" size={18} />}
          <span className="hero-pal-query">
            {q}<span className="cursor" />
          </span>
          <span className="mk-kbd">Esc</span>
        </div>
        <div className="hero-pal-list">
          {!q && (
            <>
              <div style={{ padding:"6px 16px 2px", fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--fg-subtle)" }}>Quick actions</div>
              {[["New bookmark","plus","C"],["Go to Bookmarks","bookmark",""],["Switch workspace","chevrons-up-down","⌥W"]].map(([label,icon,hint]) => (
                <div key={label} className="hero-pal-item">
                  <Icon name={icon} size={15} style={{ color:"var(--fg-subtle)", flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:15, color:"var(--fg-muted)" }}>{label}</span>
                  {hint && <span className="mk-kbd">{hint}</span>}
                </div>
              ))}
            </>
          )}
          {isGo && results.length > 0 && (
            <>
              <div style={{ padding:"6px 16px 2px", fontSize:11, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--fg-subtle)" }}>Slug resolution</div>
              {results.map((r, i) => (
                <div key={r.slug} className={"hero-pal-item" + (i === 0 ? " active" : "")}>
                  <span style={{ width:22, height:22, borderRadius:5, background:"var(--accent-subtle)", display:"inline-grid", placeItems:"center", flexShrink:0 }}><Icon name="link" size={12} style={{ color:"var(--accent-text)" }} /></span>
                  <span className="hero-pal-slug">go.slugbase.app/{r.slug}</span>
                  <Icon name="arrow-right" size={13} className="hero-pal-arrow" />
                  <span className="hero-pal-dest">{r.dest}</span>
                  {i === 0 && <Icon name="corner-down-left" size={13} style={{ color:"var(--fg-faint)", flexShrink:0 }} />}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="hero-pal-foot">
          <span><span className="mk-kbd">↑</span><span className="mk-kbd">↓</span> navigate</span>
          <span><span className="mk-kbd">↵</span> redirect</span>
          <span style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6 }}>
            <img src="../assets/slugbase_icon.svg" width={13} height={13} alt="" />SlugBase
          </span>
        </div>
      </div>
    </div>
  );
}

function AddressBarDemo() {
  const [step, setStep] = useState(0);
  useEffect(() => { const t = setInterval(() => setStep(s => (s + 1) % 3), 2200); return () => clearInterval(t); }, []);
  const states = [
    { url: "go.slugbase.app/", slug: "react19", label: "Navigating…" },
    { url: "go.slugbase.app/", slug: "react19", label: "Redirecting to react.dev →", dest: "react.dev/blog/react-19" },
    { url: "react.dev/blog/", slug: "react-19", label: null, final: true },
  ];
  const s = states[step];
  return (
    <div className="mk-browser">
      <div className="mk-browser-chrome">
        <div className="mk-browser-dots">
          {["#f0686b","#e6b24e","#45c98a"].map(c => <div key={c} className="mk-browser-dot" style={{ background:c }} />)}
        </div>
        <div className="mk-url-bar" style={{ flex:1, transition:"all 0.3s" }}>
          <Icon name="lock" size={11} />
          <span>{s.url}<span className="slug-part">{s.slug}</span></span>
        </div>
      </div>
      <div className="mk-url-redirect">
        {!s.final ? (
          <>
            <Icon name={step===1?"corner-down-right":"loader"} size={14} style={{ color: step===1 ? "var(--success-text)" : "var(--fg-faint)", animation: step===0 ? "spin 1s linear infinite" : "none" }} />
            <span style={{ color: step===1 ? "var(--success-text)" : "var(--fg-muted)" }}>
              {s.label}{step===1 && <> <b style={{ fontFamily:"var(--font-mono)", color:"var(--accent-text)" }}>{s.dest}</b></>}
            </span>
          </>
        ) : (
          <span style={{ color:"var(--fg-muted)" }}>Arrived at <b style={{ fontFamily:"var(--font-mono)" }}>react.dev</b> via slug <span className="mk-mono-pill">react19</span></span>
        )}
      </div>
    </div>
  );
}

function LandingPage({ setPage }) {
  return (
    <div>
      {/* ---- Hero ---- */}
      <section className="mk-hero">
        <div className="mk-c">
          <div className="mk-hero-tag"><Icon name="zap" size={13} />Open source · Self-hostable · AGPL</div>
          <h1 className="mk-h1">Every bookmark<br /><span className="mk-accent">gets a short link.</span></h1>
          <p className="mk-hero-sub">SlugBase is a keyboard-driven bookmark manager. Assign a slug to any link, then jump to it anywhere by typing <span className="mk-mono-pill">go.slugbase.app/react19</span> — or invoke the palette and type <span className="mk-mono-pill">go react19</span>.</p>
          <div className="mk-hero-ctas">
            <a className="mk-btn mk-btn--primary mk-btn--lg" href="../prototype/Auth.html"><Icon name="arrow-right" size={18} />Get started free</a>
            <a className="mk-btn mk-btn--secondary mk-btn--lg"><Icon name="github" size={18} />Self-host for free</a>
          </div>
          <HeroPalette />
        </div>
      </section>

      {/* ---- Slug mechanic ---- */}
      <section className="mk-section mk-section--alt">
        <div className="mk-c">
          <div className="mk-split">
            <div className="mk-split-text">
              <span className="mk-eyebrow">Slug forwarding</span>
              <h2 className="mk-h2">Type a slug, land anywhere.</h2>
              <p>Every bookmark can have a personal short slug. Type it in your address bar, invoke the command palette, or configure it as a browser search engine shortcut. One keystroke, anywhere you are.</p>
              <ul className="mk-list-check">
                <li><Icon name="check" size={15} />Personal slugs on <span className="mk-mono-pill">go.slugbase.app/&lt;slug&gt;</span></li>
                <li><Icon name="check" size={15} />Set as browser search engine: type <span className="mk-mono-pill">s react19</span> in the address bar</li>
                <li><Icon name="check" size={15} />Works on custom domains for self-hosted instances</li>
              </ul>
            </div>
            <AddressBarDemo />
          </div>
        </div>
      </section>

      {/* ---- Bookmark manager ---- */}
      <section className="mk-section">
        <div className="mk-c">
          <div className="mk-section-head">
            <span className="mk-eyebrow">Bookmark manager</span>
            <h2 className="mk-h2">Organize everything. Find it instantly.</h2>
            <p className="mk-body">Save links, assign folders and tags, pin what matters. All your bookmarks, one keyboard shortcut away.</p>
          </div>
          <div className="mk-features">
            {[
              { icon:"folder", title:"Folders", desc:"Group bookmarks into folders with colored indicators. Share specific folders with teammates." },
              { icon:"hash", title:"Tags", desc:"Multi-tag any bookmark. Filter by one or many tags across folders and scope." },
              { icon:"pin", title:"Pinned bookmarks", desc:"Pin your most-used links to the top. They surface first in the palette and on the dashboard." },
              { icon:"share-2", title:"Sharing scope", desc:"Each bookmark can be private, shared with specific people, or shared with the whole team workspace." },
            ].map(f => (
              <div key={f.title} className="mk-feat">
                <div className="mk-feat-icon"><Icon name={f.icon} size={18} /></div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Command palette ---- */}
      <section className="mk-section mk-section--alt">
        <div className="mk-c">
          <div className="mk-split mk-split--rev">
            <div className="mk-split-text">
              <span className="mk-eyebrow">Command palette</span>
              <h2 className="mk-h2">⌘K. The only shortcut you need.</h2>
              <p>Press <span className="mk-mono-pill">⌘K</span> from anywhere in the app. Search bookmarks, jump to a slug, switch workspaces, or run any action — without lifting your hands from the keyboard.</p>
              <ul className="mk-list-check">
                <li><Icon name="check" size={15} />Type to search bookmarks, folders, and tags</li>
                <li><Icon name="check" size={15} /><span className="mk-mono-pill">go &lt;slug&gt;</span> mode triggers instant redirect</li>
                <li><Icon name="check" size={15} />Keyboard shortcuts for every action</li>
                <li><Icon name="check" size={15} />Slug disambiguation when multiple bookmarks share a slug</li>
              </ul>
            </div>
            <div className="mk-code">
              <div style={{ color:"var(--fg-subtle)", marginBottom:12, fontSize:12, display:"flex", alignItems:"center", gap:8 }}><Icon name="terminal" size={13} />Command palette — ⌘K</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, fontFamily:"var(--font-mono)", fontSize:13 }}>
                <div><span className="cmd">❯</span> <span className="slug-c">go react19</span></div>
                <div style={{ color:"var(--fg-faint)", paddingLeft:16 }}>→ react.dev/blog/2024/04/25/react-19</div>
                <div style={{ marginTop:8 }}><span className="cmd">❯</span> <span style={{ color:"var(--fg-muted)" }}>designing data</span></div>
                <div style={{ color:"var(--fg-faint)", paddingLeft:16 }}>Designing Data-Intensive Applications — notes</div>
                <div style={{ paddingLeft:16, color:"var(--fg-faint)" }}>go.slugbase.app/ddia</div>
                <div style={{ marginTop:8 }}><span className="cmd">❯</span> <span style={{ color:"var(--fg-muted)" }}>new bookmark</span> <span style={{ color:"var(--fg-faint)" }}>C</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Team sharing ---- */}
      <section className="mk-section">
        <div className="mk-c">
          <div className="mk-split">
            <div className="mk-split-text">
              <span className="mk-eyebrow">Team workspaces</span>
              <h2 className="mk-h2">Share bookmarks and slugs with your team.</h2>
              <p>Create shared workspaces. Assign team members with role-based access. Share folders and bookmarks selectively — the rest stays private. Shared slugs forward for every team member who has access.</p>
              <ul className="mk-list-check">
                <li><Icon name="check" size={15} />Multiple workspaces per account</li>
                <li><Icon name="check" size={15} />Owner / admin / member roles</li>
                <li><Icon name="check" size={15} />Shared folders with granular member access</li>
                <li><Icon name="check" size={15} />Audit log for all workspace actions (Team plan)</li>
              </ul>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {[
                { folder:"Dev Tools", color:"#45c98a", shared:"Team",    members:4, count:9 },
                { folder:"Design",    color:"#f0686b", shared:"Sarah K., Tom R.", members:2, count:5 },
                { folder:"Inbox",     color:"#7782f7", shared:"Private", members:0, count:6 },
              ].map(f => (
                <div key={f.folder} style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 18px", background:"var(--raised)", border:"1px solid var(--border-subtle)", borderRadius:"var(--r-lg)" }}>
                  <span style={{ width:10, height:10, borderRadius:3, background:f.color, flexShrink:0 }} />
                  <span style={{ fontWeight:600, color:"var(--fg)", flex:1 }}>{f.folder}</span>
                  <span style={{ fontSize:12, color:"var(--fg-subtle)", fontFamily:"var(--font-mono)" }}>{f.count} bookmarks</span>
                  <span style={{ fontSize:11, color: f.shared==="Private" ? "var(--fg-faint)" : "var(--success-text)", display:"flex", alignItems:"center", gap:4 }}>
                    <Icon name={f.shared==="Private"?"lock":"users"} size={11}/>{f.shared}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Self-hosted ---- */}
      <section className="mk-section mk-section--alt">
        <div className="mk-c">
          <div className="mk-split">
            <div className="mk-split-text">
              <span className="mk-eyebrow">Self-hosted & open source</span>
              <h2 className="mk-h2">Your data. Your server. Your rules.</h2>
              <p>SlugBase is AGPL-3.0 licensed and available on GitHub. Run it on your own infrastructure with a single container. Embedded SQLite database — no external dependencies required.</p>
              <ul className="mk-list-check">
                <li><Icon name="check" size={15} />Single Docker container, embeds SQLite</li>
                <li><Icon name="check" size={15} />Custom forwarding domain</li>
                <li><Icon name="check" size={15} />OIDC / federated identity support</li>
                <li><Icon name="check" size={15} />Full feature parity with hosted</li>
              </ul>
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginTop:8 }}>
                <a className="mk-btn mk-btn--secondary mk-btn--sm"><Icon name="github" size={14}/>View on GitHub</a>
                <a className="mk-btn mk-btn--ghost mk-btn--sm"><Icon name="book-open" size={14}/>Read the docs</a>
              </div>
            </div>
            <div className="mk-code">
              <div style={{ color:"var(--fg-subtle)", marginBottom:12, fontSize:12, display:"flex", alignItems:"center", gap:8 }}><Icon name="terminal" size={13} />Get started in one command</div>
              <div className="cmd">docker run \</div>
              <div style={{ paddingLeft:16, color:"var(--fg-muted)" }}>-p 3000:3000 \</div>
              <div style={{ paddingLeft:16, color:"var(--fg-muted)" }}>-v ./data:/app/data \</div>
              <div style={{ paddingLeft:16, color:"var(--fg-muted)" }}>-e BASE_URL=https://go.acme.com \</div>
              <div style={{ paddingLeft:16 }}><span className="slug-c">ghcr.io/slugbase/slugbase:latest</span></div>
              <div style={{ marginTop:14, color:"var(--fg-faint)" }} className="comment"># SQLite embedded. No Postgres. No Redis.</div>
              <div style={{ color:"var(--fg-faint)" }} className="comment"># First run creates the owner account.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Pricing teaser ---- */}
      <section className="mk-section">
        <div className="mk-c">
          <div className="mk-section-head">
            <span className="mk-eyebrow">Pricing</span>
            <h2 className="mk-h2">Start free. Stay free.</h2>
            <p className="mk-body">The hosted service has a generous Free tier. Personal and Team plans unlock unlimited bookmarks, API access, and collaboration. Self-hosting is always free.</p>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16 }}>
            {[
              { name:"Free", price:"$0", desc:"Up to 50 bookmarks. Personal slugs. Forever free.", features:["50 bookmarks","Personal slugs","Folders & tags","Keyboard palette"] },
              { name:"Personal", price:"$4", period:"/mo", featured:true, desc:"Unlimited bookmarks and slugs for solo power users.", features:["Unlimited bookmarks","Unlimited slugs","API access","Custom slug domains"] },
              { name:"Team", price:"$9", period:"/seat/mo", desc:"Shared workspaces, role-based access, audit log.", features:["Everything in Personal","Team workspaces","Shared folders & slugs","Audit log + SSO"] },
            ].map(p => (
              <div key={p.name} style={{ padding:"28px 28px 24px", background: p.featured ? "var(--raised)" : "var(--canvas)", border:`1px solid ${p.featured ? "var(--accent-border)" : "var(--border-subtle)"}`, borderRadius:"var(--r-xl)", display:"flex", flexDirection:"column", gap:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontWeight:700, fontSize:16, color:"var(--fg)" }}>{p.name}</span>
                  {p.featured && <span style={{ height:18, padding:"0 7px", background:"var(--accent-subtle)", color:"var(--accent-text)", borderRadius:99, fontSize:10, fontWeight:600, display:"grid", placeItems:"center", border:"1px solid var(--accent-border)", letterSpacing:"0.06em", textTransform:"uppercase" }}>Popular</span>}
                </div>
                <div><span style={{ fontSize:28, fontWeight:700, fontFamily:"var(--font-mono)", color:"var(--fg)", letterSpacing:"-0.03em" }}>{p.price}</span><span style={{ fontSize:13, color:"var(--fg-subtle)" }}>{p.period}</span></div>
                <p style={{ margin:0, fontSize:13, color:"var(--fg-subtle)", lineHeight:1.5 }}>{p.desc}</p>
                <ul style={{ listStyle:"none", padding:0, margin:0, display:"flex", flexDirection:"column", gap:6 }}>
                  {p.features.map(f => <li key={f} style={{ display:"flex", gap:8, fontSize:13, color:"var(--fg-muted)" }}><Icon name="check" size={14} style={{ color:"var(--success-text)", flexShrink:0, marginTop:1 }}/>{f}</li>)}
                </ul>
                <button className={"mk-btn mk-btn--sm" + (p.featured ? " mk-btn--primary" : " mk-btn--secondary")} style={{ marginTop:"auto" }}>{p.name==="Free" ? "Get started free" : `Upgrade to ${p.name}`}</button>
              </div>
            ))}
          </div>
          <div style={{ textAlign:"center", marginTop:32 }}>
            <span className="mk-btn mk-btn--ghost mk-btn--sm" style={{ cursor:"pointer" }} onClick={() => setPage("pricing")}>See full pricing comparison →</span>
          </div>
        </div>
      </section>

      {/* ---- Final CTA ---- */}
      <section className="mk-section--cta">
        <div className="mk-c" style={{ textAlign:"center" }}>
          <h2 className="mk-h2">Your bookmarks, a short link away.</h2>
          <p className="mk-body" style={{ margin:"16px auto 36px", maxWidth:420 }}>Sign up on the hosted service or self-host in five minutes. No lock-in.</p>
          <div className="mk-hero-ctas">
            <a className="mk-btn mk-btn--primary mk-btn--lg" href="../prototype/Auth.html"><Icon name="arrow-right" size={18}/>Get started free</a>
            <a className="mk-btn mk-btn--ghost mk-btn--lg"><Icon name="github" size={18}/>Self-host</a>
          </div>
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { LandingPage });
