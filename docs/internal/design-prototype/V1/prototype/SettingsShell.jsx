/* SlugBase — Settings secondary nav + shared form primitives */

const SETTINGS_NAV = [
  { group: "Account", items: [
    { id: "profile",     page: "account",   icon: "user",         label: "Profile" },
    { id: "password",    page: "account",   icon: "lock",         label: "Password" },
    { id: "mfa",         page: "account",   icon: "shield-check", label: "Two-factor auth" },
    { id: "tokens",      page: "account",   icon: "key-round",    label: "API tokens" },
    { id: "preferences", page: "account",   icon: "sliders-horizontal", label: "Preferences" },
  ]},
  { group: "Workspace", items: [
    { id: "general",   page: "workspace", icon: "building-2",   label: "General" },
    { id: "smtp",      page: "workspace", icon: "mail",         label: "Email / SMTP" },
    { id: "ai",        page: "workspace", icon: "sparkles",     label: "AI suggestions" },
    { id: "oidc",      page: "workspace", icon: "fingerprint",  label: "Identity providers" },
  ]},
  { group: "Billing", items: [
    { id: "billing-plan",    page: "billing", icon: "credit-card",   label: "Plan" },
    { id: "billing-seats",   page: "billing", icon: "users",         label: "Seats" },
    { id: "billing-history", page: "billing", icon: "receipt",        label: "Billing history" },
  ]},
  { group: "Administration", items: [
    { id: "members", page: "members", icon: "users-round", label: "Members & teams" },
    { id: "audit",   page: "audit",   icon: "scroll-text", label: "Audit log" },
  ]},
];

