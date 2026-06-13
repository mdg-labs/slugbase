/* SlugBase — Account Settings page (Profile / Password / MFA / Tokens / Preferences) */

const BACKUP_CODES = ["A3F9-K2PL","B7XM-Q4RT","C1HN-W8VZ","D6SJ-Y5UE","E2RD-T9OC","F4GL-M7IB","G8BP-N3WS","H5QK-X6AF"];
const EXISTING_TOKENS = [
  { id:1, name:"VS Code extension",  created:"Jan 5, 2024",  lastUsed:"2h ago" },
  { id:2, name:"CI pipeline",        created:"Feb 12, 2024", lastUsed:"1d ago" },
  { id:3, name:"Raycast plugin",     created:"Apr 20, 2024", lastUsed:"3d ago" },
];

/* ---- Profile section ---- */
function ProfileSection({ toast }) {
  const [name,  setName]  = useState("Alex Kerr");
  const [email, setEmail] = useState("alex@inboxops.app");
  const [newEmail, setNewEmail] = useState("");
  const [pendingEmail, setPendingEmail] = useState(true); // variant: pending verification
  const [dirty, setDirty] = useState(false);
  const d = (fn) => (...a) => { fn(...a); setDirty(true); };

  return (
    <SS title="Profile" description="Your public name and email address. Only visible to workspace members.">
      <div style={{ display:"flex", alignItems:"center", gap:"var(--sp-6)" }}>
        <div className="av av-lg" style={{ background:"var(--accent)", color:"var(--accent-fg)", fontSize:20 }}>AK</div>
        <div>
          <div style={{ fontSize:"var(--text-body)", color:"var(--fg)", fontWeight:"var(--weight-medium)" }}>Alex Kerr</div>
          <div style={{ fontSize:"var(--text-small)", color:"var(--fg-subtle)", marginTop:2 }}>Initials displayed until you upload a photo</div>
          <button className="btn btn--ghost btn--sm" style={{ marginTop:8 }} onClick={()=>toast({icon:"image-plus",title:"Upload photo"})}><Icon name="image-plus" size={14}/>Change photo</button>
        </div>
      </div>
      <FG label="Display name">
        <FF><input value={name} onChange={d(e=>setName(e.target.value))} /></FF>
      </FG>
      <FG label="Email address" hint={pendingEmail ? undefined : "Changing your email requires verification."}>
        <FF icon="mail"><input value={email} onChange={d(e=>setEmail(e.target.value))} /></FF>
        {pendingEmail && (
          <div style={{ display:"flex", alignItems:"center", gap:"var(--sp-4)", marginTop:"var(--sp-2)" }}>
            <span className="status-badge pending"><Icon name="clock" size={10}/>Pending verification</span>
            <span style={{ fontSize:"var(--text-small)", color:"var(--fg-subtle)" }}>
              Verification sent to <b style={{color:"var(--fg)", fontFamily:"var(--font-mono)"}}>alex@newdomain.com</b>
            </span>
            <a style={{ fontSize:"var(--text-small)", color:"var(--accent-text)", cursor:"pointer" }} onClick={()=>toast({icon:"mail",title:"Verification email resent"})}>Resend</a>
            <a style={{ fontSize:"var(--text-small)", color:"var(--fg-subtle)", cursor:"pointer" }} onClick={()=>setPendingEmail(false)}>Cancel change</a>
          </div>
        )}
      </FG>
      <SaveBar dirty={dirty} onSave={()=>{setDirty(false);toast({icon:"check",title:"Profile saved"});}} onDiscard={()=>{setName("Alex Kerr");setEmail("alex@inboxops.app");setDirty(false);}} />
    </SS>
  );
}

