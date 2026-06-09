/* SlugBase prototype — shared primitives. Exports to window. */
const { useState, useRef, useEffect, useLayoutEffect, useCallback } = React;

/* ---- Icon (Lucide) ---- */
function Icon({ name, size = 16, strokeWidth = 1.75, className = "", style }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !window.lucide) return;
    el.innerHTML = "";
    const i = document.createElement("i");
    i.setAttribute("data-lucide", name);
    el.appendChild(i);
    try {
      window.lucide.createIcons({
        attrs: { width: size, height: size, "stroke-width": strokeWidth },
        root: el,
      });
    } catch (e) {}
  });
  return <span ref={ref} className={"ico " + className}
    style={{ display: "inline-flex", width: size, height: size, ...style }} />;
}

/* ---- Checkbox ---- */
function Check({ on, mixed, onChange, stop = true }) {
  return (
    <div
      className={"cb" + (on ? " on" : "") + (mixed ? " mixed" : "")}
      onClick={(e) => { if (stop) e.stopPropagation(); onChange && onChange(!on); }}
      role="checkbox" aria-checked={mixed ? "mixed" : on}
    >
      {on && !mixed && <Icon name="check" size={12} strokeWidth={3} />}
    </div>
  );
}

/* ---- Kbd ---- */
function Kbd({ children }) { return <span className="kbd">{children}</span>; }

/* ---- Tag pill ---- */
function Tag({ children }) { return <span className="tag">{children}</span>; }

/* ---- Scope icon ---- */
const SCOPE = {
  "mine": { icon: "user", label: "Only me" },
  "shared-with-me": { icon: "users", label: "Shared with me" },
  "shared-by-me": { icon: "share-2", label: "Shared by me" },
};
function ScopeIcon({ scope }) {
  const s = SCOPE[scope] || SCOPE.mine;
  return <span className="scope-ic" title={s.label}><Icon name={s.icon} size={13} /></span>;
}

/* ---- Favicon monogram ---- */
function Favicon({ b, size = 30 }) {
  return (
    <span className="favicon" style={{ background: b.fav, width: size, height: size,
      fontSize: size * 0.42, borderRadius: size > 24 ? 6 : 4 }}>
      {b.mono}
    </span>
  );
}

/* ---- Dropdown menu (click-outside) ---- */
function useClickOutside(ref, onClose, active) {
  useEffect(() => {
    if (!active) return;
    function h(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", (e) => e.key === "Escape" && onClose());
    return () => document.removeEventListener("mousedown", h);
  }, [active]);
}

function Menu({ children, align = "left", style }) {
  return (
    <div className="menu" style={{ [align]: 0, top: "calc(100% + 6px)", ...style }} role="menu">
      {children}
    </div>
  );
}
function MenuItem({ icon, children, hint, danger, check, onClick }) {
  return (
    <div className={"menu-item" + (danger ? " danger" : "")} onClick={onClick} role="menuitem">
      {icon && <Icon name={icon} size={15} />}
      <span style={{ flex: 1 }}>{children}</span>
      {hint && <Kbd>{hint}</Kbd>}
      {check && <Icon name="check" size={14} className="check" />}
    </div>
  );
}

/* ---- relative-time helpers already baked into data (b.last) ---- */

Object.assign(window, { Icon, Check, Kbd, Tag, ScopeIcon, Favicon, Menu, MenuItem, useClickOutside });
