/* SlugBase — Members & Teams (tabs, entitlement gate, pending invites, seat usage) */

const INIT_MEMBERS = [
  { id:1, name:"Alex Kerr",  initials:"AK", color:"#7782f7", email:"alex@inboxops.app",  role:"owner",  joined:"Jan 2024", last:"2h ago" },
  { id:2, name:"Sarah K.",   initials:"SK", color:"#45c98a", email:"sarah@acme.com",      role:"admin",  joined:"Feb 2024", last:"1d ago" },
  { id:3, name:"Tom R.",     initials:"TR", color:"#e6b24e", email:"tom@acme.com",        role:"member", joined:"Mar 2024", last:"3d ago" },
  { id:4, name:"Jamie L.",   initials:"JL", color:"#f0686b", email:"jamie@acme.com",      role:"member", joined:"Apr 2024", last:"1w ago" },
];
const INIT_PENDING = [
  { id:5, email:"nina@acme.com",    invitedBy:"Alex Kerr", expiry:"Jun 15, 2026", role:"member" },
  { id:6, email:"carlos@acme.com",  invitedBy:"Sarah K.",  expiry:"Jun 18, 2026", role:"member" },
];
const INIT_TEAMS = [
  { id:1, name:"Frontend",        desc:"Product engineers — web",      members:[1,2,3] },
  { id:2, name:"Infrastructure",  desc:"Infra, DevOps, and security",  members:[1,4] },
];
const SEAT_LIMIT = 8;

