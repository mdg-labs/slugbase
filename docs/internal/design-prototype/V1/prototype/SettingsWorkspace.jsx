/* SlugBase — Workspace Settings (General / SMTP / AI / OIDC + hosted toggle) */

const OIDC_PROVIDERS = [
  { id:"github-oidc", key:"github", clientId:"Ov23liQ9aT7KxRmbf3qA", enabled:true },
  { id:"google-oidc", key:"google", clientId:"924876310254-abc...oauth.apps.googleusercontent.com", enabled:false },
];

/* ---- General section ---- */
function GeneralSection({ toast }) {
  const [wsName, setWsName] = useState("Personal");
  const [wsSlug, setWsSlug] = useState("personal");
  const [dirty, setDirty] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const d = (fn) => (...a) => { fn(...a); setDirty(true); };

  return (
    <SS title="General" description="Basic settings for this workspace.">
      <FG label="Workspace name">
        <FF><input value={wsName} onChange={d(e=>setWsName(e.target.value))} /></FF>
      </FG>
      <FG label="Workspace identifier" hint="Used in URLs. Lowercase letters, numbers, and hyphens only.">
        <FF icon="at-sign"><input value={wsSlug} onChange={d(e=>setWsSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,"")))} /></FF>
      </FG>
      <SaveBar dirty={dirty} onSave={()=>{setDirty(false);toast({icon:"check",title:"Workspace settings saved"});}} onDiscard={()=>{setWsName("Personal");setWsSlug("personal");setDirty(false);}} />
      <DangerZone
        title="Delete workspace"
        description="Permanently delete this workspace and all its bookmarks, folders, and tags. This action cannot be undone."
        action="Delete workspace…"
        onAction={()=>setShowDeleteConfirm(true)}
      />
      {showDeleteConfirm && (
        <div style={{background:"var(--danger-subtle)",border:"1px solid rgba(240,104,107,0.3)",borderRadius:"var(--r-md)",padding:"var(--sp-6)",display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <p style={{margin:0,fontSize:"var(--text-body)",color:"var(--fg-muted)"}}>
            Type <b style={{fontFamily:"var(--font-mono)",color:"var(--danger-text)"}}>personal</b> to confirm deletion.
          </p>
          <FF><input value={deleteInput} onChange={e=>setDeleteInput(e.target.value)} placeholder="personal" autoFocus /></FF>
          <div style={{display:"flex",gap:"var(--sp-4)"}}>
            <button className="btn btn--danger btn--sm" disabled={deleteInput!=="personal"} style={deleteInput!=="personal"?{opacity:.4,cursor:"not-allowed"}:undefined}
              onClick={()=>toast({icon:"trash-2",title:"Workspace deleted"})}>Delete permanently</button>
            <button className="btn btn--ghost btn--sm" onClick={()=>{setShowDeleteConfirm(false);setDeleteInput("");}}>Cancel</button>
          </div>
        </div>
      )}
    </SS>
  );
}

/* ---- SMTP section ---- */
function SMTPSection({ toast }) {
  const [host, setHost] = useState("smtp.mailgun.org");
  const [port, setPort] = useState("587");
  const [security, setSecurity] = useState("STARTTLS");
  const [user, setUser] = useState("postmaster@mg.acme.com");
  const [pass, setPass] = useState("••••••••••••••••");
  const [fromAddr, setFromAddr] = useState("noreply@acme.com");
  const [fromName, setFromName] = useState("SlugBase");
  const [dirty, setDirty] = useState(false);
  const [testState, setTestState] = useState(null); // null | testing | ok | fail
  const d = (fn) => (...a) => { fn(...a); setDirty(true); };

  const testEmail = () => {
    setTestState("testing");
    setTimeout(() => { setTestState(Math.random() > 0.2 ? "ok" : "fail"); }, 1500);
  };

  return (
    <SS title="Email / SMTP" description="Configure outbound email for invitations, verification links, and password resets.">
      <div className="form-cols">
        <FG label="SMTP host">
          <FF><input value={host} onChange={d(e=>setHost(e.target.value))} /></FF>
        </FG>
        <FG label="Port">
          <FF><input value={port} onChange={d(e=>setPort(e.target.value))} style={{width:80}} /></FF>
        </FG>
      </div>
      <FG label="Security">
        <select className="select-ff" style={{width:200}} value={security} onChange={d(e=>setSecurity(e.target.value))}>
          <option>TLS</option><option>STARTTLS</option><option>None</option>
        </select>
      </FG>
      <div className="form-cols">
        <FG label="SMTP username">
          <FF><input value={user} onChange={d(e=>setUser(e.target.value))} /></FF>
        </FG>
        <FG label="SMTP password">
          <FF icon="lock"><input type="password" value={pass} onChange={d(e=>setPass(e.target.value))} /></FF>
        </FG>
      </div>
      <div className="form-cols">
        <FG label="From address">
          <FF icon="mail"><input value={fromAddr} onChange={d(e=>setFromAddr(e.target.value))} /></FF>
        </FG>
        <FG label="From name">
          <FF><input value={fromName} onChange={d(e=>setFromName(e.target.value))} /></FF>
        </FG>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:"var(--sp-4)"}}>
        <button className="btn btn--secondary btn--sm" onClick={testEmail} disabled={testState==="testing"}>
          {testState==="testing" ? <><Icon name="loader" size={14} className="spin"/>Testing…</> : <><Icon name="send" size={14}/>Send test email</>}
        </button>
        {testState==="ok" && <span style={{fontSize:"var(--text-small)",color:"var(--success-text)",display:"flex",alignItems:"center",gap:4}}><Icon name="check-circle" size={14}/>Test email delivered</span>}
        {testState==="fail" && <span style={{fontSize:"var(--text-small)",color:"var(--danger-text)",display:"flex",alignItems:"center",gap:4}}><Icon name="x-circle" size={14}/>Delivery failed — check credentials</span>}
      </div>
      <SaveBar dirty={dirty} onSave={()=>{setDirty(false);toast({icon:"check",title:"SMTP settings saved"});}} onDiscard={()=>setDirty(false)} />
    </SS>
  );
}

