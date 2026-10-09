/* SlugBase — Audit Log (paginated, filters, entitlement gate) */

const AUDIT_ENTRIES = [
  {id:1,  ts:"2026-05-31 14:23", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"created bookmark",     entity:"React 19 — useOptimistic & Actions",  type:"bookmark"},
  {id:2,  ts:"2026-05-31 11:12", actor:{n:"Sarah K.",   i:"SK",c:"#45c98a"}, action:"invited member",        entity:"nina@acme.com",                        type:"member"},
  {id:3,  ts:"2026-05-31 09:45", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"created folder",        entity:"Design",                               type:"folder"},
  {id:4,  ts:"2026-05-30 18:30", actor:{n:"Tom R.",     i:"TR",c:"#e6b24e"}, action:"deleted bookmark",      entity:"The Grug Brained Developer",           type:"bookmark"},
  {id:5,  ts:"2026-05-30 16:11", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"changed role of",       entity:"sarah@acme.com",                       type:"member", suffix:"to admin"},
  {id:6,  ts:"2026-05-30 14:05", actor:{n:"Sarah K.",   i:"SK",c:"#45c98a"}, action:"created tag",           entity:"security",                             type:"tag"},
  {id:7,  ts:"2026-05-30 11:58", actor:{n:"Jamie L.",   i:"JL",c:"#f0686b"}, action:"pinned bookmark",       entity:"Designing Data-Intensive Applications",type:"bookmark"},
  {id:8,  ts:"2026-05-29 17:40", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"updated workspace name",entity:"Personal → Acme Engineering",          type:"settings"},
  {id:9,  ts:"2026-05-29 15:22", actor:{n:"Sarah K.",   i:"SK",c:"#45c98a"}, action:"created team",          entity:"Frontend",                             type:"team"},
  {id:10, ts:"2026-05-29 13:09", actor:{n:"Tom R.",     i:"TR",c:"#e6b24e"}, action:"added slug",            entity:"go.slugbase.app/rustperf",             type:"bookmark"},
  {id:11, ts:"2026-05-28 16:45", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"revoked API token",     entity:"CI pipeline",                          type:"auth"},
  {id:12, ts:"2026-05-28 14:31", actor:{n:"Jamie L.",   i:"JL",c:"#f0686b"}, action:"deleted folder",        entity:"Archive",                              type:"folder"},
  {id:13, ts:"2026-05-28 11:20", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"enabled MFA",           entity:"alex@inboxops.app",                    type:"auth"},
  {id:14, ts:"2026-05-27 17:05", actor:{n:"Sarah K.",   i:"SK",c:"#45c98a"}, action:"removed member",        entity:"carlos@acme.com",                      type:"member"},
  {id:15, ts:"2026-05-27 14:00", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"created bookmark",     entity:"Caddy — automatic HTTPS reverse proxy", type:"bookmark"},
  {id:16, ts:"2026-05-27 10:33", actor:{n:"Tom R.",     i:"TR",c:"#e6b24e"}, action:"shared bookmark",       entity:"The Illustrated Transformer",          type:"bookmark"},
  {id:17, ts:"2026-05-26 16:55", actor:{n:"Alex Kerr",  i:"AK",c:"#7782f7"}, action:"added OIDC provider",   entity:"github",                               type:"settings"},
  {id:18, ts:"2026-05-26 11:12", actor:{n:"Jamie L.",   i:"JL",c:"#f0686b"}, action:"renamed tag",           entity:"tools → tool",                         type:"tag"},
];

const LOG_TYPES = ["All","bookmark","folder","tag","member","team","settings","auth"];
const PAGE_SIZE = 8;

function SkeletonLog() {
  return (
    <div style={{borderTop:"1px solid var(--border-subtle)"}}>
      {Array.from({length:6}).map((_,i)=>(
        <div key={i} className="log-row" style={{gap:"var(--sp-5)"}}>
          <div className="sk" style={{width:110,height:11}} />
          <div className="sk" style={{width:28,height:28,borderRadius:99}} />
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
            <div className="sk" style={{width:200+i*30,height:12}} />
          </div>
          <div className="sk" style={{width:60,height:18,borderRadius:4}} />
        </div>
      ))}
    </div>
  );
}

