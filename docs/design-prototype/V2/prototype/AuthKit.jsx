/* SlugBase — Auth shared kit. Consumes Icon/Kbd from primitives; exports to window. */

/* ---------- Brand mark for federated providers ---------- */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

/* ---------- Text / password field ---------- */
function Field({ label, link, onLink, icon, type = "text", value, onChange, placeholder, hint, hintOk, autoComplete, mono }) {
  const [show, setShow] = useState(false);
  const isPw = type === "password";
  return (
    <div className="fgroup">
      {(label || link) && (
        <div className="fgroup-row">
          {label && <label className="lbl">{label}</label>}
          {link && <a className="lbl-link" onClick={onLink}>{link}</a>}
        </div>
      )}
      <div className="field field--lg">
        {icon && <Icon name={icon} size={16} />}
        <input
          type={isPw && !show ? "password" : "text"}
          value={value}
          onChange={(e) => onChange && onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck="false"
          style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
        />
        {isPw && (
          <span className="reveal" onClick={() => setShow(s => !s)} title={show ? "Hide" : "Show"}>
            <Icon name={show ? "eye-off" : "eye"} size={16} />
          </span>
        )}
      </div>
      {hint && <div className={"field-hint" + (hintOk ? " ok" : "")}>{hint}</div>}
    </div>
  );
}

/* ---------- Password strength ---------- */
function scorePw(v) {
  if (!v) return 0;
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
  if (/\d/.test(v)) s++;
  if (/[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(4, s);
}
const STRENGTH = [
  { label: "Too short", color: "var(--border)", text: "var(--fg-subtle)" },
  { label: "Weak", color: "var(--danger)", text: "var(--danger-text)" },
  { label: "Fair", color: "var(--warning)", text: "var(--warning-text)" },
  { label: "Good", color: "var(--accent)", text: "var(--accent-text)" },
  { label: "Strong", color: "var(--success)", text: "var(--success-text)" },
];

function Strength({ value }) {
  const score = scorePw(value);
  const meta = STRENGTH[score];
  return (
    <div className="strength">
      <div className="strength-bars">
        {[0, 1, 2, 3].map(i => (
          <i key={i} style={{ background: i < score ? meta.color : "var(--border)" }} />
        ))}
      </div>
      <div className="strength-meta">
        <span className="label" style={{ color: value ? meta.text : "var(--fg-subtle)" }}>
          {value ? meta.label : "Password strength"}
        </span>
        <span className="req">8+ chars · mixed case · number</span>
      </div>
    </div>
  );
}

/* ---------- Divider ---------- */
function Divider({ children = "or" }) {
  return <div className="divider"><span>{children}</span></div>;
}

/* ---------- Federated providers (config-driven; Google + GitHub shown) ---------- */
function Fed({ verb = "Continue", onPick }) {
  return (
    <div className="fed-stack">
      <button className="fed" onClick={() => onPick && onPick("google")}>
        <span className="fed-ic"><GoogleMark /></span>{verb} with Google
      </button>
      <button className="fed" onClick={() => onPick && onPick("github")}>
        <span className="fed-ic"><Icon name="github" size={18} /></span>{verb} with GitHub
      </button>
    </div>
  );
}

/* ---------- Constant brand rail (every auth page) ---------- */
function BrandRail() {
  return (
    <aside className="brand">
      <div className="brand-mark">
        <img src="../assets/slugbase_icon.svg" alt="" />
        <span className="brand-word">SlugBase</span>
      </div>

      <div className="brand-mid">
      <div className="brand-hero">
        <h1>Every bookmark, one short link away.</h1>
        <p>Save, organize, and forward your links from a single keyboard-driven workspace.</p>
      </div>

      <div className="brand-slugs">
        <div className="slug-row">
          <span className="src">go.slugbase.app/react19</span>
          <Icon name="arrow-right" size={14} className="arrow" />
          <span className="dst">react.dev/blog</span>
        </div>
        <div className="slug-row ghost">
          <span className="src">go.slugbase.app/ddia</span>
          <Icon name="arrow-right" size={14} className="arrow" />
          <span className="dst">dataintensive.net</span>
        </div>
        <div className="slug-row ghost2">
          <span className="src">go.slugbase.app/rustperf</span>
          <Icon name="arrow-right" size={14} className="arrow" />
          <span className="dst">nnethercote.github.io</span>
        </div>
      </div>
      </div>

      <div className="brand-foot">
        <span>Self-hosted</span>
        <span className="dot" />
        <span>v1.0.0</span>
        <span className="dot" />
        <span style={{ fontFamily: "var(--font-mono)" }}>go.slugbase.app</span>
      </div>
    </aside>
  );
}

Object.assign(window, { Field, Strength, scorePw, Divider, Fed, GoogleMark, BrandRail });
