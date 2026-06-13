/* SlugBase prototype — fake data. Exposes window.SB. */
(function () {
  const FWD = "go.slugbase.app"; // personal short-redirect domain

  const workspaces = [
    { id: "personal", name: "Personal", plan: "Free", letter: "P", color: "#7782f7" },
    { id: "acme", name: "Acme Engineering", plan: "Team", letter: "A", color: "#45c98a" },
    { id: "side", name: "Side Projects", plan: "Pro", letter: "S", color: "#e6b24e" },
  ];

  const folders = [
    { id: "inbox", name: "Inbox", color: "#7782f7", count: 6 },
    { id: "dev", name: "Dev Tools", color: "#45c98a", count: 9 },
    { id: "reading", name: "Reading List", color: "#e6b24e", count: 7 },
    { id: "design", name: "Design", color: "#f0686b", count: 5 },
    { id: "infra", name: "Infra & Ops", color: "#56b6e6", count: 4 },
  ];

  const tags = ["react","ai","css","reference","video","paper","tool","rust","security","selfhost","inspo","api"];

  const C = ["#7782f7","#45c98a","#e6b24e","#f0686b","#56b6e6","#b178f7","#f78fb0","#5fd6a0"];
  const fav = (s) => C[s.charCodeAt(0) % C.length];

  // scope: mine | shared-with-me | shared-by-me
  function bm(o) { return Object.assign({ pinned:false, slug:null, tags:[], scope:"mine", hits:0 }, o); }

  const bookmarks = [
    bm({ id:1, title:"React 19 — useOptimistic & Actions, the full guide", url:"react.dev/blog/2024/04/25/react-19", host:"react.dev", folder:"dev", tags:["react","reference"], slug:"react19", pinned:true, hits:142, last:"2h", added:"Apr 25" }),
    bm({ id:2, title:"The Rust Performance Book", url:"nnethercote.github.io/perf-book", host:"github.io", folder:"dev", tags:["rust","reference"], slug:"rustperf", pinned:true, hits:88, last:"1d", added:"Mar 02", scope:"shared-by-me" }),
    bm({ id:3, title:"Designing Data-Intensive Applications — notes", url:"dataintensive.net", host:"dataintensive.net", folder:"reading", tags:["paper","reference"], slug:"ddia", pinned:true, hits:230, last:"5h", added:"Jan 11" }),
    bm({ id:4, title:"Tailwind CSS v4 alpha — engine rewrite", url:"tailwindcss.com/blog/tailwindcss-v4-alpha", host:"tailwindcss.com", folder:"dev", tags:["css","tool"], slug:"tw4", hits:54, last:"3h", added:"Apr 18" }),
    bm({ id:5, title:"How Postgres handles MVCC and vacuum", url:"postgresql.org/docs/current/mvcc.html", host:"postgresql.org", folder:"infra", tags:["reference","api"], slug:"pgmvcc", hits:31, last:"2d", added:"Apr 09", scope:"shared-with-me" }),
    bm({ id:6, title:"Refactoring UI — practical visual design", url:"refactoringui.com", host:"refactoringui.com", folder:"design", tags:["inspo","reference"], slug:"refui", pinned:false, hits:176, last:"6h", added:"Feb 20" }),
    bm({ id:7, title:"Self-hosting a Postgres backup pipeline with restic", url:"restic.net/docs", host:"restic.net", folder:"infra", tags:["selfhost","tool"], slug:"restic", hits:12, last:"4d", added:"Apr 02" }),
    bm({ id:8, title:"The Illustrated Transformer", url:"jalammar.github.io/illustrated-transformer", host:"github.io", folder:"reading", tags:["ai","paper"], slug:"transformer", hits:97, last:"1d", added:"Mar 14", scope:"shared-with-me" }),
    bm({ id:9, title:"esbuild — an extremely fast bundler", url:"esbuild.github.io", host:"github.io", folder:"dev", tags:["tool","reference"], slug:"esbuild", hits:43, last:"8h", added:"Apr 21" }),
    bm({ id:10, title:"CSS :has() selector — finally landed everywhere", url:"developer.mozilla.org/en-US/docs/Web/CSS/:has", host:"mozilla.org", folder:"dev", tags:["css","reference"], slug:null, hits:67, last:"12h", added:"Apr 15" }),
    bm({ id:11, title:"Building an LLM eval harness from scratch", url:"hamel.dev/blog/posts/evals", host:"hamel.dev", folder:"reading", tags:["ai","paper"], slug:"evals", hits:58, last:"1d", added:"Apr 06", scope:"shared-by-me" }),
    bm({ id:12, title:"OWASP Top 10 — 2024 web security risks", url:"owasp.org/Top10", host:"owasp.org", folder:"dev", tags:["security","reference"], slug:"owasp", hits:24, last:"3d", added:"Mar 28" }),
    bm({ id:13, title:"Figma plugin API reference", url:"figma.com/plugin-docs", host:"figma.com", folder:"design", tags:["api","tool"], slug:"figapi", hits:19, last:"2d", added:"Apr 11" }),
    bm({ id:14, title:"The Grug Brained Developer", url:"grugbrain.dev", host:"grugbrain.dev", folder:"reading", tags:["reference"], slug:"grug", hits:201, last:"7h", added:"Feb 02" }),
    bm({ id:15, title:"Caddy — automatic HTTPS reverse proxy", url:"caddyserver.com/docs", host:"caddyserver.com", folder:"infra", tags:["selfhost","tool"], slug:"caddy", hits:36, last:"5d", added:"Mar 19" }),
    bm({ id:16, title:"Inter — the typeface for screens", url:"rsms.me/inter", host:"rsms.me", folder:"design", tags:["inspo","tool"], slug:null, hits:28, last:"2d", added:"Apr 13" }),
    bm({ id:17, title:"How DNS works — comic", url:"howdns.works", host:"howdns.works", folder:"reading", tags:["reference","video"], slug:"dns", hits:14, last:"4d", added:"Apr 01" }),
    bm({ id:18, title:"Litestream — replicate SQLite to S3", url:"litestream.io", host:"litestream.io", folder:"infra", tags:["selfhost","tool"], slug:"litestream", hits:41, last:"1d", added:"Mar 22", scope:"shared-with-me" }),
    bm({ id:19, title:"A visual guide to flexbox", url:"css-tricks.com/snippets/css/a-guide-to-flexbox", host:"css-tricks.com", folder:"dev", tags:["css","reference"], slug:"flexbox", hits:113, last:"9h", added:"Feb 17" }),
    bm({ id:20, title:"Prompt engineering guide — Anthropic docs", url:"docs.anthropic.com/prompt-engineering", host:"anthropic.com", folder:"reading", tags:["ai","reference"], slug:"prompts", pinned:false, hits:79, last:"6h", added:"Apr 19" }),
    bm({ id:21, title:"htmx — high power tools for HTML", url:"htmx.org", host:"htmx.org", folder:"dev", tags:["tool","reference"], slug:"htmx", hits:62, last:"1d", added:"Apr 08" }),
    bm({ id:22, title:"The Twelve-Factor App", url:"12factor.net", host:"12factor.net", folder:"reading", tags:["reference","paper"], slug:null, hits:47, last:"3d", added:"Mar 11" }),
    bm({ id:23, title:"Lucide — beautiful & consistent icons", url:"lucide.dev", host:"lucide.dev", folder:"design", tags:["tool","inspo"], slug:"lucide", hits:33, last:"10h", added:"Apr 16" }),
    bm({ id:24, title:"Tigris — globally distributed object storage", url:"tigrisdata.com/docs", host:"tigrisdata.com", folder:"infra", tags:["selfhost","api"], slug:"tigris", hits:9, last:"6d", added:"Mar 30" }),
    bm({ id:25, title:"Patterns.dev — modern web app patterns", url:"patterns.dev", host:"patterns.dev", folder:"dev", tags:["react","reference"], slug:"patterns", hits:51, last:"14h", added:"Apr 20" }),
    bm({ id:26, title:"Excalidraw — virtual whiteboard sketching", url:"excalidraw.com", host:"excalidraw.com", folder:"design", tags:["tool"], slug:"draw", hits:88, last:"4h", added:"Mar 25", scope:"shared-by-me" }),
  ];

  // each bookmark gets a favicon color + monogram
  bookmarks.forEach(b => { b.fav = fav(b.host); b.mono = b.host[0].toUpperCase(); });

  window.SB = { FWD, workspaces, folders, tags, bookmarks,
    folderById: id => folders.find(f => f.id === id),
    // entitlement defaults — Personal/Free
    plan: { name: "Free", cap: 100, used: 94 },
  };
})();
