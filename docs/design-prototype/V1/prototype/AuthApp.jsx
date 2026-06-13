/* SlugBase — Auth flow: 7 screens, router, registration-mode toggle, prototype harness */

const APP_URL = "Bookmarks.html"; // successful auth lands in the app

/* ---------- small shared bits ---------- */
function CardMark() {
  return (
    <div className="card-mark">
      <img src="../assets/slugbase_icon.svg" alt="" />
      <span>SlugBase</span>
    </div>
  );
}

function Resend({ label = "Resend email" }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(l => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return (
    <p className="resend">
      Didn't receive it?{" "}
      {left > 0
        ? <a className="disabled">Resend in {left}s</a>
        : <a onClick={() => setLeft(30)}>{label}</a>}
    </p>
  );
}

function CodeInput({ value, onChange }) {
  const refs = useRef([]);
  const setAt = (i, ch) => {
    const d = (ch || "").replace(/\D/g, "").slice(-1);
    const arr = value.split("");
    while (arr.length < 6) arr.push("");
    arr[i] = d || "";
    onChange(arr.join("").slice(0, 6));
    if (d && i < 5) refs.current[i + 1] && refs.current[i + 1].focus();
  };
  const onKey = (i, e) => {
    if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1] && refs.current[i - 1].focus();
  };
  return (
    <div className="code">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <input key={i} ref={el => (refs.current[i] = el)} inputMode="numeric" maxLength={1}
          className={value[i] ? "filled" : ""} value={value[i] || ""}
          onChange={e => setAt(i, e.target.value)} onKeyDown={e => onKey(i, e)} aria-label={`Digit ${i + 1}`} />
      ))}
    </div>
  );
}

/* ============================================================
   SCREENS
   ============================================================ */

function SignIn({ go, finish, openReg, st }) {
  return (
    <>
      <div className="head">
        <h2>Sign in to SlugBase</h2>
        <p>Welcome back. Enter your credentials to continue.</p>
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); go("mfa"); }}>
        <Field label="Email" icon="mail" type="text" value={st.email} onChange={st.setEmail}
          placeholder="you@company.com" autoComplete="username" />
        <Field label="Password" link="Forgot password?" onLink={() => go("reset")}
          icon="lock" type="password" value={st.password} onChange={st.setPassword}
          placeholder="••••••••" autoComplete="current-password" />
        <label className="cbrow">
          <Check on={st.remember} onChange={st.setRemember} stop={false} />
          Keep me signed in on this device
        </label>
        <button className="btn btn--primary btn--lg btn--block" type="submit">Sign in</button>
      </form>

      {openReg ? (
        <>
          <div style={{ marginTop: "var(--sp-7)" }}><Divider /></div>
          <div style={{ marginTop: "var(--sp-6)" }}><Fed verb="Continue" /></div>
          <div className="foot">New to SlugBase? <a onClick={() => go("register")}>Create an account</a></div>
        </>
      ) : (
        <div className="muted-note" style={{ marginTop: "var(--sp-8)" }}>
          <Icon name="info" size={15} />
          Public registration is disabled on this instance. Ask an admin for an invite to get access.
        </div>
      )}
    </>
  );
}

function Mfa({ go, finish, st }) {
  const [mode, setMode] = useState("totp"); // totp | backup
  return (
    <>
      <a className="backlink" onClick={() => go("signin")}><Icon name="arrow-left" size={15} />Back to sign in</a>
      <div className="head" style={{ marginTop: "var(--sp-7)" }}>
        <h2>Two-factor authentication</h2>
        {mode === "totp"
          ? <p>Enter the 6-digit code from your authenticator app to finish signing in.</p>
          : <p>Enter one of your single-use backup codes. Each code works only once.</p>}
      </div>

      <form className="form" onSubmit={e => { e.preventDefault(); finish(); }}>
        {mode === "totp" ? (
          <div className="fgroup">
            <label className="lbl">Authentication code</label>
            <CodeInput value={st.code} onChange={st.setCode} />
          </div>
        ) : (
          <Field label="Backup code" icon="key-round" value={st.backup} onChange={st.setBackup}
            placeholder="XXXX-XXXX-XXXX" mono />
        )}
        <button className="btn btn--primary btn--lg btn--block" type="submit">Verify and continue</button>
      </form>

      <div className="foot">
        {mode === "totp"
          ? <a onClick={() => setMode("backup")}>Use a backup code instead</a>
          : <a onClick={() => setMode("totp")}>Use your authenticator app instead</a>}
      </div>
    </>
  );
}

