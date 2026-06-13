/* SlugBase Marketing — Nav + Footer */

function MkNav({ page, setPage }) {
  return (
    <nav className="mk-nav">
      <div className="mk-c mk-nav-inner">
        <div className="mk-nav-logo" onClick={() => setPage("home")} style={{ cursor:"pointer" }}>
          <img src="../assets/slugbase_icon.svg" alt="SlugBase" />
          <span>SlugBase</span>
        </div>
        <div className="mk-nav-links">
          <span className="mk-nav-link" onClick={() => setPage("home")}>Features</span>
          <span className="mk-nav-link" onClick={() => setPage("pricing")}>Pricing</span>
          <span className="mk-nav-link" onClick={() => setPage("contact")}>Contact</span>
        </div>
        <div className="mk-nav-ctas">
          <a className="mk-btn mk-btn--ghost mk-btn--sm" href="../prototype/Auth.html">Sign in</a>
          <a className="mk-btn mk-btn--primary mk-btn--sm" href="../prototype/Auth.html">Get started</a>
        </div>
      </div>
    </nav>
  );
}

function MkFooter({ setPage }) {
  return (
    <footer className="mk-footer">
      <div className="mk-c">
        <div className="mk-footer-inner">
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <img src="../assets/slugbase_icon.svg" width={22} height={22} alt="" />
              <span style={{ fontWeight:600, fontSize:15, color:"var(--fg)" }}>SlugBase</span>
            </div>
            <p style={{ margin:0, fontSize:14, color:"var(--fg-subtle)", lineHeight:1.6, maxWidth:260 }}>
              Open-source bookmark manager with personal URL forwarding. Self-hostable. Keyboard-driven.
            </p>
            <div style={{ marginTop:20 }}>
              <div className="mk-footer-gdpr">
                <Icon name="shield-check" size={14} />
                <span style={{ fontSize:13, color:"var(--fg-subtle)" }}>GDPR-compliant · Hosted in the EU</span>
              </div>
            </div>
          </div>
          <div>
            <div className="mk-footer-col-head">Product</div>
            <div className="mk-footer-links">
              <span className="mk-footer-link" onClick={() => setPage("home")}>Features</span>
              <span className="mk-footer-link" onClick={() => setPage("pricing")}>Pricing</span>
              <span className="mk-footer-link" onClick={() => setPage("contact")}>Contact</span>
              <span className="mk-footer-link">Docs</span>
            </div>
          </div>
          <div>
            <div className="mk-footer-col-head">Legal</div>
            <div className="mk-footer-links">
              <span className="mk-footer-link" onClick={() => setPage("legal-impressum")}>Impressum</span>
              <span className="mk-footer-link" onClick={() => setPage("legal-datenschutz")}>Datenschutz</span>
              <span className="mk-footer-link" onClick={() => setPage("legal-agb")}>AGB</span>
            </div>
          </div>
        </div>
        <div className="mk-footer-bottom">
          <span>© 2026 SlugBase. All rights reserved.</span>
          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
            <span className="mk-oss"><Icon name="github" size={14} />Open source · AGPL-3.0</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, { MkNav, MkFooter });
