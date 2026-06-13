/* SlugBase — Bookmark create / edit modal */

function BookmarkModal({ mode, bookmark, onSave, onDelete, onClose }) {
  const isEdit = mode === "edit";

  const [url,        setUrl]        = useState(isEdit ? ("https://" + bookmark.url) : "");
  const [title,      setTitle]      = useState(bookmark?.title || "");
  const [slug,       setSlug]       = useState(bookmark?.slug || "");
  const [folder,     setFolder]     = useState(bookmark?.folder || SB.folders[0].id);
  const [tags,       setTags]       = useState(bookmark?.tags ? [...bookmark.tags] : []);
  const [scope,      setScope]      = useState(bookmark?.scope || "mine");
  const [pinned,     setPinned]     = useState(bookmark?.pinned || false);

  const [fetching,   setFetching]   = useState(false);
  const [urlError,   setUrlError]   = useState("");
  const [slugError,  setSlugError]  = useState("");
  const [tagInput,   setTagInput]   = useState("");
  const [tagFocus,   setTagFocus]   = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);

  const urlRef    = useRef(null);
  const titleRef  = useRef(null);
  const slugRef   = useRef(null);
  const tagRef    = useRef(null);
  const folderRef = useRef(null);

  /* auto-focus */
  useEffect(() => {
    if (!isEdit) setTimeout(() => urlRef.current?.focus(), 50);
    else         setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  /* close folder dropdown on outside click */
  useClickOutside(folderRef, () => setFolderOpen(false), folderOpen);

  /* ── URL metadata simulation ── */
  const handleUrlBlur = () => {
    if (!url || isEdit || title) return;
    const normalized = url.match(/^https?:\/\//) ? url : "https://" + url;
    try { new URL(normalized); } catch { return; }
    setFetching(true);
    setTimeout(() => {
      let host = normalized, path = "";
      try {
        const u = new URL(normalized);
        host = u.hostname.replace(/^www\./, "");
        path = u.pathname.split("/").filter(Boolean).pop() || "";
      } catch { /* noop */ }
      const derived = path
        ? path.replace(/[-_.]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        : host;
      setTitle(derived);
      if (!slug) {
        const suggested = host
          .replace(/\.(com|net|org|io|dev|app|ai|co)$/, "")
          .replace(/\./g, "-")
          .toLowerCase()
          .slice(0, 22);
        setSlug(suggested);
      }
      setFetching(false);
    }, 720);
  };

  /* ── Slug helpers ── */
  const validateSlug = (v) => {
    if (!v) return "";
    if (!/^[a-z0-9_-]+$/i.test(v)) return "Only letters, numbers, hyphens, and underscores.";
    return "";
  };
  const handleSlugChange = (v) => {
    const clean = v.toLowerCase().replace(/\s+/g, "-");
    setSlug(clean);
    setSlugError(validateSlug(clean));
  };

  /* ── Tag helpers ── */
  const addTag = (t) => {
    const clean = t.trim().toLowerCase().replace(/^#/, "");
    if (clean && !tags.includes(clean)) setTags(p => [...p, clean]);
    setTagInput("");
  };
  const removeTag = (t) => setTags(p => p.filter(x => x !== t));
  const tagSuggestions = SB.tags
    .filter(t => !tags.includes(t) && (!tagInput || t.startsWith(tagInput.toLowerCase())))
    .slice(0, 8);

  /* ── Submit ── */
  const handleSave = () => {
    const trimUrl = url.trim();
    if (!trimUrl) { setUrlError("A URL is required."); urlRef.current?.focus(); return; }
    const err = validateSlug(slug);
    if (err) { setSlugError(err); slugRef.current?.focus(); return; }

    const normalized = trimUrl.match(/^https?:\/\//) ? trimUrl : "https://" + trimUrl;
    let host;
    try { host = new URL(normalized).hostname.replace(/^www\./, ""); } catch { host = trimUrl; }

    const FAV = ["#7782f7","#45c98a","#e6b24e","#f0686b","#56b6e6","#b178f7","#f78fb0","#5fd6a0"];
    const fav = FAV[host.charCodeAt(0) % FAV.length];
    const added = new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit" });

    onSave({
      ...(isEdit ? bookmark : { id: Date.now(), hits: 0, last: "just now", added }),
      url:    normalized.replace(/^https?:\/\//, ""),
      title:  title.trim() || host,
      host,
      slug:   slug.trim() || null,
      folder, tags, scope, pinned, fav,
      mono:   host[0].toUpperCase(),
    });
  };

  const currentFolder = SB.folderById(folder);

  /* ─────────────────────────────────────────── render ── */
  return (
    <div className="scrim bm-scrim" onMouseDown={onClose}>
      <div className="bm-modal" onMouseDown={e => e.stopPropagation()}>

        {/* ── Header ──────────────────────────────────── */}
        <div className="modal-hd">
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
            <span className="modal-hd-ic">
              <Icon name={isEdit ? "pencil" : "bookmark-plus"} size={15} />
            </span>
            <span className="t-h3">{isEdit ? "Edit bookmark" : "New bookmark"}</span>
          </div>
          <button className="icon-btn icon-btn--sm" onClick={onClose} title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────── */}
        <div className="modal-body">

          {/* URL */}
          <div className="form-group">
            <label className="form-label">URL</label>
            <div className={"field" + (urlError ? " field--err" : "")}>
              <Icon name="globe" size={15} />
              <input
                ref={urlRef}
                type="text"
                placeholder="https://example.com/page"
                value={url}
                onChange={e => { setUrl(e.target.value); setUrlError(""); }}
                onBlur={handleUrlBlur}
                onKeyDown={e => e.key === "Enter" && titleRef.current?.focus()}
                autoComplete="off"
                spellCheck={false}
              />
              {fetching && <Icon name="loader-2" size={14} className="spin" />}
            </div>
            {urlError
              ? <p className="form-msg form-msg--err">{urlError}</p>
              : fetching && <p className="form-msg">Fetching page title…</p>}
          </div>

          {/* Title */}
          <div className="form-group">
            <label className="form-label">Title</label>
            <div className="field">
              <Icon name="type" size={15} />
              <input
                ref={titleRef}
                type="text"
                placeholder={fetching ? "Fetching…" : "Page title"}
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => e.key === "Enter" && slugRef.current?.focus()}
              />
            </div>
          </div>

          {/* Slug + Folder */}
          <div className="form-row">

            {/* Slug */}
            <div className="form-group" style={{ flex: "1 1 0", minWidth: 0 }}>
              <label className="form-label">
                Slug
                <span className="form-opt">optional</span>
              </label>
              <div className={"field field--slug" + (slugError ? " field--err" : "")}>
                <span className="slug-pfx">go.slugbase.app/</span>
                <input
                  ref={slugRef}
                  type="text"
                  placeholder="my-link"
                  value={slug}
                  onChange={e => handleSlugChange(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && tagRef.current?.focus()}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {slugError && <p className="form-msg form-msg--err">{slugError}</p>}
            </div>

            {/* Folder */}
            <div className="form-group" style={{ flex: "0 0 152px" }} ref={folderRef}>
              <label className="form-label">Folder</label>
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  className={"field folder-btn" + (folderOpen ? " folder-btn--open" : "")}
                  onClick={() => setFolderOpen(p => !p)}
                >
                  <span className="folder-dot" style={{ background: currentFolder?.color }} />
                  <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {currentFolder?.name}
                  </span>
                  <Icon name="chevron-down" size={14} style={{
                    flex: "none", color: "var(--fg-subtle)",
                    transition: "transform var(--dur-micro) var(--ease)",
                    transform: folderOpen ? "rotate(180deg)" : "none"
                  }} />
                </button>
                {folderOpen && (
                  <div className="menu" style={{ left: 0, right: 0, top: "calc(100% + 5px)", zIndex: 60 }}>
                    {SB.folders.map(f => (
                      <div
                        key={f.id}
                        className="menu-item"
                        onClick={() => { setFolder(f.id); setFolderOpen(false); }}
                      >
                        <span className="folder-dot" style={{ background: f.color }} />
                        <span style={{ flex: 1 }}>{f.name}</span>
                        {folder === f.id && <Icon name="check" size={13} style={{ color: "var(--accent-text)" }} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Tags */}
          <div className="form-group" style={{ position: "relative" }}>
            <label className="form-label">
              Tags
              <span className="form-opt">optional</span>
            </label>
            <div
              className={"field tag-field" + (tagFocus ? " tag-field--on" : "")}
              onClick={() => tagRef.current?.focus()}
            >
              {tags.map(t => (
                <span key={t} className="tag">
                  {t}
                  <span
                    className="tag-rm"
                    title={"Remove #" + t}
                    onMouseDown={e => { e.preventDefault(); removeTag(t); }}
                  >
                    <Icon name="x" size={10} strokeWidth={2.5} />
                  </span>
                </span>
              ))}
              <input
                ref={tagRef}
                className="tag-inp"
                placeholder={tags.length === 0 ? "Add tags…" : ""}
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onFocus={() => setTagFocus(true)}
                onBlur={() => setTimeout(() => setTagFocus(false), 160)}
                onKeyDown={e => {
                  if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
                    e.preventDefault(); addTag(tagInput);
                  }
                  if (e.key === "Backspace" && !tagInput && tags.length) removeTag(tags[tags.length - 1]);
                }}
              />
            </div>
            {tagFocus && tagSuggestions.length > 0 && (
              <div className="tag-drop">
                {tagSuggestions.map(t => (
                  <div key={t} className="menu-item" onMouseDown={() => addTag(t)}>
                    <Icon name="hash" size={13} />
                    {t}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sharing */}
          <div className="form-group">
            <label className="form-label">Sharing</label>
            <div style={{ display: "flex", gap: "var(--sp-4)" }}>
              {[
                { val: "mine",         icon: "user",    label: "Only me" },
                { val: "shared-by-me", icon: "share-2", label: "Share with workspace" },
              ].map(o => (
                <label key={o.val} className={"scope-btn" + (scope === o.val ? " scope-btn--on" : "")}>
                  <input type="radio" name="bm-scope" value={o.val} checked={scope === o.val}
                    onChange={() => setScope(o.val)} style={{ display: "none" }} />
                  <span className={"scope-dot" + (scope === o.val ? " scope-dot--on" : "")} />
                  <Icon name={o.icon} size={14} />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          {/* Pin */}
          <label className="pin-toggle">
            <Check on={pinned} onChange={setPinned} stop={false} />
            <Icon name="pin" size={14} style={{
              color: pinned ? "var(--accent-text)" : "var(--fg-subtle)",
              transition: "color var(--dur-micro)"
            }} />
            <span>Pin to top</span>
          </label>

        </div>{/* end .modal-body */}

        {/* ── Footer ──────────────────────────────────── */}
        <div className="modal-ft">
          {isEdit ? (
            <button
              className="btn btn--ghost btn--sm"
              style={{ color: "var(--danger-text)" }}
              onClick={() => onDelete(bookmark.id)}
            >
              <Icon name="trash-2" size={14} />Delete
            </button>
          ) : (
            <span className="form-msg" style={{ fontSize: "var(--text-micro)" }}>
              <Kbd>↵</Kbd>&nbsp;to advance fields
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: "var(--sp-4)" }}>
            <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary btn--sm" onClick={handleSave}>
              <Icon name={isEdit ? "check" : "bookmark-plus"} size={14} />
              {isEdit ? "Save changes" : "Save bookmark"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

Object.assign(window, { BookmarkModal });