/* ---- AI section ---- */
function AISection({ hosted, toast }) {
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("sk-ant-api03-••••••••••");
  const [model, setModel] = useState("claude-haiku-3-5");
  const [dirty, setDirty] = useState(false);
  const d = (fn) => (...a) => { fn(...a); setDirty(true); };

  return (
    <SS title="AI suggestions" description="When enabled, SlugBase can suggest slugs, tags, and folders based on bookmark content.">
      <ToggleRow label="Enable AI suggestions" hint="Applies workspace-wide. Individual users can opt out in their own preferences." on={enabled} onChange={d(setEnabled)} withBorder />
      {!hosted && enabled && (
        <>
          <FG label="Provider">
            <select className="select-ff" style={{width:220}} value={provider} onChange={d(e=>setProvider(e.target.value))}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (self-hosted)</option>
            </select>
          </FG>
          <FG label="API key" hint="Stored encrypted. Never logged or exposed.">
            <FF icon="key-round"><input type="password" value={apiKey} onChange={d(e=>setApiKey(e.target.value))} /></FF>
          </FG>
          <FG label="Model">
            <select className="select-ff" style={{width:260}} value={model} onChange={d(e=>setModel(e.target.value))}>
              <option value="claude-haiku-3-5">Claude Haiku 3.5 (fast)</option>
              <option value="claude-sonnet-3-5">Claude Sonnet 3.5</option>
              <option value="gpt-4o-mini">GPT-4o mini</option>
              <option value="gpt-4o">GPT-4o</option>
            </select>
          </FG>
          <SaveBar dirty={dirty} onSave={()=>{setDirty(false);toast({icon:"check",title:"AI settings saved"});}} onDiscard={()=>setDirty(false)} />
        </>
      )}
      {hosted && enabled && (
        <InfoBox icon="info">On the hosted plan, AI features use the provider configured by SlugBase. Individual users can opt out in <b>Preferences</b>.</InfoBox>
      )}
    </SS>
  );
}