/* ---- Password section ---- */
function PasswordSection({ toast }) {
  const [fedOnly, setFedOnly] = useState(false); // variant toggle
  const [cur, setCur] = useState("");
  const [nw,  setNw]  = useState("");
  const [cf,  setCf]  = useState("");
  const match = nw && cf && nw === cf;
  const mismatch = cf && nw !== cf;
  return (
    <SS title="Password" description="Update your password. You'll be asked to verify your current password.">
      <div className="dev-strip" style={{borderRadius:"var(--r-md)",marginBottom:"var(--sp-2)"}}>
        <strong>Demo:</strong>
        <select value={fedOnly?"fed":"pw"} onChange={e=>setFedOnly(e.target.value==="fed")}>
          <option value="pw">Password sign-in enabled</option>
          <option value="fed">Federated only (no password)</option>
        </select>
      </div>
      {fedOnly ? (
        <InfoBox icon="github">
          You signed in with <b>GitHub</b> and haven't set a password. Password sign-in is not available for your account.
          <div style={{marginTop:"var(--sp-4)"}}>
            <button className="btn btn--secondary btn--sm" onClick={()=>toast({icon:"lock",title:"Set a password"})}><Icon name="lock" size={14}/>Add a password</button>
          </div>
        </InfoBox>
      ) : (
        <>
          <FG label="Current password">
            <FF icon="lock"><input type="password" value={cur} onChange={e=>setCur(e.target.value)} placeholder="Enter current password" /></FF>
          </FG>
          <FG label="New password">
            <FF icon="lock"><input type="password" value={nw} onChange={e=>setNw(e.target.value)} placeholder="New password" /></FF>
            <PwStrength value={nw} />
          </FG>
          <FG label="Confirm new password" error={mismatch?"Passwords don't match":undefined} hint={match?"Passwords match":undefined}>
            <FF icon="lock-keyhole"><input type="password" value={cf} onChange={e=>setCf(e.target.value)} placeholder="Re-enter new password" /></FF>
          </FG>
          <div><button className="btn btn--primary btn--sm" disabled={!match} style={!match?{opacity:.4,cursor:"not-allowed"}:undefined} onClick={()=>{setCur("");setNw("");setCf("");toast({icon:"lock",title:"Password updated"});}}>Update password</button></div>
        </>
      )}
    </SS>
  );
}

/* ---- MFA section ---- */
function MFASection({ toast }) {
  const [mfaState, setMfaState] = useState("not-enrolled"); // not-enrolled | enrolling | enrolled
  const [code, setCode] = useState("");
  const [showRegen, setShowRegen] = useState(false);

  return (
    <SS title="Two-factor authentication" description="Add a second factor to protect your account even if your password is compromised.">
      <div className="dev-strip" style={{borderRadius:"var(--r-md)",marginBottom:"var(--sp-2)"}}>
        <strong>MFA state:</strong>
        <select value={mfaState} onChange={e=>{setMfaState(e.target.value);setCode("");setShowRegen(false);}}>
          <option value="not-enrolled">Not enrolled</option>
          <option value="enrolling">Enrollment flow</option>
          <option value="enrolled">Enrolled (active)</option>
        </select>
      </div>

      {mfaState === "not-enrolled" && (
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <InfoBox icon="shield">Two-factor authentication is not enabled. Your account is protected by password only.</InfoBox>
          <div><button className="btn btn--primary btn--sm" onClick={()=>setMfaState("enrolling")}><Icon name="shield-check" size={15}/>Set up authenticator app</button></div>
        </div>
      )}

      {mfaState === "enrolling" && (
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-7)"}}>
          <div>
            <p style={{margin:"0 0 var(--sp-5)",fontSize:"var(--text-body)",color:"var(--fg-muted)"}}>1. Scan this QR code with your authenticator app (Authy, 1Password, Google Authenticator).</p>
            <div style={{display:"flex",gap:"var(--sp-7)",alignItems:"flex-start"}}>
              <div className="qr-frame"><div className="qr-inner" /></div>
              <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-4)"}}>
                <span style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)"}}>Or enter the setup key manually:</span>
                <CopyField value="JBSWY3DPEHPK3PXP" label="Setup key" toast={toast} />
              </div>
            </div>
          </div>
          <FG label="2. Enter the 6-digit code from your app to confirm" hint="The code rotates every 30 seconds.">
            <div style={{display:"flex",gap:"var(--sp-4)",alignItems:"flex-end"}}>
              <FF><input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="000 000" style={{fontFamily:"var(--font-mono)",fontSize:18,letterSpacing:"0.12em"}} /></FF>
              <button className="btn btn--primary btn--sm" disabled={code.length<6} style={code.length<6?{opacity:.4,cursor:"not-allowed"}:undefined}
                onClick={()=>{setMfaState("enrolled");toast({icon:"shield-check",title:"Two-factor authentication enabled"});}}>Verify &amp; activate</button>
            </div>
          </FG>
          <WarnBox><b>Before continuing, save your backup codes.</b> You'll need them if you lose access to your authenticator app.</WarnBox>
          <ShownOnce values={BACKUP_CODES} label="Backup codes" toast={toast} />
          <button className="btn btn--ghost btn--sm" style={{alignSelf:"flex-start"}} onClick={()=>setMfaState("not-enrolled")}>Cancel setup</button>
        </div>
      )}

      {mfaState === "enrolled" && (
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-6)"}}>
          <div style={{display:"flex",alignItems:"center",gap:"var(--sp-4)"}}>
            <Icon name="shield-check" size={22} style={{color:"var(--success-text)"}} />
            <div>
              <div style={{fontWeight:"var(--weight-semi)",color:"var(--fg)"}}>Authenticator app active</div>
              <div style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)"}}>Enabled since May 2024 · <span style={{fontFamily:"var(--font-mono)"}}>8 backup codes remaining</span></div>
            </div>
          </div>
          {showRegen ? (
            <>
              <WarnBox><b>New backup codes generated.</b> Your old codes are now invalid. Store these safely.</WarnBox>
              <ShownOnce values={BACKUP_CODES.map(c=>c.split("").reverse().join(""))} label="Backup codes" toast={toast} />
              <button className="btn btn--ghost btn--sm" style={{alignSelf:"flex-start"}} onClick={()=>setShowRegen(false)}>Done</button>
            </>
          ) : (
            <div style={{display:"flex",gap:"var(--sp-4)"}}>
              <button className="btn btn--secondary btn--sm" onClick={()=>setShowRegen(true)}><Icon name="refresh-cw" size={14}/>Regenerate backup codes</button>
              <button className="btn btn--ghost btn--sm" style={{color:"var(--danger-text)"}} onClick={()=>{setMfaState("not-enrolled");toast({icon:"shield-off",title:"Two-factor authentication disabled"});}}><Icon name="shield-off" size={14}/>Disable MFA</button>
            </div>
          )}
        </div>
      )}
    </SS>
  );
}