/* ---- Secondary nav ---- */
function SettingsNav({ page, section, onNav }) {
  return (
    <nav className="settings-nav">
      {SETTINGS_NAV.map(g => (
        <div key={g.group} className="sn-group">
          <div className="sn-group-label">{g.group}</div>
          {g.items.map(item => (
            <div key={item.id}
              className={"sn-item" + (section === item.id ? " active" : "")}
              onClick={() => onNav(item.page, item.id)}>
              <Icon name={item.icon} size={15} />
              {item.label}
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

/* ---- Section wrapper ---- */
function SS({ title, description, children }) {
  return (
    <div className="ss">
      <div className="ss-head">
        <h2 className="ss-title">{title}</h2>
        {description && <p className="ss-desc">{description}</p>}
      </div>
      <div className="ss-body">{children}</div>
    </div>
  );
}

/* ---- Form group (label + input + hint) ---- */
function FG({ label, hint, error, children }) {
  return (
    <div className="fg">
      {label && <span className="lbl">{label}</span>}
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

/* ---- Input field wrapper ---- */
function FF({ icon, children, disabled, mono }) {
  return (
    <div className={"ff" + (disabled ? " disabled" : "") + (mono ? " mono" : "")}>
      {icon && <Icon name={icon} size={15} />}
      {children}
    </div>
  );
}

/* ---- Copy field (read-only + copy btn) ---- */
function CopyField({ value, label, toast }) {
  const copy = () => { navigator.clipboard.writeText(value).catch(() => {}); toast && toast({ icon: "clipboard-check", title: label ? `${label} copied` : "Copied" }); };
  return (
    <div className="ff-copy">
      <div className="ff mono"><input readOnly value={value} /></div>
      <button className="btn btn--secondary btn--sm" onClick={copy}><Icon name="copy" size={14} />Copy</button>
    </div>
  );
}

/* ---- Save bar ---- */
function SaveBar({ dirty, onSave, onDiscard }) {
  if (!dirty) return null;
  return (
    <div className="save-bar">
      <span className="unsaved">Unsaved changes</span>
      <button className="btn btn--ghost btn--sm" onClick={onDiscard}>Discard</button>
      <button className="btn btn--primary btn--sm" onClick={onSave}>Save changes</button>
    </div>
  );
}

/* ---- Alert boxes ---- */
function InfoBox({ icon = "info", children }) {
  return <div className="info-box"><Icon name={icon} size={15} /><div>{children}</div></div>;
}
function WarnBox({ icon = "alert-triangle", children }) {
  return <div className="warn-box"><Icon name={icon} size={15} /><div>{children}</div></div>;
}

/* ---- Danger zone ---- */
function DangerZone({ title, description, action, onAction, disabled, disabledReason }) {
  return (
    <div className="danger-zone">
      <div className="dz-title">{title}</div>
      <p className="dz-desc">{description}</p>
      {disabledReason && <div style={{ fontSize: "var(--text-small)", color: "var(--fg-subtle)", display: "flex", gap: "var(--sp-3)", alignItems: "center" }}><Icon name="lock" size={13} />{disabledReason}</div>}
      <div><button className="btn btn--danger btn--sm" disabled={disabled} onClick={onAction} style={disabled ? { opacity: 0.4, cursor: "not-allowed" } : undefined}>{action}</button></div>
    </div>
  );
}

/* ---- Shown-once secret display ---- */
function ShownOnce({ values, label = "Backup codes", toast }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(values.join("\n")).catch(() => {}); setCopied(true); toast && toast({ icon: "clipboard-check", title: `${label} copied` }); setTimeout(() => setCopied(false), 2000); };
  return (
    <div className="shown-once">
      <div className="shown-once-head">
        <Icon name="alert-triangle" size={15} />
        <span><b>Store these somewhere safe.</b> They will not be shown again.</span>
        <button className="btn btn--sm btn--secondary" onClick={copy}><Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy all"}</button>
        <button className="btn btn--sm btn--ghost"><Icon name="download" size={14} />Download</button>
      </div>
      <div className="backup-grid">
        {values.map((v, i) => <span key={i} className="backup-code">{v}</span>)}
      </div>
    </div>
  );
}

/* ---- Inline toggle ---- */
function ToggleRow({ label, hint, on, onChange, withBorder }) {
  return (
    <div className={"toggle-row" + (withBorder ? " with-border" : "")}>
      <div><div className="toggle-label">{label}</div>{hint && <div className="toggle-hint">{hint}</div>}</div>
      <div className="switch on" style={{ background: on ? "var(--accent)" : "var(--border-strong)" }}
        onClick={() => onChange(!on)} role="switch" aria-checked={on}>
        <i style={{ left: on ? 16 : 2 }} />
      </div>
    </div>
  );
}

/* ---- Password strength (reuse from auth scope if available or define inline) ---- */
const S_STRENGTH = [
  { label: "Too short", color: "var(--border)", text: "var(--fg-subtle)" },
  { label: "Weak", color: "var(--danger)", text: "var(--danger-text)" },
  { label: "Fair", color: "var(--warning)", text: "var(--warning-text)" },
  { label: "Good", color: "var(--accent)", text: "var(--accent-text)" },
  { label: "Strong", color: "var(--success)", text: "var(--success-text)" },
];
function sPw(v) { if (!v) return 0; let s=0; if(v.length>=8)s++; if(v.length>=12)s++; if(/[a-z]/.test(v)&&/[A-Z]/.test(v))s++; if(/\d/.test(v))s++; if(/[^A-Za-z0-9]/.test(v))s++; return Math.min(4,s); }
function PwStrength({ value }) {
  const score = sPw(value);
  const meta = S_STRENGTH[score];
  return (
    <div className="strength">
      <div className="strength-bars">{[0,1,2,3].map(i=><i key={i} style={{background: i<score ? meta.color:"var(--border)"}} />)}</div>
      <div className="strength-meta">
        <span className="label" style={{color: value ? meta.text:"var(--fg-subtle)"}}>{value ? meta.label : "Password strength"}</span>
        <span className="req">8+ chars · mixed case · number</span>
      </div>
    </div>
  );
}

/* ---- Plan gate ---- */
function PlanGate({ plan = "Team", feature = "this feature", onUpgrade }) {
  return (
    <div className="plan-gate">
      <div className="pg-ic"><Icon name="lock" size={26} /></div>
      <h3>Upgrade to {plan} to access {feature}</h3>
      <p>This workspace is on a lower plan. Upgrade to {plan} to unlock this feature for your entire workspace.</p>
      <button className="btn btn--primary" onClick={onUpgrade}><Icon name="zap" size={15} />Upgrade to {plan}</button>
    </div>
  );
}

Object.assign(window, {
  SETTINGS_NAV, SettingsNav, SS, FG, FF, CopyField, SaveBar,
  InfoBox, WarnBox, DangerZone, ShownOnce, ToggleRow, PwStrength, PlanGate,
});
