/* SlugBase — Bookmark views: card grid + table rows, skeleton, empty */

function SlugLine({ b }) {
  if (!b.slug) return <span className="slug-empty"><Icon name="link-2-off" size={13} />No slug</span>;
  return (
    <span className="slug-line" title={`${SB.FWD}/${b.slug}`}>
      <Icon name="link" size={12} />
      <span className="addr">{SB.FWD}/{b.slug}</span>
    </span>
  );
}

function PinButton({ on, onClick }) {
  return (
    <span className={"pin-btn" + (on ? " on" : "")} onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={on ? "Unpin" : "Pin"}>
      <Icon name="pin" size={15} strokeWidth={on ? 2 : 1.75} style={on ? { fill: "currentColor" } : {}} />
    </span>
  );
}

function BookmarkCard({ b, selected, onSelect, onPin }) {
  return (
    <div className={"card" + (selected ? " sel" : "") + (b.pinned ? " pinned" : "")}
      onClick={() => onSelect(!selected)}>
      <div className="card-cb"><Check on={selected} onChange={onSelect} /></div>
      <div className="card-top">
        <Favicon b={b} size={32} />
        <div style={{ minWidth: 0, flex: 1, paddingRight: 18 }}>
          <div className="card-title">{b.title}</div>
        </div>
      </div>
      <div className="card-url"><Icon name="globe" size={12} style={{ opacity: .6, flex: "none" }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.url}</span></div>
      <SlugLine b={b} />
      <div className="card-meta">
        <span className="row-folder">
          <span className="folder-dot" style={{ background: SB.folderById(b.folder).color }} />
          {SB.folderById(b.folder).name}
        </span>
        <div className="card-tags">{b.tags.slice(0, 2).map(t => <Tag key={t}>{t}</Tag>)}</div>
        <span className="meta-time"><Icon name="clock" size={11} />{b.last}</span>
        <ScopeIcon scope={b.scope} />
        <PinButton on={b.pinned} onClick={onPin} />
      </div>
    </div>
  );
}

function BookmarkRow({ b, selected, onSelect, onPin, sort }) {
  return (
    <div className={"trow" + (selected ? " sel" : "")} onClick={() => onSelect(!selected)}>
      <Check on={selected} onChange={onSelect} />
      <div className="tr-title">
        <Favicon b={b} size={26} />
        <div className="tt">
          <div className="tr-name">
            {b.pinned && <Icon name="pin" size={12} style={{ color: "var(--accent-text)", fill: "currentColor" }} />}
            {b.title}
          </div>
          <div className="tr-url">{b.url}</div>
        </div>
      </div>
      <div>{b.slug
        ? <span className="slug-line" style={{ maxWidth: "100%" }}><Icon name="link" size={11} /><span className="addr">{SB.FWD}/{b.slug}</span></span>
        : <span className="slug-empty" style={{ fontSize: 12 }}>—</span>}</div>
      <div className="tr-cell">
        <span className="row-folder">
          <span className="folder-dot" style={{ background: SB.folderById(b.folder).color }} />
          {SB.folderById(b.folder).name}
        </span>
      </div>
      <div className="tr-tags">{b.tags.slice(0, 2).map(t => <Tag key={t}>{t}</Tag>)}</div>
      <div className="tr-time">
        {sort === "used"
          ? <span className="tr-hits"><Icon name="flame" size={12} style={{ color: "var(--warning-text)" }} />{b.hits}</span>
          : <span>{b.last} ago</span>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
        <ScopeIcon scope={b.scope} />
        <PinButton on={b.pinned} onClick={onPin} />
      </div>
    </div>
  );
}

function TableHead({ sort, setSort, allSel, someSel, onToggleAll }) {
  const col = (id, label, sortable) => (
    <div className={sortable && sort === id ? "sorted" : ""}
      onClick={() => sortable && setSort(id)}>
      {label}
      {sortable && sort === id && <Icon name="arrow-down" size={12} />}
    </div>
  );
  return (
    <div className="thead">
      <Check on={allSel} mixed={someSel && !allSel} onChange={onToggleAll} />
      {col("alpha", "Bookmark", true)}
      <div>Slug</div>
      <div>Folder</div>
      <div>Tags</div>
      {col(sort === "used" ? "used" : "accessed", sort === "used" ? "Uses" : "Accessed", true)}
      <div />
    </div>
  );
}

/* ---- Skeleton ---- */
function SkeletonGrid() {
  return (
    <div className="grid">
      {Array.from({ length: 9 }).map((_, i) => (
        <div className="sk-card" key={i}>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="sk" style={{ width: 32, height: 32, borderRadius: 6 }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
              <div className="sk" style={{ width: "85%", height: 12 }} />
              <div className="sk" style={{ width: "55%", height: 10 }} />
            </div>
          </div>
          <div className="sk" style={{ width: "70%", height: 10 }} />
          <div className="sk" style={{ width: 120, height: 22, borderRadius: 4 }} />
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <div className="sk" style={{ width: 70, height: 10 }} />
            <div className="sk" style={{ width: 40, height: 16, borderRadius: 4, marginLeft: "auto" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Empty state ---- */
function EmptyState({ filtered, onClear, onNew }) {
  return (
    <div className="empty">
      <div className="empty-art"><img src="../assets/slugbase_icon.svg" alt="" /></div>
      {filtered ? (<>
        <h3>No bookmarks match these filters</h3>
        <p>Try removing a tag or folder filter, or widen the sharing scope to see more.</p>
        <div className="empty-actions">
          <button className="btn btn--secondary" onClick={onClear}><Icon name="filter-x" size={15} />Clear filters</button>
        </div>
      </>) : (<>
        <h3>No bookmarks yet</h3>
        <p>Save your first link and give it a short slug to start forwarding. Press <Kbd>C</Kbd> anywhere to add one.</p>
        <div className="empty-actions">
          <button className="btn btn--primary" onClick={onNew}><Icon name="plus" size={15} />New bookmark</button>
          <button className="btn btn--ghost"><Icon name="download" size={15} />Import from browser</button>
        </div>
      </>)}
    </div>
  );
}

Object.assign(window, { BookmarkCard, BookmarkRow, TableHead, SlugLine, PinButton, SkeletonGrid, EmptyState });