/* ---- API Tokens section ---- */
function TokensSection({ toast }) {
  const [tokens, setTokens] = useState(EXISTING_TOKENS);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newToken, setNewToken] = useState(null);

  const create = () => {
    const t = { id: Date.now(), name: newName || "My token", created: "Today", lastUsed: "Never" };
    const secret = "sb_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    setTokens(ts => [...ts, t]);
    setNewToken(secret);
    setCreating(false);
    setNewName("");
  };
  const revoke = (id) => { setTokens(ts=>ts.filter(t=>t.id!==id)); toast({icon:"trash-2",title:"Token revoked"}); };

  return (
    <SS title="API tokens" description="Personal access tokens allow scripts and tools to authenticate as you. Each token is shown once.">
      {tokens.length === 0 && !creating && (
        <div style={{textAlign:"center",padding:"var(--sp-9)",color:"var(--fg-subtle)",display:"flex",flexDirection:"column",alignItems:"center",gap:"var(--sp-5)"}}>
          <Icon name="key-round" size={32} strokeWidth={1.25} style={{color:"var(--fg-faint)"}} />
          <p style={{margin:0,fontSize:"var(--text-body)"}}>No tokens yet. Create one to authenticate scripts or integrations.</p>
        </div>
      )}
      {tokens.length > 0 && (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",overflow:"hidden"}}>
          {tokens.map(t=>(
            <div key={t.id} className="token-row">
              <Icon name="key-round" size={15} style={{color:"var(--fg-faint)",flexShrink:0}} />
              <span className="token-name">{t.name}</span>
              <span className="token-meta">Created {t.created}</span>
              <span className="token-meta">Last used: {t.lastUsed}</span>
              <button className="btn btn--ghost btn--sm" style={{color:"var(--danger-text)"}} onClick={()=>revoke(t.id)}><Icon name="trash-2" size={14}/>Revoke</button>
            </div>
          ))}
        </div>
      )}
      {newToken && (
        <div style={{marginTop:"var(--sp-4)"}}>
          <ShownOnce values={[newToken]} label="API token" toast={toast} />
        </div>
      )}
      {creating ? (
        <div style={{display:"flex",gap:"var(--sp-4)",alignItems:"flex-end",marginTop:"var(--sp-4)"}}>
          <FG label="Token name" style={{flex:1}}>
            <FF><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. VS Code extension" autoFocus /></FF>
          </FG>
          <button className="btn btn--primary btn--sm" disabled={!newName.trim()} style={!newName.trim()?{opacity:.4,cursor:"not-allowed"}:undefined} onClick={create}><Icon name="plus" size={15}/>Create token</button>
          <button className="btn btn--ghost btn--sm" onClick={()=>setCreating(false)}>Cancel</button>
        </div>
      ) : (
        <div style={{marginTop:"var(--sp-2)"}}><button className="btn btn--secondary btn--sm" onClick={()=>setCreating(true)}><Icon name="plus" size={15}/>New token</button></div>
      )}
    </SS>
  );
}