/* ---- OIDC section ---- */
function OIDCSection({ toast }) {
  const [providers, setProviders] = useState(OIDC_PROVIDERS);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ key:"",clientId:"",clientSecret:"",issuer:"",scopes:"openid email profile",autoCreate:true,defaultRole:"member" });
  const CALLBACK = "https://go.slugbase.app/auth/callback/oidc";
  const setF = (k,v) => setForm(f=>({...f,[k]:v}));

  const addProvider = () => {
    setProviders(ps=>[...ps,{id:Date.now(),key:form.key,clientId:form.clientId,enabled:true}]);
    setAddOpen(false);
    setForm({key:"",clientId:"",clientSecret:"",issuer:"",scopes:"openid email profile",autoCreate:true,defaultRole:"member"});
    toast({icon:"fingerprint",title:`OIDC provider "${form.key}" added`});
  };

  return (
    <SS title="Identity providers" description="Configure external OIDC providers to allow federated sign-in and (optionally) auto-provisioning.">
      {providers.length > 0 ? (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",overflow:"hidden"}}>
          {providers.map(p=>(
            <div key={p.id} className="oidc-row">
              <span className="oidc-key">{p.key}</span>
              <span className="oidc-client">{p.clientId.length>30?p.clientId.slice(0,30)+"…":p.clientId}</span>
              <span className={"status-badge "+(p.enabled?"active":"locked")}>{p.enabled?"Enabled":"Disabled"}</span>
              <button className="icon-btn icon-btn--sm" title="Edit" onClick={()=>toast({icon:"pencil",title:`Edit ${p.key}`})}><Icon name="pencil" size={14}/></button>
              <button className="icon-btn icon-btn--sm" title="Delete" style={{color:"var(--danger-text)"}} onClick={()=>{setProviders(ps=>ps.filter(x=>x.id!==p.id));toast({icon:"trash-2",title:`Provider "${p.key}" removed`});}}><Icon name="trash-2" size={14}/></button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{textAlign:"center",padding:"var(--sp-9)",color:"var(--fg-subtle)"}}>
          <Icon name="fingerprint" size={32} strokeWidth={1.25} style={{color:"var(--fg-faint)",display:"block",margin:"0 auto var(--sp-5)"}} />
          <p style={{margin:0}}>No identity providers configured. Add one to enable federated sign-in.</p>
        </div>
      )}

      {!addOpen && <button className="btn btn--secondary btn--sm" onClick={()=>setAddOpen(true)}><Icon name="plus" size={15}/>Add provider</button>}

      {addOpen && (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",padding:"var(--sp-6)",display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <div style={{fontWeight:"var(--weight-semi)",fontSize:"var(--text-body-lg)",color:"var(--fg)"}}>New identity provider</div>
          <FG label="Callback URL — register this with your provider" hint="Read-only.">
            <CopyField value={CALLBACK} label="Callback URL" toast={toast} />
          </FG>
          <div className="form-cols">
            <FG label="Provider key" hint='Short identifier, e.g. "github", "okta"'><FF><input value={form.key} onChange={e=>setF("key",e.target.value)} placeholder="e.g. okta" /></FF></FG>
            <FG label="Client ID"><FF><input value={form.clientId} onChange={e=>setF("clientId",e.target.value)} /></FF></FG>
          </div>
          <FG label="Client secret"><FF icon="lock"><input type="password" value={form.clientSecret} onChange={e=>setF("clientSecret",e.target.value)} placeholder="••••••••" /></FF></FG>
          <FG label="Issuer URL" hint="e.g. https://accounts.google.com or your Okta domain"><FF icon="link"><input value={form.issuer} onChange={e=>setF("issuer",e.target.value)} placeholder="https://…" /></FF></FG>
          <FG label="Scopes"><FF><input value={form.scopes} onChange={e=>setF("scopes",e.target.value)} /></FF></FG>
          <ToggleRow label="Auto-create accounts on first login" hint="Automatically provisions new workspace members." on={form.autoCreate} onChange={v=>setF("autoCreate",v)} />
          {form.autoCreate && (
            <FG label="Default role for auto-created accounts">
              <select className="select-ff" style={{width:200}} value={form.defaultRole} onChange={e=>setF("defaultRole",e.target.value)}>
                <option value="member">Member</option><option value="admin">Admin</option>
              </select>
            </FG>
          )}
          <div style={{display:"flex",gap:"var(--sp-4)"}}>
            <button className="btn btn--primary btn--sm" disabled={!form.key||!form.clientId||!form.issuer} style={(!form.key||!form.clientId||!form.issuer)?{opacity:.4,cursor:"not-allowed"}:undefined} onClick={addProvider}><Icon name="plus" size={15}/>Add provider</button>
            <button className="btn btn--ghost btn--sm" onClick={()=>setAddOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </SS>
  );
}

/* ---- Export ---- */
function WorkspaceSettings({ section, hosted, toast }) {
  const sectionMap = {
    general: <GeneralSection toast={toast} />,
    smtp: hosted ? null : <SMTPSection toast={toast} />,
    ai: <AISection hosted={hosted} toast={toast} />,
    oidc: hosted ? null : <OIDCSection toast={toast} />,
  };
  const rendered = sectionMap[section];
  if (rendered === null) return (
    <div className="settings-inner">
      <InfoBox icon="cloud">This panel is managed by SlugBase and is not available on the hosted plan.</InfoBox>
    </div>
  );
  return <div className="settings-inner">{rendered || <GeneralSection toast={toast} />}</div>;
}
Object.assign(window, { WorkspaceSettings });