function AuditSettings({ plan, toast }) {
  const [loading, setLoading]   = useState(true);
  const [q, setQ]               = useState("");
  const [filterActor, setFilterActor] = useState("all");
  const [filterType, setFilterType]   = useState("All");
  const [page, setPage]         = useState(0);
  const [typeOpen, setTypeOpen] = useState(false);
  const typeRef = useRef(null);
  useClickOutside(typeRef, () => setTypeOpen(false), typeOpen);
  useEffect(()=>{ const t=setTimeout(()=>setLoading(false),800); return ()=>clearTimeout(t); },[]);

  if (plan==="free" || plan==="pro") {
    return <div className="settings-inner"><PlanGate plan="Team" feature="the audit log" onUpgrade={()=>toast({icon:"zap",title:"Upgrade to Team"})} /></div>;
  }

  const actors = [{ id:"all", label:"All members" }, ...Array.from(new Set(AUDIT_ENTRIES.map(e=>e.actor.n))).map(n=>({ id:n, label:n }))];

  const filtered = AUDIT_ENTRIES.filter(e => {
    if (filterActor !== "all" && e.actor.n !== filterActor) return false;
    if (filterType !== "All" && e.type !== filterType) return false;
    if (q) {
      const ql = q.toLowerCase();
      return e.action.includes(ql) || e.entity.toLowerCase().includes(ql) || e.actor.n.toLowerCase().includes(ql);
    }
    return true;
  });

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages-1);
  const pageItems = filtered.slice(cur*PAGE_SIZE, cur*PAGE_SIZE+PAGE_SIZE);
  const hasFilters = q || filterActor !== "all" || filterType !== "All";

  return (
    <div className="settings-inner" style={{maxWidth:720}}>
      <div className="ss-head">
        <h2 className="ss-title">Audit log</h2>
        <p className="ss-desc">A read-only record of significant workspace actions. Only visible to admins and owners.</p>
      </div>

      {/* Filter bar */}
      <div style={{display:"flex",gap:"var(--sp-4)",flexWrap:"wrap",marginBottom:"var(--sp-5)"}}>
        <div className="field" style={{width:220}}>
          <Icon name="search" size={15}/>
          <input value={q} onChange={e=>{setQ(e.target.value);setPage(0);}} placeholder="Search log…"/>
          {q && <span style={{cursor:"pointer",color:"var(--fg-faint)"}} onClick={()=>{setQ("");setPage(0);}}><Icon name="x" size={13}/></span>}
        </div>
        <select className="select-ff" style={{width:160}} value={filterActor} onChange={e=>{setFilterActor(e.target.value);setPage(0);}}>
          {actors.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <div style={{position:"relative"}} ref={typeRef}>
          <button className={"chip"+(filterType!=="All"?" on":"")} onClick={()=>setTypeOpen(o=>!o)}>
            <Icon name="filter" size={14}/>{filterType==="All"?"All types":filterType}<Icon name="chevron-down" size={12} className="ic-r"/>
          </button>
          {typeOpen && (
            <div className="menu" style={{left:0,top:"calc(100% + 6px)",minWidth:170}}>
              <div className="menu-head">Entity type</div>
              {LOG_TYPES.map(t=>(
                <MenuItem key={t} check={filterType===t} onClick={()=>{setFilterType(t);setTypeOpen(false);setPage(0);}}>{t==="All"?"All types":t}</MenuItem>
              ))}
            </div>
          )}
        </div>
        {hasFilters && <button className="chip" style={{color:"var(--danger-text)"}} onClick={()=>{setQ("");setFilterActor("all");setFilterType("All");setPage(0);}}>
          <Icon name="x" size={13}/>Clear
        </button>}
        <span style={{marginLeft:"auto",fontSize:"var(--text-small)",color:"var(--fg-subtle)",fontFamily:"var(--font-mono)",alignSelf:"center"}}>{filtered.length} event{filtered.length!==1?"s":""}</span>
      </div>

      {loading ? <SkeletonLog /> : filtered.length===0 ? (
        <div style={{textAlign:"center",padding:"var(--sp-10)",color:"var(--fg-subtle)"}}>
          <Icon name="scroll-text" size={32} strokeWidth={1.25} style={{color:"var(--fg-faint)",display:"block",margin:"0 auto var(--sp-5)"}}/>
          <p style={{margin:0}}>{hasFilters ? "No log entries match these filters." : "No audit log entries yet."}</p>
          {hasFilters && <button className="btn btn--ghost btn--sm" style={{marginTop:"var(--sp-5)"}} onClick={()=>{setQ("");setFilterActor("all");setFilterType("All");}}><Icon name="filter-x" size={14}/>Clear filters</button>}
        </div>
      ) : (
        <>
          <div style={{borderTop:"1px solid var(--border-subtle)"}}>
            {pageItems.map(e=>(
              <div key={e.id} className="log-row">
                <span className="log-ts">{e.ts}</span>
                <div className="log-actor">
                  <div className="av av-sm" style={{background:e.actor.c,color:"#0b0c14"}}>{e.actor.i}</div>
                  {e.actor.n}
                </div>
                <span className="log-action">
                  {e.action} <span className="log-entity">{e.entity}</span>{e.suffix && ` ${e.suffix}`}
                </span>
                <span className="log-type-badge">{e.type}</span>
              </div>
            ))}
          </div>
          {pages > 1 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:"var(--sp-5)",borderTop:"1px solid var(--border-subtle)",marginTop:"var(--sp-4)"}}>
              <span style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)"}}>Showing <b style={{color:"var(--fg-muted)",fontFamily:"var(--font-mono)"}}>{cur*PAGE_SIZE+1}</b>–<b style={{color:"var(--fg-muted)",fontFamily:"var(--font-mono)"}}>{Math.min((cur+1)*PAGE_SIZE,filtered.length)}</b> of <b style={{color:"var(--fg-muted)",fontFamily:"var(--font-mono)"}}>{filtered.length}</b></span>
              <div className="pager-nav">
                <button className="pg" disabled={cur===0} onClick={()=>setPage(p=>p-1)}><Icon name="chevron-left" size={14}/></button>
                {Array.from({length:pages}).map((_,i)=><button key={i} className={"pg"+(i===cur?" on":"")} onClick={()=>setPage(i)}>{i+1}</button>)}
                <button className="pg" disabled={cur>=pages-1} onClick={()=>setPage(p=>p+1)}><Icon name="chevron-right" size={14}/></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
Object.assign(window, { AuditSettings });