function Register({ go, openReg, st }) {
  if (!openReg) {
    return (
      <>
        <div className="info-ic"><Icon name="lock" size={24} /></div>
        <div className="head">
          <h2>Registration is closed</h2>
          <p>This SlugBase instance isn't accepting public sign-ups. Ask an admin to invite you, or enable open registration in the harness.</p>
        </div>
        <button className="btn btn--secondary btn--lg btn--block" onClick={() => go("signin")} style={{ marginTop: "var(--sp-4)" }}>
          <Icon name="arrow-left" size={16} />Back to sign in
        </button>
      </>
    );
  }
  return (
    <>
      <div className="head">
        <h2>Create your account</h2>
        <p>Start saving and forwarding links in your own workspace.</p>
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); go("verify"); }}>
        <Field label="Name" icon="user" value={st.name} onChange={st.setName} placeholder="Your name" autoComplete="name" />
        <Field label="Email" icon="mail" value={st.email} onChange={st.setEmail} placeholder="you@company.com" autoComplete="email" />
        <div className="fgroup">
          <Field label="Password" icon="lock" type="password" value={st.password} onChange={st.setPassword}
            placeholder="Create a password" autoComplete="new-password" />
          <Strength value={st.password} />
        </div>
        <button className="btn btn--primary btn--lg btn--block" type="submit">Create account</button>
      </form>

      <div style={{ marginTop: "var(--sp-7)" }}><Divider /></div>
      <div style={{ marginTop: "var(--sp-6)" }}><Fed verb="Sign up" /></div>
      <div className="foot">Already have an account? <a onClick={() => go("signin")}>Sign in</a></div>
    </>
  );
}

function VerifyEmail({ go, st }) {
  return (
    <>
      <div className="info-ic"><Icon name="mail-check" size={24} /></div>
      <div className="head">
        <h2>Verify your email</h2>
        <p>If <b>{st.email}</b> needs verification, a link is on its way. Open it to activate your account.</p>
      </div>
      <div className="sent-to"><Icon name="mail" size={15} />{st.email}</div>
      <button className="btn btn--secondary btn--lg btn--block" onClick={() => go("signin")}>
        <Icon name="arrow-left" size={16} />Back to sign in
      </button>
      <Resend label="Resend email" />
      <div className="muted-note">
        <Icon name="shield" size={15} />
        For your security we show this screen for every address — it doesn't confirm whether an account exists.
      </div>
    </>
  );
}

function ResetRequest({ go, st }) {
  const [sent, setSent] = useState(false);
  if (sent) {
    return (
      <>
        <div className="info-ic"><Icon name="mail-check" size={24} /></div>
        <div className="head">
          <h2>Check your email</h2>
          <p>If an account exists for <b>{st.email}</b>, we've sent a password reset link. It expires in 30 minutes.</p>
        </div>
        <div className="sent-to"><Icon name="mail" size={15} />{st.email}</div>
        <button className="btn btn--secondary btn--lg btn--block" onClick={() => go("signin")}>
          <Icon name="arrow-left" size={16} />Back to sign in
        </button>
        <Resend label="Resend link" />
      </>
    );
  }
  return (
    <>
      <a className="backlink" onClick={() => go("signin")}><Icon name="arrow-left" size={15} />Back to sign in</a>
      <div className="head" style={{ marginTop: "var(--sp-7)" }}>
        <h2>Reset your password</h2>
        <p>Enter the email for your account and we'll send a link to set a new password.</p>
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); setSent(true); }}>
        <Field label="Email" icon="mail" value={st.email} onChange={st.setEmail} placeholder="you@company.com" autoComplete="email" />
        <button className="btn btn--primary btn--lg btn--block" type="submit">Send reset link</button>
      </form>
      <div className="muted-note">
        <Icon name="shield" size={15} />
        We always respond the same way, whether or not an account matches — so this never reveals who has an account.
      </div>
    </>
  );
}

function ResetSet({ go, st }) {
  const match = st.newPw && st.confirmPw && st.newPw === st.confirmPw;
  const mismatch = st.confirmPw && st.newPw !== st.confirmPw;
  return (
    <>
      <div className="head">
        <h2>Set a new password</h2>
        <p>Choose a new password for <b>{st.email}</b>. This reset link is single-use.</p>
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); if (match) go("signin"); }}>
        <div className="fgroup">
          <Field label="New password" icon="lock" type="password" value={st.newPw} onChange={st.setNewPw}
            placeholder="New password" autoComplete="new-password" />
          <Strength value={st.newPw} />
        </div>
        <Field label="Confirm password" icon="lock-keyhole" type="password" value={st.confirmPw} onChange={st.setConfirmPw}
          placeholder="Re-enter password" autoComplete="new-password"
          hint={match ? "Passwords match" : mismatch ? "Passwords don't match yet" : null} hintOk={match} />
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={!match}
          style={!match ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>Update password</button>
      </form>
      <a className="backlink" onClick={() => go("signin")} style={{ display: "block", textAlign: "center" }}>Back to sign in</a>
    </>
  );
}

