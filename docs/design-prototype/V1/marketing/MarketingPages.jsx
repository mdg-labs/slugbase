/* SlugBase Marketing — Pricing, Contact, Legal pages */

/* ---- Shared countdown hook ---- */
function useMkCountdown(target) {
  const [diff, setDiff] = useState(() => Math.max(0, target - Date.now()));
  useEffect(() => { const t = setInterval(() => setDiff(Math.max(0, target - Date.now())), 1000); return () => clearInterval(t); }, [target]);
  return { d: Math.floor(diff / 86400000), h: Math.floor(diff % 86400000 / 3600000), m: Math.floor(diff % 3600000 / 60000), s: Math.floor(diff % 60000 / 1000) };
}

const MK_FEATURES = [
  { label:"Bookmarks",         free:"50",        personal:"Unlimited",  team:"Unlimited"  },
  { label:"Forwarding slugs",  free:"✓",         personal:"✓",          team:"✓"          },
  { label:"Custom slugs",      free:"—",         personal:"✓",          team:"✓"          },
  { label:"Folders",           free:"3",         personal:"Unlimited",  team:"Unlimited"  },
  { label:"Tags",              free:"Unlimited", personal:"Unlimited",  team:"Unlimited"  },
  { label:"API access",        free:"—",         personal:"✓",          team:"✓"          },
  { label:"Shared workspaces", free:"—",         personal:"—",          team:"✓"          },
  { label:"Members",           free:"1",         personal:"1",          team:"Up to 25"   },
  { label:"SSO / OIDC",        free:"—",         personal:"—",          team:"✓"          },
  { label:"Audit log",         free:"—",         personal:"—",          team:"✓"          },
  { label:"Price",             free:"Free",      personal:"$4/mo",      team:"$9/seat/mo" },
];

const FAQ_ITEMS = [
  { q:"What happens if I exceed the Free bookmark limit?", a:"Your existing bookmarks and slugs continue to work unchanged. New bookmark creation is paused. Excess bookmarks are archived — not deleted — when you downgrade from a paid plan. They are restored automatically when you upgrade or re-subscribe." },
  { q:"What is the difference between Personal and Team?", a:"Personal is for individual use: unlimited bookmarks, slugs, and API access for one account. Team adds shared workspaces, role-based member management (up to 25 members), shared folders and slugs, SSO/OIDC, and audit logging." },
  { q:"Can I switch plans at any time?", a:"Yes. Upgrades take effect immediately with prorated billing. Downgrades take effect at the end of the current billing period. Your bookmarks and slugs are never affected by a plan change." },
  { q:"What happens if I cancel?", a:"Your paid plan remains active until the end of the billing period. After that, your workspace returns to Free. If you have more than 50 bookmarks, the excess are archived (not deleted) and restored automatically if you re-subscribe." },
  { q:"Is self-hosted really free?", a:"Yes. SlugBase is AGPL-3.0 licensed. You can run it on your own infrastructure at no cost, with no seat limits, no bookmark caps, and full feature parity. You are responsible for hosting costs and maintenance." },
  { q:"Where is my data hosted?", a:"The SlugBase hosted service stores all data in EU-based infrastructure (Frankfurt). Data is encrypted at rest and in transit. No data is transferred outside the EU. Full details are in the Datenschutzerklärung." },
];

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mk-faq-item">
      <div className="mk-faq-q" onClick={() => setOpen(o => !o)}>
        <span>{q}</span><Icon name={open ? "chevron-up" : "chevron-down"} size={18} />
      </div>
      {open && <div className="mk-faq-a">{a}</div>}
    </div>
  );
}

function MkPlanCell({ v, featured }) {
  const base = { padding:"14px 18px", fontSize:14, color:"var(--fg-muted)", borderLeft:"1px solid var(--border-subtle)", display:"flex", alignItems:"center", background: featured ? "rgba(119,130,247,0.04)" : "transparent" };
  if (v === "✓") return <div style={base}><Icon name="check" size={15} style={{ color:"var(--success-text)" }}/></div>;
  if (v === "—") return <div style={{...base, color:"var(--fg-faint)"}}>—</div>;
  return <div style={{...base, fontFamily:"var(--font-mono)", fontSize:13}}>{v}</div>;
}