function MembersTab({ plan, members, setMembers, pending, setPending, toast, atSeatLimit }) {
  const [inviteOpen, setInviteOpen]       = useState(false);
  const [inviteEmail, setInviteEmail]     = useState("nina2@acme.com");
  const [inviteRole, setInviteRole]       = useState("member");
  const [removeConfirm, setRemoveConfirm] = useState(null);
  const [ownerXfer, setOwnerXfer]         = useState(null);

  const changeRole = (id, role) => {
    if (role === "owner") { setOwnerXfer(id); return; }
    setMembers(ms => ms.map(m => m.id === id ? { ...m, role } : m));
    toast({ icon:"user-check", title:"Role updated" });
  };
  const removeMember = (id) => {
    setMembers(ms => ms.filter(m => m.id !== id));
    setRemoveConfirm(null);
    toast({ icon:"user-minus", title:"Member removed" });
  };
  const confirmXfer = () => {
    const target = members.find(m => m.id === ownerXfer);
    setMembers(ms => ms.map(m => m.id === 1 ? {...m,role:"admin"} : m.id === ownerXfer ? {...m,role:"owner"} : m));
    setOwnerXfer(null);
    toast({ icon:"crown", title:`Ownership transferred to ${target.name}` });
  };
  const invite = () => {
    if (atSeatLimit) return;
    setPending(ps => [...ps, { id:Date.now(), email:inviteEmail, invitedBy:"Alex Kerr", expiry:"Jun 30, 2026", role:inviteRole }]);
    toast({ icon:"mail", title:`Invitation sent to ${inviteEmail}` });
    setInviteOpen(false); setInviteEmail(""); setInviteRole("member");
  };
  const revokeInvite = (id) => { setPending(ps=>ps.filter(p=>p.id!==id)); toast({icon:"x",title:"Invitation revoked"}); };
  const resendInvite = (id) => { const p=pending.find(x=>x.id===id); toast({icon:"mail",title:`Invitation resent to ${p.email}`}); };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-8)"}}>
      {/* Seat usage (hosted only visual) */}
      {plan !== "free" && (
        <div className="seat-bar">
          <div className="seat-bar-top">
            <span><b>{members.length + pending.length}</b> of <b>{SEAT_LIMIT}</b> seats used</span>
            <a style={{color:"var(--accent-text)",fontSize:"var(--text-small)",cursor:"pointer"}} onClick={()=>toast({icon:"credit-card",title:"Manage billing"})}>Manage seats →</a>
          </div>
          <div style={{height:5,background:"var(--canvas)",borderRadius:99,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:99,background:members.length+pending.length>=SEAT_LIMIT?"var(--danger)":"var(--accent)",width:`${Math.min(100,Math.round((members.length+pending.length)/SEAT_LIMIT*100))}%`,transition:"width var(--dur) var(--ease)"}} />
          </div>
        </div>
      )}

      {/* Member list */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"var(--sp-6)"}}>
          <h3 style={{margin:0,font:"var(--weight-semi) var(--text-body-lg)/1 var(--font-sans)",color:"var(--fg)"}}>Members <span style={{color:"var(--fg-subtle)",fontFamily:"var(--font-mono)",fontWeight:400}}>{members.length}</span></h3>
          <button className="btn btn--primary btn--sm" onClick={()=>atSeatLimit ? toast({icon:"alert-triangle",title:"Seat limit reached"}) : setInviteOpen(o=>!o)}>
            <Icon name="user-plus" size={15}/>Invite member
          </button>
        </div>

        {inviteOpen && (
          <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",padding:"var(--sp-5)",marginBottom:"var(--sp-5)",display:"flex",flexDirection:"column",gap:"var(--sp-4)"}}>
            {atSeatLimit && <WarnBox><b>Seat limit reached.</b> You're using all {SEAT_LIMIT} seats. Purchase more to invite additional members.</WarnBox>}
            <div style={{display:"flex",gap:"var(--sp-4)",alignItems:"flex-end"}}>
              <FG label="Email address" style={{flex:1}}>
                <FF icon="mail"><input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="colleague@company.com" disabled={atSeatLimit} /></FF>
              </FG>
              <FG label="Role">
                <select className="select-ff" value={inviteRole} onChange={e=>setInviteRole(e.target.value)} disabled={atSeatLimit}>
                  <option value="member">Member</option><option value="admin">Admin</option>
                </select>
              </FG>
              <button className="btn btn--primary btn--sm" disabled={!inviteEmail.trim()||atSeatLimit} onClick={invite} style={(!inviteEmail.trim()||atSeatLimit)?{opacity:.4,cursor:"not-allowed"}:undefined}>Send invite</button>
              <button className="btn btn--ghost btn--sm" onClick={()=>setInviteOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

        {ownerXfer && (
          <div style={{background:"var(--warning-subtle)",border:"1px solid rgba(230,178,78,0.3)",borderRadius:"var(--r-md)",padding:"var(--sp-5)",marginBottom:"var(--sp-5)"}}>
            <p style={{margin:"0 0 var(--sp-4)",fontSize:"var(--text-body)",color:"var(--fg-muted)"}}>Transfer ownership to <b style={{color:"var(--fg)"}}>{members.find(m=>m.id===ownerXfer)?.name}</b>? You will become an admin. This cannot be undone.</p>
            <div style={{display:"flex",gap:"var(--sp-4)"}}><button className="btn btn--primary btn--sm" onClick={confirmXfer}>Confirm transfer</button><button className="btn btn--ghost btn--sm" onClick={()=>setOwnerXfer(null)}>Cancel</button></div>
          </div>
        )}

        <div style={{borderTop:"1px solid var(--border-subtle)"}}>
          {members.map(m => (
            <div key={m.id}>
              <div className="member-row">
                <div className="av av-md" style={{background:m.color,color:"#0b0c14"}}>{m.initials}</div>
                <div className="member-info">
                  <div className="member-name">{m.name}{m.role==="owner" && <span className="status-badge active"><Icon name="crown" size={10}/>Owner</span>}</div>
                  <div className="member-email">{m.email}</div>
                </div>
                <span className="member-last">{m.last}</span>
                <select className="role-select" value={m.role} onChange={e=>changeRole(m.id,e.target.value)} disabled={m.role==="owner"&&members.filter(x=>x.role==="owner").length<=1}>
                  <option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner…</option>
                </select>
                <button className="icon-btn icon-btn--sm" title="Remove" disabled={m.role==="owner"} style={m.role==="owner"?{opacity:.3,cursor:"not-allowed"}:undefined} onClick={()=>setRemoveConfirm(m.id)}><Icon name="user-minus" size={15}/></button>
              </div>
              {removeConfirm===m.id && (
                <div style={{padding:"var(--sp-4) var(--sp-5) var(--sp-4) 56px",background:"var(--danger-subtle)",borderBottom:"1px solid rgba(240,104,107,0.2)",display:"flex",alignItems:"center",gap:"var(--sp-5)"}}>
                  <span style={{flex:1,fontSize:"var(--text-small)",color:"var(--fg-muted)"}}>Remove <b style={{color:"var(--fg)"}}>{m.name}</b>? Their bookmarks stay in the workspace.</span>
                  <button className="btn btn--danger btn--sm" onClick={()=>removeMember(m.id)}>Remove</button>
                  <button className="btn btn--ghost btn--sm" onClick={()=>setRemoveConfirm(null)}>Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Pending invitations */}
      {pending.length > 0 && (
        <div>
          <h3 style={{margin:"0 0 var(--sp-5)",font:"var(--weight-semi) var(--text-body-lg)/1 var(--font-sans)",color:"var(--fg)"}}>Pending invitations <span style={{color:"var(--fg-subtle)",fontFamily:"var(--font-mono)",fontWeight:400}}>{pending.length}</span></h3>
          <div style={{borderTop:"1px solid var(--border-subtle)"}}>
            {pending.map(p=>(
              <div key={p.id} className="pending-row">
                <div className="av av-sm" style={{background:"var(--raised-2)",color:"var(--fg-subtle)"}}><Icon name="mail" size={12}/></div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-small)",color:"var(--fg)"}}>{p.email}</div>
                  <div style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)"}}>Invited by {p.invitedBy} · Expires {p.expiry}</div>
                </div>
                <span className="status-badge pending">{p.role}</span>
                <button className="btn btn--ghost btn--sm" onClick={()=>resendInvite(p.id)}><Icon name="send" size={13}/>Resend</button>
                <button className="icon-btn icon-btn--sm" title="Revoke" onClick={()=>revokeInvite(p.id)}><Icon name="x" size={14}/></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamsTab({ members, toast }) {
  const [teams, setTeams] = useState(INIT_TEAMS);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [expanded, setExpanded] = useState(null);

  const createTeam = () => {
    setTeams(ts=>[...ts,{id:Date.now(),name:newName,desc:newDesc,members:[1]}]);
    toast({icon:"users",title:`Team "${newName}" created`});
    setCreating(false); setNewName(""); setNewDesc("");
  };
  const deleteTeam = (id) => { const t=teams.find(x=>x.id===id); setTeams(ts=>ts.filter(x=>x.id!==id)); toast({icon:"trash-2",title:`Team "${t.name}" deleted`}); };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-6)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <h3 style={{margin:0,font:"var(--weight-semi) var(--text-body-lg)/1 var(--font-sans)",color:"var(--fg)"}}>Teams <span style={{color:"var(--fg-subtle)",fontFamily:"var(--font-mono)",fontWeight:400}}>{teams.length}</span></h3>
        <button className="btn btn--primary btn--sm" onClick={()=>setCreating(o=>!o)}><Icon name="plus" size={15}/>New team</button>
      </div>
      {creating && (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",padding:"var(--sp-5)",display:"flex",flexDirection:"column",gap:"var(--sp-4)"}}>
          <FG label="Team name"><FF><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Design" autoFocus /></FF></FG>
          <FG label="Description"><FF><input value={newDesc} onChange={e=>setNewDesc(e.target.value)} placeholder="Optional" /></FF></FG>
          <div style={{display:"flex",gap:"var(--sp-4)"}}><button className="btn btn--primary btn--sm" disabled={!newName.trim()} onClick={createTeam}>Create team</button><button className="btn btn--ghost btn--sm" onClick={()=>setCreating(false)}>Cancel</button></div>
        </div>
      )}
      {teams.length===0 && !creating && (
        <div style={{textAlign:"center",padding:"var(--sp-9)",color:"var(--fg-subtle)"}}>
          <Icon name="users" size={32} strokeWidth={1.25} style={{color:"var(--fg-faint)",display:"block",margin:"0 auto var(--sp-5)"}} />
          <p style={{margin:0}}>No teams yet. Create one to group members and share access.</p>
        </div>
      )}
      {teams.map(t=>(
        <div key={t.id} className="team-card">
          <div className="team-card-head">
            <div>
              <h4 className="team-card-head">{t.name}</h4>
              {t.desc && <div className="team-card-desc">{t.desc}</div>}
            </div>
            <button className="icon-btn icon-btn--sm" title="Expand" onClick={()=>setExpanded(e=>e===t.id?null:t.id)}><Icon name={expanded===t.id?"chevron-up":"chevron-down"} size={15}/></button>
            <button className="icon-btn icon-btn--sm" title="Delete" style={{color:"var(--danger-text)"}} onClick={()=>deleteTeam(t.id)}><Icon name="trash-2" size={14}/></button>
          </div>
          {expanded===t.id && (
            <div style={{borderTop:"1px solid var(--border-subtle)"}}>
              <div className="team-members">
                {t.members.map(mid=>{const m=members.find(x=>x.id===mid)||{initials:"?",color:"#333",name:"Unknown"}; return (
                  <div key={mid} style={{display:"flex",alignItems:"center",gap:"var(--sp-3)",height:28,padding:"0 var(--sp-4)",background:"var(--raised)",borderRadius:99,fontSize:"var(--text-small)",color:"var(--fg-muted)"}}>
                    <div className="av av-sm" style={{background:m.color,color:"#0b0c14"}}>{m.initials}</div>{m.name}
                  </div>);})}
                <button className="btn btn--ghost btn--sm" onClick={()=>toast({icon:"user-plus",title:"Add member to team"})}><Icon name="plus" size={13}/>Add</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MembersSettings({ plan, toast }) {
  const [tab, setTab] = useState("members");
  const [members, setMembers] = useState(INIT_MEMBERS);
  const [pending, setPending] = useState(INIT_PENDING);
  const [demoAtSeatLimit, setDemoAtSeatLimit] = useState(false);

  if (plan === "free" || plan === "pro") {
    return <div className="settings-inner"><PlanGate plan="Team" feature="members & teams" onUpgrade={()=>toast({icon:"zap",title:"Upgrade to Team"})} /></div>;
  }

  return (
    <div className="settings-inner" style={{maxWidth:680}}>
      <div className="dev-strip" style={{borderRadius:"var(--r-md)",marginBottom:"var(--sp-4)"}}>
        <strong>Demo:</strong>
        <select value={demoAtSeatLimit?"limit":"ok"} onChange={e=>setDemoAtSeatLimit(e.target.value==="limit")}>
          <option value="ok">Normal (seats available)</option>
          <option value="limit">At seat limit</option>
        </select>
      </div>
      <div className="tab-row">
        {["members","teams"].map(t=>(
          <div key={t} className={"tab-btn"+(tab===t?" active":"")} onClick={()=>setTab(t)}>
            <Icon name={t==="members"?"users-round":"grid-2x2"} size={15}/>
            {t==="members"?`Members (${members.length})`:`Teams (${INIT_TEAMS.length})`}
          </div>
        ))}
      </div>
      {tab==="members" && <MembersTab plan={plan} members={members} setMembers={setMembers} pending={pending} setPending={setPending} toast={toast} atSeatLimit={demoAtSeatLimit} />}
      {tab==="teams"   && <TeamsTab members={members} toast={toast} />}
    </div>
  );
}
Object.assign(window, { MembersSettings });