/* ---- Preferences section ---- */
function PreferencesSection({ toast }) {
  const [lang, setLang] = useState("en");
  const [theme, setTheme] = useState(() => { try { return JSON.parse(localStorage.getItem("sb_theme"))||"dark"; } catch { return "dark"; } });
  const [view, setView] = useState(() => { try { return JSON.parse(localStorage.getItem("sb_view"))||"grid"; } catch { return "grid"; } });
  const [aiOpt, setAiOpt] = useState(false);
  const [dirty, setDirty] = useState(false);
  const d = (fn) => (...a) => { fn(...a); setDirty(true); };

  const setThemeD = d(v => { setTheme(v); document.documentElement.setAttribute("data-theme", v); localStorage.setItem("sb_theme", JSON.stringify(v)); });

  const THEMES = [
    { id:"dark",  label:"Dark",  darks:"#0a0b10", lights:"#e0e1f0" },
    { id:"light", label:"Light", darks:"#f4f5f9", lights:"#0a0b10" },
    { id:"auto",  label:"Auto",  darks:"linear-gradient(135deg,#0a0b10 50%,#f4f5f9 50%)", lights:"linear-gradient(135deg,#f4f5f9 50%,#0a0b10 50%)" },
  ];

  return (
    <SS title="Preferences" description="Personal preferences — these apply only to your account, not the workspace.">
      <FG label="Language">
        <select className="select-ff" style={{width:200}} value={lang} onChange={d(e=>setLang(e.target.value))}>
          <option value="en">English</option>
          <option value="de">Deutsch (German)</option>
        </select>
      </FG>
      <FG label="Theme">
        <div className="theme-opts">
          {THEMES.map(t=>(
            <div key={t.id} className={"theme-opt"+(theme===t.id?" on":"")} onClick={()=>setThemeD(t.id)}>
              <div className="th-preview" style={{background:theme==="dark"||t.id==="auto"?t.darks:t.lights}} />
              <span className="th-label">{t.label}</span>
            </div>
          ))}
        </div>
      </FG>
      <FG label="Accent color" hint="The accent color is set at the workspace level and is not user-configurable in this version.">
        <div style={{display:"flex",alignItems:"center",gap:"var(--sp-4)"}}>
          <div style={{width:36,height:36,borderRadius:"var(--r-md)",background:"#7782f7",flexShrink:0}} />
          <span className="status-badge locked"><Icon name="lock" size={11}/>Locked — system default</span>
        </div>
      </FG>
      <FG label="Default bookmark view">
        <div className="seg" style={{width:"fit-content",height:36,padding:3}}>
          <button style={{width:90,height:30}} className={view==="grid"?"on":""} onClick={d(()=>{setView("grid");localStorage.setItem("sb_view",'"grid"');})}><Icon name="layout-grid" size={15}/> Card grid</button>
          <button style={{width:80,height:30}} className={view==="table"?"on":""} onClick={d(()=>{setView("table");localStorage.setItem("sb_view",'"table"');})}><Icon name="rows-3" size={15}/> Table</button>
        </div>
      </FG>
      <ToggleRow label="AI suggestions opt-out" hint="When enabled, SlugBase will not use AI features on your content." on={aiOpt} onChange={d(setAiOpt)} />
      <SaveBar dirty={dirty} onSave={()=>{setDirty(false);toast({icon:"check",title:"Preferences saved"});}} onDiscard={()=>setDirty(false)} />
    </SS>
  );
}

/* ---- Export ---- */
function AccountSettings({ section, toast }) {
  const sections = { profile: ProfileSection, password: PasswordSection, mfa: MFASection, tokens: TokensSection, preferences: PreferencesSection };
  const Comp = sections[section] || ProfileSection;
  return <div className="settings-inner"><Comp toast={toast} /></div>;
}
Object.assign(window, { AccountSettings });