/* ---- PRICING PAGE ---- */
function PricingPage({ setPage }) {
  const [yearly, setYearly] = useState(false);
  const target = new Date("2026-07-04T23:59:59Z").getTime();
  const { d, h, m, s } = useMkCountdown(target);

  const prices = {
    free:     { mo: "$0",    yr: "$0"    },
    personal: { mo: "$4/mo", yr: "$3.33/mo" },
    team:     { mo: "$9/seat/mo", yr: "$7.50/seat/mo" },
  };

  return (
    <div>
      <section className="mk-section">
        <div className="mk-c">
          <div className="mk-section-head">
            <span className="mk-eyebrow">Pricing</span>
            <h1 className="mk-h2" style={{ fontSize:"clamp(32px,4vw,48px)", letterSpacing:"-0.025em" }}>Honest pricing. No surprises.</h1>
            <p className="mk-body" style={{ marginTop:12 }}>Start free, self-host for nothing, or pay for more when you need it.</p>
          </div>

          {/* Billing toggle */}
          <div className="mk-billing-toggle">
            <div className="mk-billing-seg">
              <button className={!yearly ? "on" : ""} onClick={() => setYearly(false)}>Monthly</button>
              <button className={yearly ? "on" : ""} onClick={() => setYearly(true)}>Yearly</button>
            </div>
            {yearly && <span className="mk-save-badge"><Icon name="trending-down" size={12}/>2 months free</span>}
          </div>

          {/* Plan comparison */}
          <div className="mk-plans">
            {[
              { id:"free", name:"Free", price: prices.free[yearly?"yr":"mo"], desc:"Personal use, up to 50 bookmarks.", cta:"Get started free", ctaClass:"mk-btn--secondary" },
              { id:"personal", name:"Personal", price: prices.personal[yearly?"yr":"mo"], desc:"Unlimited for solo power users.", cta:"Upgrade to Personal", ctaClass:"mk-btn--primary", featured:true },
              { id:"team", name:"Team", price: prices.team[yearly?"yr":"mo"], desc:"Collaboration for small teams.", cta:"Upgrade to Team", ctaClass:"mk-btn--secondary" },
            ].map(p => (
              <div key={p.id} className={"mk-plan" + (p.featured ? " featured" : "")}>
                <div className="mk-plan-name">{p.name}</div>
                <div className="mk-plan-price">{p.price.split("/")[0]}<span>/{p.price.split("/")[1]}</span></div>
                {yearly && p.id !== "free" && <div style={{ fontSize:12, color:"var(--success-text)", marginTop:-6, marginBottom:8, display:"flex", alignItems:"center", gap:4 }}><Icon name="check" size={11}/>Billed annually</div>}
                <p className="mk-plan-desc">{p.desc}</p>
                <ul className="mk-plan-feats">
                  {p.id === "free" && [["50 bookmarks","check"],["Forwarding slugs","check"],["3 folders","check"],["Keyboard palette","check"],["API access","minus"],["Team workspaces","minus"]].map(([t,ic])=>(
                    <li key={t} className={ic==="minus"?"dim":""}><Icon name={ic==="minus"?"minus":"check"} size={14}/>{t}</li>
                  ))}
                  {p.id === "personal" && [["Unlimited bookmarks","check"],["Unlimited slugs","check"],["Unlimited folders & tags","check"],["API access","check"],["Custom slug domains","check"],["Team workspaces","minus"]].map(([t,ic])=>(
                    <li key={t} className={ic==="minus"?"dim":""}><Icon name={ic==="minus"?"minus":"check"} size={14}/>{t}</li>
                  ))}
                  {p.id === "team" && [["Everything in Personal","check"],["Team workspaces","check"],["Up to 25 members","check"],["Shared folders & slugs","check"],["SSO / OIDC","check"],["Audit log","check"]].map(([t,ic])=>(
                    <li key={t}><Icon name={ic} size={14}/>{t}</li>
                  ))}
                </ul>
                <button className={"mk-btn " + p.ctaClass}>{p.cta}</button>
              </div>
            ))}
          </div>

          {/* Full feature table */}
          <div style={{ marginTop:48, border:"1px solid var(--border-subtle)", borderRadius:"var(--r-lg)", overflow:"hidden" }}>
            <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", background:"var(--raised)", borderBottom:"1px solid var(--border-subtle)" }}>
              <div style={{ padding:"12px 18px", fontSize:12, fontWeight:600, color:"var(--fg-subtle)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Feature</div>
              {["Free","Personal","Team"].map((n,i) => <div key={n} style={{ padding:"12px 18px", fontSize:14, fontWeight:600, color: i===1 ? "var(--accent-text)" : "var(--fg)", borderLeft:"1px solid var(--border-subtle)", background: i===1 ? "rgba(119,130,247,0.06)" : "transparent" }}>{n}</div>)}
            </div>
            {MK_FEATURES.map(f => (
              <div key={f.label} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", borderBottom:"1px solid var(--border-subtle)" }}>
                <div style={{ padding:"12px 18px", fontSize:14, fontWeight:500, color:"var(--fg-muted)" }}>{f.label}</div>
                <MkPlanCell v={f.free} />
                <MkPlanCell v={f.personal} featured />
                <MkPlanCell v={f.team} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Supporter card */}
      <section className="mk-section--sm mk-section--alt">
        <div className="mk-c">
          <div className="mk-supporter">
            <div style={{ position:"relative" }}>
              <div style={{ display:"inline-flex", alignItems:"center", gap:8, padding:"3px 12px", borderRadius:99, background:"var(--accent)", color:"var(--accent-fg)", fontSize:11, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:16 }}><Icon name="zap" size={11}/>Early supporter offer · Limited time</div>
              <div className="mk-supporter-price">$59 <span style={{ fontSize:16, fontWeight:400, color:"var(--fg-muted)" }}>one time · yours forever</span></div>
              <p style={{ margin:"12px 0 20px", fontSize:17, color:"var(--fg-muted)", lineHeight:1.6, maxWidth:440 }}>Everything in Personal — unlimited bookmarks, custom slugs, API access — permanently. One payment, no subscription, no renewal.</p>
              <button className="mk-btn mk-btn--primary mk-btn--lg"><Icon name="zap" size={16}/>Claim lifetime access — $59</button>
            </div>
            <div>
              <div style={{ fontSize:13, color:"var(--fg-subtle)", marginBottom:10, fontWeight:500 }}>Offer expires in</div>
              <div className="countdown" style={{ gap:12 }}>
                {[[d,"days"],[h,"hrs"],[m,"min"],[s,"sec"]].map(([n,lbl], i, arr) => (
                  <React.Fragment key={lbl}>
                    <div className="countdown-unit"><span className="countdown-n">{String(n).padStart(2,"0")}</span><span className="countdown-label">{lbl}</span></div>
                    {i < arr.length-1 && <span className="countdown-sep">:</span>}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Self-hosted callout */}
      <section className="mk-section--sm">
        <div className="mk-c">
          <div className="mk-selfhost">
            <div className="mk-selfhost-icon"><Icon name="server" size={24}/></div>
            <div style={{ flex:1 }}>
              <h3 style={{ margin:"0 0 6px", fontWeight:600, fontSize:18, color:"var(--fg)" }}>Self-hosted is always free.</h3>
              <p style={{ margin:0, fontSize:15, color:"var(--fg-muted)", lineHeight:1.6 }}>SlugBase is AGPL-3.0. Run it on your own server — no seat limits, no bookmark caps, no billing. Docker image, single container, embedded SQLite.</p>
            </div>
            <div style={{ display:"flex", gap:10, flexShrink:0 }}>
              <a className="mk-btn mk-btn--secondary mk-btn--sm"><Icon name="github" size={14}/>GitHub</a>
              <a className="mk-btn mk-btn--ghost mk-btn--sm"><Icon name="book-open" size={14}/>Docs</a>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mk-section mk-section--alt">
        <div className="mk-c--narrow">
          <div className="mk-section-head" style={{ marginBottom:40 }}>
            <span className="mk-eyebrow">FAQ</span>
            <h2 className="mk-h2">Common questions</h2>
          </div>
          <div className="mk-faq">{FAQ_ITEMS.map(it => <FAQItem key={it.q} {...it} />)}</div>
        </div>
      </section>
    </div>
  );
}

/* ---- CONTACT PAGE ---- */
function TurnstileWidget() {
  const [done, setDone] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDone(true), 1800); return () => clearTimeout(t); }, []);
  return (
    <div className="turnstile-widget">
      {done ? <div className="cf-check"><Icon name="check" size={14} style={{ color:"#fff" }}/></div> : <div className="cf-spinner" />}
      <div>
        <div style={{ fontSize:13, fontWeight:500, color: done ? "var(--fg)" : "var(--fg-muted)" }}>{done ? "Verification complete" : "Checking your browser…"}</div>
        <div style={{ fontSize:11, color:"var(--fg-subtle)", marginTop:2 }}>Protected by Cloudflare Turnstile</div>
      </div>
      <div style={{ marginLeft:"auto", fontSize:11, color:"var(--fg-faint)", display:"flex", alignItems:"center", gap:5 }}>
        <div style={{ width:14, height:14, borderRadius:3, background:"#f38020", display:"grid", placeItems:"center" }}><Icon name="shield" size={9} style={{ color:"#fff" }}/></div>Cloudflare
      </div>
    </div>
  );
}

function ContactPage() {
  const [name, setName]       = useState("Alex Kerr");
  const [email, setEmail]     = useState("alex@inboxops.app");
  const [topic, setTopic]     = useState("support");
  const [message, setMessage] = useState("");
  const [sent, setSent]       = useState(false);

  if (sent) return (
    <section className="mk-section"><div className="mk-c--narrow">
      <div className="mk-success">
        <div className="mk-success-ic"><Icon name="check" size={28}/></div>
        <h2 className="mk-h2" style={{ margin:0 }}>Message sent</h2>
        <p className="mk-body" style={{ maxWidth:360, textAlign:"center" }}>We'll get back to you at <b style={{ color:"var(--fg)" }}>{email}</b>. Response time is typically 1–2 business days.</p>
        <button className="mk-btn mk-btn--secondary" onClick={() => { setSent(false); setMessage(""); }}>Send another message</button>
      </div>
    </div></section>
  );

  return (
    <section className="mk-section">
      <div className="mk-c">
        <div className="mk-contact-grid">
          <div>
            <span className="mk-eyebrow">Contact</span>
            <h1 className="mk-h2" style={{ marginBottom:16 }}>Get in touch</h1>
            <p className="mk-body" style={{ marginBottom:32 }}>Use the form or reach us directly. We read everything.</p>
            <form className="mk-form" onSubmit={e => { e.preventDefault(); setSent(true); }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
                <div className="mk-field"><label>Name</label><input className="mk-input" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" /></div>
                <div className="mk-field"><label>Email</label><input className="mk-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></div>
              </div>
              <div className="mk-field">
                <label>Topic</label>
                <select className="mk-input mk-select" value={topic} onChange={e => setTopic(e.target.value)}>
                  <option value="general">General</option>
                  <option value="support">Support</option>
                  <option value="business">Business</option>
                  <option value="press">Press</option>
                  <option value="selfhost">Self-hosting</option>
                </select>
              </div>
              <div className="mk-field"><label>Message</label><textarea className="mk-input mk-textarea" value={message} onChange={e => setMessage(e.target.value)} placeholder="Describe your question or issue…" /></div>
              <TurnstileWidget />
              <button type="submit" className="mk-btn mk-btn--primary" disabled={!message.trim()} style={!message.trim()?{opacity:.4,cursor:"not-allowed"}:undefined}><Icon name="send" size={16}/>Send message</button>
            </form>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:24, paddingTop:48 }}>
            <div style={{ background:"var(--raised)", border:"1px solid var(--border-subtle)", borderRadius:"var(--r-xl)", padding:28 }}>
              <div style={{ fontWeight:600, fontSize:16, color:"var(--fg)", marginBottom:12 }}>Alternative contact</div>
              <p style={{ margin:"0 0 12px", fontSize:15, color:"var(--fg-muted)", lineHeight:1.6 }}>For urgent support, email us directly:</p>
              <span className="mk-mono-pill" style={{ fontSize:13 }}>support@slugbase.app</span>
            </div>
            <div style={{ background:"var(--raised)", border:"1px solid var(--border-subtle)", borderRadius:"var(--r-xl)", padding:28 }}>
              <div style={{ fontWeight:600, fontSize:16, color:"var(--fg)", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}><Icon name="github" size={16} />Self-hosted support</div>
              <p style={{ margin:"0 0 16px", fontSize:15, color:"var(--fg-muted)", lineHeight:1.6 }}>For self-hosted instances, please use the appropriate channel:</p>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ fontSize:14, color:"var(--fg-muted)", display:"flex", gap:8, alignItems:"flex-start" }}><Icon name="bug" size={14} style={{ flexShrink:0, marginTop:2, color:"var(--danger-text)" }}/>Bugs &amp; issues → <b style={{ color:"var(--fg)" }}>GitHub Issues</b></div>
                <div style={{ fontSize:14, color:"var(--fg-muted)", display:"flex", gap:8, alignItems:"flex-start" }}><Icon name="message-circle" size={14} style={{ flexShrink:0, marginTop:2, color:"var(--accent-text)" }}/>Usage questions → <b style={{ color:"var(--fg)" }}>GitHub Discussions</b></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---- LEGAL PAGES ---- */
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";

const LEGAL_CONTENT = {
  impressum: {
    title: "Impressum",
    sections: [
      { h2:"Angaben gemäß § 5 ECG", content:<><p>SlugBase Software e.U.<br/>Musterstraße 12/3<br/>1010 Wien<br/>Österreich</p></> },
      { h2:"Kontakt", content:<><p>E-Mail: <span style={{color:"var(--accent-text)"}}>legal@slugbase.app</span><br/>Website: slugbase.app</p></> },
      { h2:"Unternehmensgegenstand", content:<><p>Entwicklung und Betrieb einer selbst-hostbaren Lesezeichen- und URL-Weiterleitungssoftware (SaaS und Open Source).</p></> },
      { h2:"Aufsichtsbehörde", content:<><p>Sofern eine behördliche Aufsicht erforderlich ist, ist die zuständige Behörde die Wirtschaftskammer Österreich (WKO).</p><p>{LOREM}</p></> },
      { h2:"Haftung für Links", content:<><p>{LOREM}</p></> },
      { h2:"Urheberrecht", content:<><p>{LOREM}</p></> },
    ]
  },
  agb: {
    title: "Allgemeine Geschäftsbedingungen",
    sections: [
      { h2:"§1 Vertragsgegenstand", content:<><p>Diese Allgemeinen Geschäftsbedingungen gelten für die Nutzung des Software-as-a-Service-Angebots SlugBase, betrieben von SlugBase Software e.U., Wien.</p><p>{LOREM}</p></> },
      { h2:"§2 Leistungsumfang", content:<><h3>2.1 Kostenloser Tarif</h3><p>{LOREM}</p><h3>2.2 Kostenpflichtige Tarife</h3><p>{LOREM}</p><h3>2.3 Selbst-gehostete Version</h3><p>{LOREM}</p></> },
      { h2:"§3 Preise und Zahlung", content:<><p>{LOREM}</p><ul><li>Monatliche Abrechnung zum Beginn jedes Abrechnungszeitraums</li><li>Jährliche Abrechnung zum Beginn des Jahresabonnements</li><li>Preisänderungen werden 30 Tage im Voraus angekündigt</li></ul><p>{LOREM}</p></> },
      { h2:"§4 Laufzeit und Kündigung", content:<><p>{LOREM}</p><p>Abonnements verlängern sich automatisch, sofern sie nicht vor Ende des Abrechnungszeitraums gekündigt werden. Bei Kündigung bleibt der Zugang bis zum Ende des laufenden Abrechnungszeitraums bestehen.</p></> },
      { h2:"§5 Nutzungsrechte", content:<><p>{LOREM}</p></> },
      { h2:"§6 Haftung", content:<><p>{LOREM}</p><p>Die Haftung des Anbieters ist auf Vorsatz und grobe Fahrlässigkeit beschränkt. Eine Haftung für mittelbare Schäden, entgangenen Gewinn oder Datenverlust ist ausgeschlossen, soweit gesetzlich zulässig.</p></> },
      { h2:"§7 Anwendbares Recht", content:<><p>Es gilt österreichisches Recht unter Ausschluss des UN-Kaufrechts. Gerichtsstand ist Wien, Österreich.</p></> },
    ]
  },
  datenschutz: {
    title: "Datenschutzerklärung",
    sections: [
      { h2:"§1 Verantwortlicher", content:<><p>Verantwortlicher im Sinne der DSGVO:<br/>SlugBase Software e.U., Musterstraße 12/3, 1010 Wien, Österreich<br/>E-Mail: datenschutz@slugbase.app</p></> },
      { h2:"§2 Verarbeitungszwecke", content:<><p>Wir verarbeiten personenbezogene Daten ausschließlich für folgende Zwecke:</p><ul><li>Bereitstellung und Betrieb des SlugBase-Dienstes</li><li>Nutzerauthentifizierung und Kontoverwaltung</li><li>Abwicklung von Zahlungen (via Stripe)</li><li>Kommunikation und Support</li><li>Sicherheit und Missbrauchsverhinderung</li></ul><p>{LOREM}</p></> },
      { h2:"§3 Rechtsgrundlagen", content:<><p>Die Verarbeitung erfolgt auf folgenden Rechtsgrundlagen gemäß Art. 6 DSGVO:</p><ul><li>Art. 6 Abs. 1 lit. b – Vertragserfüllung</li><li>Art. 6 Abs. 1 lit. c – Rechtliche Verpflichtung</li><li>Art. 6 Abs. 1 lit. f – Berechtigte Interessen</li></ul></> },
      { h2:"§4 Datenübermittlung", content:<><p>Alle Daten werden ausschließlich auf EU-Infrastruktur (Frankfurt, Deutschland) gespeichert und verarbeitet. Es erfolgt keine Übermittlung personenbezogener Daten an Drittländer außerhalb des EWR.</p><p>Auftragsverarbeiter: Stripe (Zahlungsabwicklung, EU-Infrastruktur), Hetzner Cloud (Hosting).</p></> },
      { h2:"§5 Betroffenenrechte", content:<><p>Sie haben folgende Rechte gegenüber uns bezüglich der Sie betreffenden personenbezogenen Daten:</p><ul><li>Recht auf Auskunft (Art. 15 DSGVO)</li><li>Recht auf Berichtigung (Art. 16 DSGVO)</li><li>Recht auf Löschung (Art. 17 DSGVO)</li><li>Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO)</li><li>Recht auf Datenübertragbarkeit (Art. 20 DSGVO)</li><li>Widerspruchsrecht (Art. 21 DSGVO)</li></ul><p>{LOREM}</p></> },
      { h2:"§6 Kontakt Datenschutz", content:<><p>Für Anfragen zum Datenschutz wenden Sie sich bitte an:<br/>datenschutz@slugbase.app<br/><br/>Zuständige Aufsichtsbehörde: Österreichische Datenschutzbehörde (dsb.gv.at)</p></> },
    ]
  }
};

function LegalPage({ tab }) {
  const [activeTab, setActiveTab] = useState(tab || "impressum");
  const content = LEGAL_CONTENT[activeTab];
  return (
    <section className="mk-section">
      <div className="mk-c--narrow">
        <div className="mk-legal-tabs">
          {["impressum","agb","datenschutz"].map(t => (
            <div key={t} className={"mk-legal-tab" + (activeTab===t?" active":"")} onClick={() => setActiveTab(t)}>
              {LEGAL_CONTENT[t].title}
            </div>
          ))}
        </div>
        <h1 style={{ margin:"0 0 40px", font:"700 clamp(28px,4vw,36px)/1.15 var(--font-sans)", letterSpacing:"-0.025em", color:"var(--fg)" }}>{content.title}</h1>
        <div className="mk-legal-prose">
          {content.sections.map((s, i) => (
            <div key={i}>
              <h2>{s.h2}</h2>
              {s.content}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { PricingPage, ContactPage, LegalPage });
