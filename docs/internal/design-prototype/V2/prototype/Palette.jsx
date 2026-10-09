/* SlugBase — Command palette (full overlay), bulk bar, pager, toasts */

function CommandPalette({ onClose, bookmarks, onAction }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const commands = [
    { id: "new", group: "Actions", icon: "plus", title: "New bookmark", hint: "C" },
    { id: "newslug", group: "Actions", icon: "link", title: "Create forwarding slug", hint: "S" },
    { id: "import", group: "Actions", icon: "download", title: "Import bookmarks" },
    { id: "grid", group: "View", icon: "layout-grid", title: "Switch to card grid", hint: "G" },
    { id: "table", group: "View", icon: "rows-3", title: "Switch to table view", hint: "T" },
    { id: "pinned", group: "View", icon: "pin", title: "Show only pinned" },
    { id: "settings", group: "Go to", icon: "settings", title: "Open settings" },
    { id: "members", group: "Go to", icon: "users-round", title: "Manage members" },
  ];

  const ql = q.trim().toLowerCase();
  const hits = ql
    ? bookmarks.filter(b => b.title.toLowerCase().includes(ql) || (b.slug || "").includes(ql) || b.url.toLowerCase().includes(ql)).slice(0, 6)
    : [];
  const cmds = commands.filter(c => !ql || c.title.toLowerCase().includes(ql));

  const flat = [
    ...hits.map(h => ({ type: "bm", data: h })),
    ...cmds.map(c => ({ type: "cmd", data: c })),
  ];

  useEffect(() => {
    function k(e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = flat[active]; if (it) { onAction(it); onClose(); } }
    }
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [flat, active]);

  let idx = -1;
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input ref={inputRef} value={q} placeholder="Search bookmarks or type a command…"
            onChange={(e) => { setQ(e.target.value); setActive(0); }} />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list">
          {flat.length === 0 && (
            <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
              No matches for “{q}”
            </div>
          )}
          {hits.length > 0 && <div className="pal-group-label">Bookmarks</div>}
          {hits.map(h => { idx++; const i = idx; return (
            <div key={"b" + h.id} className={"pal-item" + (active === i ? " active" : "")}
              onMouseEnter={() => setActive(i)} onClick={() => { onAction({ type: "bm", data: h }); onClose(); }}>
              <Favicon b={h} size={22} />
              <span className="pal-title">{h.title}</span>
              {h.slug && <span className="pal-hint">{SB.FWD}/{h.slug}</span>}
              <Icon name="corner-down-left" size={14} />
            </div>
          ); })}
          {cmds.length > 0 && <div className="pal-group-label">Commands</div>}
          {cmds.map(c => { idx++; const i = idx; return (
            <div key={c.id} className={"pal-item" + (active === i ? " active" : "")}
              onMouseEnter={() => setActive(i)} onClick={() => { onAction({ type: "cmd", data: c }); onClose(); }}>
              <Icon name={c.icon} size={16} />
              <span className="pal-title">{c.title}</span>
              {c.hint && <Kbd>{c.hint}</Kbd>}
            </div>
          ); })}
        </div>
        <div className="palette-foot">
          <span className="fk"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="fk"><Kbd>↵</Kbd> select</span>
          <span className="fk"><Kbd>esc</Kbd> close</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <img src="../assets/slugbase_icon.svg" width="14" height="14" alt="" /> SlugBase
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---- Bulk action bar ---- */
function BulkBar({ count, total, allSelected, onSelectAll, onClear, onAct }) {
  return (
    <div className="bulkbar">
      <span className="bulk-count"><Check on={true} onChange={onClear} /> <b>{count}</b> selected</span>
      {!allSelected && (
        <span className="bulk-all" onClick={onSelectAll}>Select all {total}</span>
      )}
      <div className="bulk-sep" />
      <button className="btn btn--ghost btn--sm" onClick={() => onAct("move")}><Icon name="folder-input" size={15} />Move</button>
      <button className="btn btn--ghost btn--sm" onClick={() => onAct("tag")}><Icon name="hash" size={15} />Tag</button>
      <button className="btn btn--ghost btn--sm" onClick={() => onAct("pin")}><Icon name="pin" size={15} />Pin</button>
      <button className="btn btn--ghost btn--sm" onClick={() => onAct("share")}><Icon name="share-2" size={15} />Share</button>
      <div className="bulk-sep" />
      <button className="btn btn--ghost btn--sm" style={{ color: "var(--danger-text)" }} onClick={() => onAct("delete")}>
        <Icon name="trash-2" size={15} />Delete
      </button>
      <button className="icon-btn icon-btn--sm" onClick={onClear} title="Clear selection"><Icon name="x" size={16} /></button>
    </div>
  );
}

/* ---- Pager ---- */
function Pager({ page, pages, pageSize, total, start, end, setPage, setPageSize }) {
  return (
    <div className="pager">
      <span className="pager-info">Showing <b>{start}</b>–<b>{end}</b> of <b>{total}</b></span>
      <div className="pager-right">
        <div className="psize">
          Rows
          <select className="select" value={pageSize} onChange={(e) => setPageSize(+e.target.value)}>
            {[12, 24, 48].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="pager-nav">
          <button className="pg" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevron-left" size={15} /></button>
          {Array.from({ length: pages }).map((_, i) => (
            <button key={i} className={"pg" + (i === page ? " on" : "")} onClick={() => setPage(i)}>{i + 1}</button>
          ))}
          <button className="pg" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><Icon name="chevron-right" size={15} /></button>
        </div>
      </div>
    </div>
  );
}

/* ---- Toasts ---- */
function Toasts({ items, onDismiss }) {
  useEffect(() => {
    const timers = items.map(t => setTimeout(() => onDismiss(t.id), 3200));
    return () => timers.forEach(clearTimeout);
  }, [items]);
  return (
    <div className="toasts">
      {items.map(t => (
        <div className="toast" key={t.id}>
          <span className={"toast-ic " + (t.kind || "ok")}><Icon name={t.icon || "check"} size={15} strokeWidth={2.25} /></span>
          <span className="toast-txt">{t.title}{t.sub && <span>{t.sub}</span>}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { CommandPalette, BulkBar, Pager, Toasts });