function Setup({ finish, st }) {
  return (
    <>
      <div className="setup-steps">
        <span className="step"><span className="num">1</span>Admin account</span>
        <Icon name="chevron-right" size={14} style={{ color: "var(--fg-faint)" }} />
        <span className="step"><span className="num" style={{ background: "var(--raised-2)", color: "var(--fg-subtle)" }}>2</span>First workspace</span>
      </div>
      <div className="head">
        <div className="eyebrow"><Icon name="terminal" size={12} />Self-hosted setup</div>
        <h2>Finish installing SlugBase</h2>
        <p>No users exist on this instance yet. Create the owner account and your first workspace to complete setup.</p>
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); finish(); }}>
        <Field label="Your name" icon="user" value={st.name} onChange={st.setName} placeholder="Admin name" autoComplete="name" />
        <Field label="Email" icon="mail" value={st.email} onChange={st.setEmail} placeholder="admin@your-domain.com" autoComplete="email" />
        <div className="fgroup">
          <Field label="Password" icon="lock" type="password" value={st.password} onChange={st.setPassword}
            placeholder="Create a strong password" autoComplete="new-password" />
          <Strength value={st.password} />
        </div>

        <div className="setup-divider"><span>First workspace</span></div>

        <Field label="Workspace name" icon="layout-grid" value={st.wsName} onChange={st.setWsName} placeholder="e.g. Acme Engineering" />
        <button className="btn btn--primary btn--lg btn--block" type="submit">Create account &amp; finish setup</button>
      </form>
      <div className="muted-note">
        <Icon name="shield-check" size={15} />
        This account becomes the instance owner with full administrative access.
      </div>
    </>
  );
}

/* ============================================================
   HARNESS — prototype state switcher (not product UI)
   ============================================================ */
const SCREENS = [
  { id: "signin", label: "Sign in", icon: "log-in" },
  { id: "mfa", label: "MFA verification", icon: "shield-check" },
  { id: "register", label: "Registration", icon: "user-plus" },
  { id: "verify", label: "Email verification", icon: "mail-check" },
  { id: "reset", label: "Password reset", icon: "key-round" },
  { id: "reset-set", label: "Set new password", icon: "lock-keyhole" },
  { id: "setup", label: "First-run setup", icon: "terminal" },
];

function Harness({ screen, setScreen, openReg, setOpenReg }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="harness">
      <div className="harness-head" onClick={() => setOpen(o => !o)}>
        <Icon name="layers" size={14} />
        <span className="t">Prototype screens</span>
        <Icon name={open ? "chevron-down" : "chevron-up"} size={15} />
      </div>
      <div className={"harness-body" + (open ? "" : " collapsed")}>
        {SCREENS.map((s, i) => (
          <div key={s.id} className={"h-item" + (screen === s.id ? " on" : "")} onClick={() => setScreen(s.id)}>
            <span className="h-num">{i + 1}</span>
            <Icon name={s.icon} size={15} />
            <span>{s.label}</span>
          </div>
        ))}
        <div className="h-sep" />
        <div className="h-toggle">
          <span className="tl">
            <b>{openReg ? "Open registration" : "Login-only mode"}</b>
            <small>{openReg ? "Sign-up & SSO visible" : "Invite-only access"}</small>
          </span>
          <div className={"switch" + (openReg ? " on" : "")} onClick={() => setOpenReg(v => !v)} role="switch" aria-checked={openReg}>
            <i />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ROOT
   ============================================================ */
function AuthApp() {
  const [screen, setScreen] = useState("signin");
  const [openReg, setOpenReg] = useState(true);

  // lifted, pre-filled field state — shared across screens
  const [email, setEmail] = useState("alex@inboxops.app");
  const [password, setPassword] = useState("tr0ubadour-X9");
  const [name, setName] = useState("Alex Kerr");
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState("204815");
  const [backup, setBackup] = useState("");
  const [newPw, setNewPw] = useState("summer-Breeze-7");
  const [confirmPw, setConfirmPw] = useState("summer-Breeze-7");
  const [wsName, setWsName] = useState("Acme Engineering");

  const st = {
    email, setEmail, password, setPassword, name, setName, remember, setRemember,
    code, setCode, backup, setBackup, newPw, setNewPw, confirmPw, setConfirmPw, wsName, setWsName,
  };

  const go = (s) => setScreen(s);
  const finish = () => { window.location.href = APP_URL; };

  const view = {
    signin: <SignIn go={go} finish={finish} openReg={openReg} st={st} />,
    mfa: <Mfa go={go} finish={finish} st={st} />,
    register: <Register go={go} openReg={openReg} st={st} />,
    verify: <VerifyEmail go={go} st={st} />,
    reset: <ResetRequest go={go} st={st} />,
    "reset-set": <ResetSet go={go} st={st} />,
    setup: <Setup finish={finish} st={st} />,
  }[screen];

  return (
    <div className="auth">
      <BrandRail />
      <div className="pane">
        <div className="card" key={screen}>
          <CardMark />
          {view}
        </div>
      </div>
      <Harness screen={screen} setScreen={setScreen} openReg={openReg} setOpenReg={setOpenReg} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<AuthApp />);
