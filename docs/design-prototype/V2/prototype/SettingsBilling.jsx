/* SlugBase — Plans & Billing (hosted-only). Self-hosted: this surface does not exist. */

const BILLING_STATES = [
  { id:"free-under",       label:"Free — under cap (23/50)" },
  { id:"free-approaching", label:"Free — approaching cap (47/50)" },
  { id:"free-at-cap",      label:"Free — at cap (50/50)" },
  { id:"personal-monthly", label:"Personal — monthly" },
  { id:"personal-yearly",  label:"Personal — yearly" },
  { id:"team",             label:"Team — active" },
  { id:"cancelled",        label:"Cancelled / pending downgrade" },
  { id:"post-downgrade",   label:"Post-downgrade with archived bookmarks" },
];

const FEATURES = [
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
];

const INVOICES = [
  { date:"May 1, 2026",  desc:"SlugBase Personal · monthly",    amount:"$4.00",  status:"paid" },
  { date:"Apr 1, 2026",  desc:"SlugBase Personal · monthly",    amount:"$4.00",  status:"paid" },
  { date:"Mar 1, 2026",  desc:"SlugBase Personal · monthly",    amount:"$4.00",  status:"paid" },
  { date:"Feb 3, 2026",  desc:"SlugBase Free → Personal upgrade",amount:"$4.00", status:"paid" },
];

/* ---- Countdown hook ---- */
function useCountdown(target) {
  const [diff, setDiff] = useState(() => Math.max(0, target - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setDiff(Math.max(0, target - Date.now())), 1000);
    return () => clearInterval(t);
  }, [target]);
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return { d, h, m, s };
}

/* ---- Usage meter ---- */
function BMMeter({ used, cap, variant }) {
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const color = variant === "error" ? "var(--danger)" : variant === "warn" ? "var(--warning)" : "var(--accent)";
  return (
    <div className="bm-meter" style={{ flex:1 }}>
      <div className="bm-meter-label">
        <span className="used" style={{ fontFamily:"var(--font-mono)" }}><b style={{ color }}>{used}</b> / {cap} bookmarks</span>
        <span className="cap">{cap - used} remaining</span>
      </div>
      <div className="bm-meter-bar">
        <div className="bm-meter-fill" style={{ width: pct + "%", background: color }} />
      </div>
    </div>
  );
}

