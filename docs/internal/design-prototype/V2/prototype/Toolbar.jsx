/* SlugBase — Toolbar: filters, sort, view toggle */

function Dropdown({ trigger, children, width = 220, align = "left" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      {trigger(open, () => setOpen(o => !o))}
      {open && (
        <div className="menu" style={{ [align]: 0, top: "calc(100% + 6px)", minWidth: width }}
          onClick={(e) => e.stopPropagation()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const SORTS = [
  { id: "recent", label: "Recently added", icon: "clock" },
  { id: "alpha", label: "Alphabetical", icon: "arrow-down-a-z" },
  { id: "used", label: "Most used", icon: "flame" },
  { id: "accessed", label: "Recently accessed", icon: "history" },
];
const SCOPES = [
  { id: "all", label: "All bookmarks", icon: "layers" },
  { id: "mine", label: "Only me", icon: "user" },
  { id: "shared-with-me", label: "Shared with me", icon: "users" },
  { id: "shared-by-me", label: "Shared by me", icon: "share-2" },
];

function Toolbar({ f, set, view, setView, folders, allTags, resultCount, onClear }) {
  const sort = SORTS.find(s => s.id === f.sort);
  const scope = SCOPES.find(s => s.id === f.scope);
  const activeFolder = folders.find(x => x.id === f.folder);
  const hasFilters = f.folder || f.tags.length || f.pinnedOnly || f.scope !== "all" || f.q;

  const toggleTag = (t) => {
    const next = new Set(f.tags);
    next.has(t) ? next.delete(t) : next.add(t);
    set({ tags: [...next] });
  };

  return (
    <div className="toolbar">
      {/* Folder filter */}
      <Dropdown width={210} trigger={(open, t) => (
        <button className={"chip" + (f.folder ? " on" : "")} onClick={t}>
          {activeFolder
            ? <><span className="folder-dot" style={{ background: activeFolder.color }} />{activeFolder.name}</>
            : <><Icon name="folder" size={14} />Folder</>}
          <Icon name="chevron-down" size={13} className="ic-r" />
        </button>
      )}>
        {(close) => (<>
          <div className="menu-head">Filter by folder</div>
          <MenuItem icon="layers" check={!f.folder} onClick={() => { set({ folder: null }); close(); }}>All folders</MenuItem>
          {folders.map(fo => (
            <div key={fo.id} className="menu-item" onClick={() => { set({ folder: fo.id }); close(); }}>
              <span className="folder-dot" style={{ background: fo.color }} />
              <span style={{ flex: 1 }}>{fo.name}</span>
              <span style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{fo.count}</span>
              {f.folder === fo.id && <Icon name="check" size={14} className="check" style={{ marginLeft: 6 }} />}
            </div>
          ))}
        </>)}
      </Dropdown>

      {/* Tags multi-select */}
      <Dropdown width={200} trigger={(open, t) => (
        <button className={"chip" + (f.tags.length ? " on" : "")} onClick={t}>
          <Icon name="hash" size={14} />
          {f.tags.length ? `${f.tags.length} tag${f.tags.length > 1 ? "s" : ""}` : "Tags"}
          <Icon name="chevron-down" size={13} className="ic-r" />
        </button>
      )}>
        {() => (<>
          <div className="menu-head">Filter by tags</div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {allTags.map(t => (
              <div key={t} className="menu-item" onClick={() => toggleTag(t)}>
                <Check on={f.tags.includes(t)} onChange={() => toggleTag(t)} />
                <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}>#{t}</span>
              </div>
            ))}
          </div>
        </>)}
      </Dropdown>

      {/* Pinned toggle */}
      <button className={"chip" + (f.pinnedOnly ? " on" : "")} onClick={() => set({ pinnedOnly: !f.pinnedOnly })}>
        <Icon name="pin" size={14} />Pinned
      </button>

      {/* Scope */}
      <Dropdown width={210} trigger={(open, t) => (
        <button className={"chip" + (f.scope !== "all" ? " on" : "")} onClick={t}>
          <Icon name={scope.icon} size={14} />{scope.label}
          <Icon name="chevron-down" size={13} className="ic-r" />
        </button>
      )}>
        {(close) => (<>
          <div className="menu-head">Sharing scope</div>
          {SCOPES.map(s => (
            <MenuItem key={s.id} icon={s.icon} check={f.scope === s.id}
              onClick={() => { set({ scope: s.id }); close(); }}>{s.label}</MenuItem>
          ))}
        </>)}
      </Dropdown>

      {hasFilters && (
        <button className="chip" onClick={onClear} style={{ color: "var(--danger-text)" }}>
          <Icon name="x" size={13} />Clear
        </button>
      )}

      <div className="toolbar-spacer" />

      <span className="pager-info" style={{ marginRight: 4 }}>
        <b>{resultCount}</b> result{resultCount !== 1 ? "s" : ""}
      </span>

      {/* Sort */}
      <Dropdown width={210} align="right" trigger={(open, t) => (
        <button className="chip" onClick={t}>
          <Icon name="arrow-up-down" size={14} />{sort.label}
          <Icon name="chevron-down" size={13} className="ic-r" />
        </button>
      )}>
        {(close) => (<>
          <div className="menu-head">Sort by</div>
          {SORTS.map(s => (
            <MenuItem key={s.id} icon={s.icon} check={f.sort === s.id}
              onClick={() => { set({ sort: s.id }); close(); }}>{s.label}</MenuItem>
          ))}
        </>)}
      </Dropdown>

      <div className="chip-divider" />

      {/* View toggle */}
      <div className="seg" role="tablist" aria-label="View mode">
        <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} title="Card grid">
          <Icon name="layout-grid" size={15} />
        </button>
        <button className={view === "table" ? "on" : ""} onClick={() => setView("table")} title="Table">
          <Icon name="rows-3" size={15} />
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { Toolbar, SORTS, SCOPES, Dropdown });