/* ---- Plan comparison table ---- */
function PlanTable({ current, onUpgrade, toast }) {
  const currentIdx = { free:0, personal:1, team:2 }[current] ?? 0;
  const cols = [
    { id:"free",     label:"Free",     price:"$0",    period:"/mo",        badge:"free" },
    { id:"personal", label:"Personal", price:"$4",    period:"/mo",        badge:"personal" },
    { id:"team",     label:"Team",     price:"$9",    period:"/seat/mo",   badge:"team" },
  ];
  return (
    <div className="plan-table">
      <div className="plan-table-head">
        <div className="plan-th"><span style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)",fontWeight:"var(--weight-medium)"}}>Features</span></div>
        {cols.map((c,i) => (
          <div key={c.id} className={"plan-th" + (i===currentIdx?" current":"")}>
            <span className={"plan-badge "+c.badge}>{i===currentIdx && <Icon name="check" size={10}/>}{c.label}</span>
            <span className="pt-price">{c.price}<span className="pt-period"> {c.period}</span></span>
          </div>
        ))}
      </div>
      {FEATURES.map(f => (
        <div key={f.label} className="plan-table-row">
          <div className="plan-td">{f.label}</div>
          {[f.free, f.personal, f.team].map((v,i) => (
            <div key={i} className={"plan-td"+(i===currentIdx?" current":"")}>
              {v==="✓" ? <span className="ok"><Icon name="check" size={15}/></span>
               : v==="—" ? <span className="no" style={{color:"var(--fg-faint)"}}>—</span>
               : <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-small)",color:"var(--fg-muted)"}}>{v}</span>}
            </div>
          ))}
        </div>
      ))}
      <div className="pt-cta-row">
        <div className="pt-cta-cell" />
        {cols.map((c,i) => (
          <div key={c.id} className={"pt-cta-cell"+(i===currentIdx?" current":"")}>
            {i===currentIdx
              ? <span style={{fontSize:"var(--text-small)",color:"var(--accent-text)",fontWeight:"var(--weight-medium)",display:"flex",alignItems:"center",gap:4}}><Icon name="check" size={13}/>Current plan</span>
              : i > currentIdx
                ? <button className={"btn btn--sm "+(i===2?"btn--primary":"btn--secondary")} onClick={()=>onUpgrade(c.id)}>Upgrade to {c.label}</button>
                : <button className="btn btn--ghost btn--sm" onClick={()=>onUpgrade(c.id)}>Downgrade</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Supporter offer ---- */
function SupporterCard({ toast }) {
  const target = new Date("2026-07-04T23:59:59Z").getTime();
  const { d, h, m, s } = useCountdown(target);
  return (
    <div className="supporter-card">
      <div className="supporter-eyebrow"><Icon name="zap" size={11}/>Early supporter offer</div>
      <div style={{display:"flex",alignItems:"flex-start",gap:"var(--sp-7)",flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:240}}>
          <div className="supporter-price">$59 <sub>one time · yours forever</sub></div>
          <p style={{margin:"var(--sp-4) 0 var(--sp-5)",fontSize:"var(--text-body-lg)",color:"var(--fg-muted)",lineHeight:1.55}}>
            Get everything in Personal — unlimited bookmarks, custom slugs, API access — permanently. No subscription, no renewals.
          </p>
          <button className="btn btn--primary" onClick={()=>toast({icon:"zap",title:"Redirecting to checkout…"})}><Icon name="zap" size={15}/>Claim lifetime access — $59</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-3)"}}>
          <div style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)",fontWeight:"var(--weight-medium)"}}>Offer ends in</div>
          <div className="countdown">
            {[[d,"days"],[h,"hrs"],[m,"min"],[s,"sec"]].map(([n,lbl],i,arr)=>(
              <React.Fragment key={lbl}>
                <div className="countdown-unit"><span className="countdown-n">{String(n).padStart(2,"0")}</span><span className="countdown-label">{lbl}</span></div>
                {i<arr.length-1 && <span className="countdown-sep">:</span>}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Plan sub-section ---- */
function PlanSection({ billingState, setBillingState, onArchivedCount, toast }) {
  const [showCancel, setShowCancel] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);

  useEffect(() => { onArchivedCount(billingState === "post-downgrade" ? 12 : 0); }, [billingState]);

  const isFree       = billingState.startsWith("free");
  const isPersonal   = billingState.startsWith("personal");
  const isTeam       = billingState === "team";
  const isCancelled  = billingState === "cancelled";
  const isPostDown   = billingState === "post-downgrade";
  const usedBM       = billingState === "free-under" ? 23 : billingState === "free-approaching" ? 47 : isPostDown ? 38 : 50;
  const capBM        = 50;
  const meterVariant = billingState === "free-approaching" ? "warn" : billingState === "free-at-cap" ? "error" : isPostDown ? "warn" : "ok";
  const currentPlan  = isFree || isPostDown ? "free" : isPersonal ? "personal" : isTeam ? "team" : "personal";

  const doCancel = () => { setCancelConfirm(false); setShowCancel(false); setBillingState("cancelled"); toast({ icon:"check", title:"Subscription cancelled", sub:"Access continues until Jun 30, 2026" }); };
  const reactivate = () => { setBillingState("personal-monthly"); toast({ icon:"check", title:"Subscription reactivated" }); };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-8)"}}>
      {/* Archived bookmarks banner — post-downgrade */}
      {isPostDown && (
        <div className="archived-banner">
          <Icon name="archive" size={20}/>
          <div className="archived-banner-body">
            <div className="archived-banner-title">12 bookmarks are currently archived</div>
            <div className="archived-banner-desc">
              After downgrading, your workspace exceeded the 50-bookmark Free cap. Archived bookmarks are preserved in full — they are not deleted. They restore automatically when you upgrade. New bookmark creation is paused until you are under the cap or upgrade.
            </div>
            <button className="btn btn--primary btn--sm" style={{marginTop:"var(--sp-5)"}} onClick={()=>toast({icon:"zap",title:"Upgrade to Personal"})}><Icon name="zap" size={14}/>Upgrade to Personal — $4/mo</button>
          </div>
        </div>
      )}

      {/* Current plan card */}
      <div className={"plan-card"+(meterVariant==="warn"?" warn":meterVariant==="error"?" error":"")}>
        <div style={{flex:1}}>
          {isFree || isPostDown ? (<>
            <span className="plan-badge free">Free plan</span>
            <div className="plan-name">Free</div>
            <div className="plan-price"><b>$0</b> forever</div>
          </>) : isPersonal ? (<>
            <span className="plan-badge personal"><Icon name="check" size={10}/>Personal</span>
            <div className="plan-name">Personal</div>
            <div className="plan-price"><b>$4.00</b> /{billingState==="personal-yearly"?"yr (billed annually)":"mo"} · Next renewal <b style={{fontFamily:"var(--font-mono)"}}>Jun 1, 2026</b></div>
            {billingState==="personal-monthly" && <div style={{marginTop:"var(--sp-3)",fontSize:"var(--text-small)",color:"var(--success-text)"}}><Icon name="trending-down" size={13} style={{verticalAlign:"-2px"}}/> Switch to yearly and save <b>$8/yr</b></div>}
          </>) : isTeam ? (<>
            <span className="plan-badge team"><Icon name="check" size={10}/>Team</span>
            <div className="plan-name">Team</div>
            <div className="plan-price"><b>$54.00</b> /mo (6 seats) · Renews <b style={{fontFamily:"var(--font-mono)"}}>Jun 1, 2026</b></div>
          </>) : isCancelled ? (<>
            <span className="plan-badge cancelled"><Icon name="clock" size={10}/>Cancelled</span>
            <div className="plan-name">Personal</div>
            <div className="plan-price">Access ends <b style={{fontFamily:"var(--font-mono)"}}>Jun 30, 2026</b> · Will return to Free</div>
          </>) : null}
        </div>
        {(isFree||isPostDown) && <BMMeter used={usedBM} cap={capBM} variant={meterVariant} />}
      </div>

      {/* Cancelled state */}
      {isCancelled && (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",padding:"var(--sp-6)",display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <WarnBox icon="clock">
            Your Personal plan is cancelled. You still have full access until <b>June 30, 2026</b>. After that, your workspace returns to Free. If you have more than 50 bookmarks, excess bookmarks will be <b>archived</b> (not deleted) and restored automatically if you re-subscribe.
          </WarnBox>
          <div style={{fontSize:"var(--text-body)",color:"var(--fg-muted)"}}>Bookmarks at cancellation: <b style={{fontFamily:"var(--font-mono)",color:"var(--fg)"}}>62</b> — <b style={{color:"var(--warning-text)"}}>12 will be archived</b> at period end if not upgraded.</div>
          <div style={{display:"flex",gap:"var(--sp-4)"}}>
            <button className="btn btn--primary btn--sm" onClick={reactivate}><Icon name="refresh-cw" size={14}/>Reactivate subscription</button>
            <button className="btn btn--ghost btn--sm" onClick={()=>setBillingState("post-downgrade")}>Preview post-downgrade state →</button>
          </div>
        </div>
      )}

      {/* Upgrade nudge — approaching cap */}
      {billingState==="free-approaching" && (
        <InfoBox icon="alert-triangle">
          You've used <b>{usedBM}</b> of your <b>{capBM}</b> bookmark limit. Upgrade to Personal for unlimited bookmarks — your current bookmarks and slugs are not affected.
        </InfoBox>
      )}
      {billingState==="free-at-cap" && (
        <div className="warn-box">
          <Icon name="ban" size={15}/>
          <div><b>New bookmarks are blocked.</b> You've reached the 50-bookmark Free limit. Upgrade to save more — your existing bookmarks and slugs remain unchanged.</div>
        </div>
      )}

      {/* Monthly → yearly upsell (Personal) */}
      {billingState==="personal-monthly" && (
        <div style={{display:"flex",alignItems:"center",gap:"var(--sp-5)",padding:"var(--sp-5) var(--sp-6)",background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)"}}>
          <Icon name="calendar" size={18} style={{color:"var(--success-text)",flexShrink:0}}/>
          <div style={{flex:1}}>
            <div style={{fontWeight:"var(--weight-semi)",color:"var(--fg)"}}>Switch to yearly billing</div>
            <div style={{fontSize:"var(--text-small)",color:"var(--fg-muted)"}}>$40/yr instead of $48/yr — save $8 (2 months free)</div>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={()=>{setBillingState("personal-yearly");toast({icon:"calendar",title:"Switched to yearly billing"});}}>Switch to yearly</button>
        </div>
      )}

      {/* Cancel flow (Personal / Team) */}
      {(isPersonal||isTeam) && !showCancel && (
        <div style={{display:"flex",gap:"var(--sp-4)",flexWrap:"wrap"}}>
          {isPersonal && <button className="btn btn--secondary btn--sm" onClick={()=>toast({icon:"zap",title:"Upgrading to Team"})}><Icon name="users" size={14}/>Upgrade to Team</button>}
          {isTeam && <button className="btn btn--ghost btn--sm" onClick={()=>toast({icon:"arrow-down",title:"Downgrade to Personal"})}><Icon name="arrow-down" size={14}/>Downgrade to Personal</button>}
          <button className="btn btn--ghost btn--sm" style={{color:"var(--danger-text)"}} onClick={()=>setShowCancel(true)}><Icon name="x-circle" size={14}/>Cancel subscription</button>
        </div>
      )}
      {(isPersonal||isTeam) && showCancel && (
        <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",padding:"var(--sp-6)",display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <div style={{fontWeight:"var(--weight-semi)",color:"var(--fg)"}}>Cancel your subscription?</div>
          <div style={{fontSize:"var(--text-body)",color:"var(--fg-muted)",lineHeight:1.55}}>
            Your plan stays active until the end of the current billing period (<b>June 30, 2026</b>). After that, your workspace returns to the Free plan. Bookmarks over the 50-bookmark cap will be <b>archived</b> — not deleted — and restored automatically if you re-subscribe.
          </div>
          {!cancelConfirm
            ? <div style={{display:"flex",gap:"var(--sp-4)"}}><button className="btn btn--danger btn--sm" onClick={()=>setCancelConfirm(true)}>Yes, cancel subscription</button><button className="btn btn--ghost btn--sm" onClick={()=>setShowCancel(false)}>Keep subscription</button></div>
            : <div style={{display:"flex",gap:"var(--sp-4)"}}><button className="btn btn--danger btn--sm" onClick={doCancel}><Icon name="check" size={14}/>Confirm cancellation</button><button className="btn btn--ghost btn--sm" onClick={()=>setCancelConfirm(false)}>Go back</button></div>}
        </div>
      )}

      {/* Plan comparison table */}
      <SS title="Compare plans" description="All plans include forwarding slugs, dark mode, and keyboard-driven navigation.">
        <PlanTable current={currentPlan} onUpgrade={(p)=>toast({icon:"zap",title:`Upgrading to ${p}`})} toast={toast} />
      </SS>

      {/* Supporter / lifetime offer (Free states only) */}
      {(isFree||isPostDown) && <SS title="Early supporter offer" description="A one-time, time-limited offer for users who want to support SlugBase."><SupporterCard toast={toast} /></SS>}
    </div>
  );
}

/* ---- Seats sub-section ---- */
function SeatsSection({ billingState, toast }) {
  const INCLUDED = 5; const EXTRA = 2; const TOTAL = INCLUDED + EXTRA; const MEMBERS = 4;
  const [extra, setExtra] = useState(EXTRA);
  const [adding, setAdding] = useState(0);
  const pricePerSeat = 9;
  const newTotal = INCLUDED + extra + adding;
  const prorated = Math.round(adding * pricePerSeat * 17/30 * 100) / 100; // 17 days left in period

  if (!billingState.startsWith("team")) {
    return (
      <div className="settings-inner">
        <InfoBox icon="users">Seat management is available on the <b>Team plan</b>. <a style={{color:"var(--accent-text)",cursor:"pointer"}}>Upgrade to Team →</a></InfoBox>
      </div>
    );
  }
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-7)"}}>
      <div className="seat-breakdown">
        <div className="seat-tile"><div className="seat-tile-n">{INCLUDED}</div><div className="seat-tile-label">Included seats (base plan)</div></div>
        <div className="seat-tile"><div className="seat-tile-n">{extra}</div><div className="seat-tile-label">Purchased extra seats</div></div>
        <div className="seat-tile" style={{borderColor:"var(--accent-border)",background:"var(--accent-subtle)"}}><div className="seat-tile-n" style={{color:"var(--accent-text)"}}>{TOTAL}</div><div className="seat-tile-label">Total seats</div></div>
        <div className="seat-tile"><div className="seat-tile-n">{MEMBERS}</div><div className="seat-tile-label">Seats in use</div></div>
      </div>
      <SS title="Add seats" description="Extra seats are billed at $9/seat/month, prorated for the current period.">
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <FG label="Seats to add">
            <div style={{display:"flex",alignItems:"center",gap:"var(--sp-4)"}}>
              <button className="btn btn--secondary btn--sm" onClick={()=>setAdding(a=>Math.max(0,a-1))}>−</button>
              <input className="seat-input" type="number" min={0} value={adding} onChange={e=>setAdding(Math.max(0,+e.target.value||0))} />
              <button className="btn btn--secondary btn--sm" onClick={()=>setAdding(a=>a+1)}>+</button>
              <span style={{fontSize:"var(--text-body)",color:"var(--fg-muted)"}}>{adding > 0 ? `→ ${newTotal} total seats` : "no change"}</span>
            </div>
          </FG>
          {adding > 0 && (
            <div className="proration-note">
              <Icon name="info" size={14}/>
              <div><b style={{color:"var(--fg)"}}>Prorated charge: ${prorated.toFixed(2)}</b> today for {adding} seat{adding>1?"s":""} for the remaining 17 days of this billing period. Then <b style={{color:"var(--fg)"}}>${(adding*pricePerSeat).toFixed(2)}/mo</b> added to your invoice going forward.</div>
            </div>
          )}
          <div><button className="btn btn--primary btn--sm" disabled={adding===0} style={adding===0?{opacity:.4,cursor:"not-allowed"}:undefined} onClick={()=>{setExtra(e=>e+adding);setAdding(0);toast({icon:"users",title:`${adding} seat${adding>1?"s":""} added`});}}><Icon name="plus" size={14}/>Confirm — {adding>0?`$${prorated.toFixed(2)} today`:"select seats above"}</button></div>
        </div>
      </SS>
      <SS title="Remove seats" description={`Seats cannot be reduced below the number of current members (${MEMBERS}).`}>
        <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
          <FG label="Total seats after removal">
            <div style={{display:"flex",alignItems:"center",gap:"var(--sp-4)"}}>
              <button className="btn btn--secondary btn--sm" disabled={TOTAL<=MEMBERS} onClick={()=>setExtra(e=>Math.max(0,e-1))} style={TOTAL<=MEMBERS?{opacity:.4,cursor:"not-allowed"}:undefined}>−</button>
              <input className="seat-input" type="number" min={MEMBERS} value={TOTAL} readOnly />
              <button className="btn btn--secondary btn--sm" onClick={()=>setExtra(e=>e+1)}>+</button>
            </div>
          </FG>
          {TOTAL<=MEMBERS && (
            <InfoBox icon="users">You cannot reduce seats below the current member count ({MEMBERS}). Remove members first, then reduce seats.</InfoBox>
          )}
        </div>
      </SS>
    </div>
  );
}

/* ---- Billing history sub-section ---- */
function BillingHistorySection({ billingState, toast }) {
  const isFree = billingState.startsWith("free") || billingState === "post-downgrade";
  return (
    <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-8)"}}>
      <SS title="Payment method" description="Managed via the external billing portal. Contact billing@slugbase.app for issues.">
        {isFree ? (
          <div style={{color:"var(--fg-subtle)",fontSize:"var(--text-body)"}}>No payment method on file. Add one when you upgrade.</div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:"var(--sp-5)"}}>
            <div className="payment-card">
              <div className="card-art">VISA</div>
              <div><div className="card-last4">•••• •••• •••• 4242</div><div className="card-expiry">Expires 08 / 27</div></div>
              <div style={{marginLeft:"auto"}}>
                <button className="btn btn--ghost btn--sm" onClick={()=>toast({icon:"external-link",title:"Opening billing portal…"})}><Icon name="external-link" size={14}/>Update card</button>
              </div>
            </div>
            <div style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)",display:"flex",gap:"var(--sp-3)",alignItems:"center"}}><Icon name="lock" size={12}/>Card details are managed securely via Stripe. SlugBase does not store card numbers.</div>
          </div>
        )}
      </SS>
      <SS title="Invoices" description="Past payments. Download individual invoices as PDF.">
        {isFree ? (
          <div style={{textAlign:"center",padding:"var(--sp-8)",color:"var(--fg-subtle)"}}>
            <Icon name="receipt" size={28} strokeWidth={1.25} style={{color:"var(--fg-faint)",display:"block",margin:"0 auto var(--sp-4)"}}/>
            <p style={{margin:0}}>No invoices yet. They'll appear here when you subscribe.</p>
          </div>
        ) : (
          <div style={{background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",overflow:"hidden",padding:"0 var(--sp-6)"}}>
            {INVOICES.map((inv,i)=>(
              <div key={i} className="invoice-row">
                <span className="invoice-date">{inv.date}</span>
                <span className="invoice-desc">{inv.desc}</span>
                <span className="invoice-amount">{inv.amount}</span>
                <span className="invoice-status"><span className="status-badge active"><Icon name="check" size={10}/>{inv.status}</span></span>
                <button className="btn btn--ghost btn--sm" onClick={()=>toast({icon:"download",title:"Downloading invoice"})}><Icon name="download" size={13}/></button>
              </div>
            ))}
          </div>
        )}
      </SS>
      <div style={{padding:"var(--sp-5) var(--sp-6)",background:"var(--raised)",border:"1px solid var(--border-subtle)",borderRadius:"var(--r-lg)",display:"flex",alignItems:"center",gap:"var(--sp-5)"}}>
        <Icon name="external-link" size={16} style={{color:"var(--fg-subtle)",flexShrink:0}}/>
        <div style={{flex:1}}>
          <div style={{fontWeight:"var(--weight-medium)",color:"var(--fg)"}}>Billing portal</div>
          <div style={{fontSize:"var(--text-small)",color:"var(--fg-subtle)"}}>Manage your subscription, update payment details, and download receipts via the Stripe Customer Portal. Opens in a new tab.</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={()=>toast({icon:"external-link",title:"Opening Stripe Customer Portal…"})}><Icon name="external-link" size={14}/>Manage billing</button>
      </div>
    </div>
  );
}

/* ---- Root export ---- */
function BillingPage({ subSection, onArchivedCount, toast }) {
  const [billingState, setBillingState] = useState("free-under");

  return (
    <div className="settings-inner" style={{maxWidth:680}}>
      {/* Prototype dev strip */}
      <div className="dev-strip" style={{borderRadius:"var(--r-md)",marginBottom:"var(--sp-4)"}}>
        <strong>Billing state:</strong>
        <select value={billingState} onChange={e=>setBillingState(e.target.value)}>
          {BILLING_STATES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <span style={{color:"var(--fg-faint)",fontSize:"var(--text-micro)"}}>— hosted-only; absent on self-hosted</span>
      </div>

      {(!subSection || subSection==="billing-plan")    && <PlanSection    billingState={billingState} setBillingState={setBillingState} onArchivedCount={onArchivedCount} toast={toast} />}
      {subSection==="billing-seats"                    && <SeatsSection   billingState={billingState} toast={toast} />}
      {subSection==="billing-history"                  && <BillingHistorySection billingState={billingState} toast={toast} />}
    </div>
  );
}

Object.assign(window, { BillingPage });
