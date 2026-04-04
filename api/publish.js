export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { action, password } = body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const TOKEN = process.env.GITHUB_TOKEN;
  const REPO  = process.env.GITHUB_REPO;
  const BASE  = `https://api.github.com/repos/${REPO}/contents`;
  const GH    = { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };

  async function ghGet(path) {
    const r = await fetch(`${BASE}/${path}`, { headers: GH });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return r.json();
  }

  async function ghPut(path, contentStr, message, sha) {
    const payload = { message, content: Buffer.from(contentStr, 'utf8').toString('base64') };
    if (sha) payload.sha = sha;
    const r = await fetch(`${BASE}/${path}`, { method: 'PUT', headers: GH, body: JSON.stringify(payload) });
    if (!r.ok) { const t = await r.text(); throw new Error(`PUT ${path}: ${r.status} ${t}`); }
    return r.json();
  }

  async function ghPutBinary(path, base64Content, message, sha) {
    const payload = { message, content: base64Content };
    if (sha) payload.sha = sha;
    const r = await fetch(`${BASE}/${path}`, { method: 'PUT', headers: GH, body: JSON.stringify(payload) });
    if (!r.ok) { const t = await r.text(); throw new Error(`PUT binary ${path}: ${r.status} ${t}`); }
    return r.json();
  }

  async function ghDel(path, message, sha) {
    await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: GH, body: JSON.stringify({ message, sha }) });
  }

  async function getPosts() {
    const f = await ghGet('posts/posts.json');
    if (!f) return { posts: [], sha: null };
    return { posts: JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')), sha: f.sha };
  }

  try {
    // ── VERIFY ────────────────────────────────────────────────────────────
    if (action === 'verify') {
      return res.status(200).json({ ok: true });
    }

    // ── UPLOAD IMAGE ──────────────────────────────────────────────────────
    if (action === 'upload-image') {
      const { imageData, fileName } = body;
      const base64 = imageData.includes(',') ? imageData.split(',')[1] : imageData;
      const safe   = `${Date.now()}-${(fileName || 'image').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const path   = `images/${safe}`;
      const existing = await ghGet(path);
      await ghPutBinary(path, base64, `Upload image: ${safe}`, existing?.sha);
      return res.status(200).json({ url: `https://raw.githubusercontent.com/${REPO}/main/${path}` });
    }

    // ── PUBLISH / SAVE DRAFT ──────────────────────────────────────────────
    if (action === 'publish') {
      const { title, slug, blocks, excerpt, tag, isDraft } = body;
      if (!title || !slug) return res.status(400).json({ error: 'Title and slug are required' });

      const dateISO = new Date().toISOString().split('T')[0];
      const date    = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const html    = buildArticleHTML({ title, slug, blocks, excerpt, tag, date, dateISO });

      const articlePath    = `blog/${slug}.html`;
      const existingArt    = await ghGet(articlePath);
      await ghPut(articlePath, html, `${isDraft ? 'Draft' : 'Publish'}: ${title}`, existingArt?.sha);

      if (!isDraft) {
        const { posts, sha } = await getPosts();
        const meta  = { title, slug, date, dateISO, tag: tag || 'General', excerpt: excerpt || '' };
        const idx   = posts.findIndex(p => p.slug === slug);
        if (idx >= 0) posts[idx] = meta; else posts.unshift(meta);
        await ghPut('posts/posts.json', JSON.stringify(posts, null, 2), `Index: ${title}`, sha);
      }

      return res.status(200).json({ success: true, url: `/blog/${slug}` });
    }

    // ── GET POSTS ─────────────────────────────────────────────────────────
    if (action === 'get-posts') {
      const { posts } = await getPosts();
      return res.status(200).json(posts);
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (action === 'delete') {
      const { slug } = body;
      const { posts, sha } = await getPosts();
      const filtered = posts.filter(p => p.slug !== slug);
      if (sha !== null) await ghPut('posts/posts.json', JSON.stringify(filtered, null, 2), `Remove: ${slug}`, sha);
      const existing = await ghGet(`blog/${slug}.html`);
      if (existing) await ghDel(`blog/${slug}.html`, `Delete: ${slug}`, existing.sha);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

// ── HTML UTILITIES ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBlocks(blocks) {
  return (blocks || []).map(b => {
    switch (b.type) {

      case 'text': {
        const paras = (b.content || '').split(/\n\n+/).filter(p => p.trim());
        return paras.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
      }

      case 'heading':
        return `<h3 class="art-h3">${esc(b.content)}</h3>`;

      case 'pullquote':
        return `<blockquote class="art-pull">\u201c${esc(b.content)}\u201d</blockquote>`;

      case 'image':
        return `<figure class="art-figure">
  <img src="${esc(b.url)}" alt="${esc(b.alt || '')}" loading="lazy" class="art-img"/>
  ${b.caption ? `<figcaption class="art-caption">${esc(b.caption)}</figcaption>` : ''}
</figure>`;

      case 'table': {
        const heads = (b.headers || []).map(h => `<th>${esc(h)}</th>`).join('');
        const rows  = (b.rows || []).map(row =>
          `<tr>${(row || []).map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`
        ).join('\n        ');
        return `<div class="art-table-wrap">
  <table class="art-table">
    <thead><tr>${heads}</tr></thead>
    <tbody>
        ${rows}
    </tbody>
  </table>
</div>`;
      }

      case 'citation':
        return `<div class="art-citation">
  <span class="cit-label">Source</span>
  <a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" class="cit-link">${esc(b.text)}</a>
  ${b.description ? `<span class="cit-desc"> — ${esc(b.description)}</span>` : ''}
</div>`;

      case 'pdf':
        return `<div class="art-pdf">
  <span class="pdf-icon">PDF</span>
  <div class="pdf-body">
    <div class="pdf-title">${esc(b.title)}</div>
    ${b.description ? `<div class="pdf-desc">${esc(b.description)}</div>` : ''}
  </div>
  <a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" class="pdf-dl">Download \u2192</a>
</div>`;

      case 'cta':
        return `<div class="art-cta">
  <div class="cta-eyebrow">The operational platform</div>
  <div class="cta-h">ZoneIQ makes this actionable.</div>
  <p class="cta-sub">260+ species. 3,143 counties modeled individually. Push window alerts delivered to your branch dashboard every morning.</p>
  <a href="https://zoneiq.co" target="_blank" rel="noopener" class="cta-link">Explore ZoneIQ at zoneiq.co \u2192</a>
</div>`;

      case 'divider':
        return `<hr class="art-divider"/>`;

      default:
        return '';
    }
  }).join('\n\n');
}

function buildArticleHTML({ title, slug, blocks, excerpt, tag, date, dateISO }) {
  const content    = renderBlocks(blocks);
  const safeTitle  = esc(title);
  const safeExcerpt = esc(excerpt || '');
  const safeTag    = esc(tag || 'General');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${safeTitle} | PredictivePest</title>
<meta name="description" content="${safeExcerpt}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://predictivepest.com/blog/${slug}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://predictivepest.com/blog/${slug}">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeExcerpt}">
<meta property="og:site_name" content="PredictivePest">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeExcerpt}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"${safeTitle}","description":"${safeExcerpt}","datePublished":"${dateISO}","author":{"@type":"Organization","name":"PredictivePest"},"publisher":{"@type":"Organization","name":"PredictivePest","url":"https://predictivepest.com"}}
<\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=IBM+Plex+Sans:wght@300;400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--white:#fff;--off:#f8f7f5;--paper:#f2f0ec;--rule:#dedad3;--mid:#b0aba1;--muted:#7a7670;--body:#2e2c28;--ink:#141210;--moss:#2d4a35;--sage:#4e7a58;--sage-lt:#a8c4ac;--amber:#b5622a;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--white);color:var(--body);font-family:'IBM Plex Sans',sans-serif;font-weight:300;line-height:1.7;overflow-x:hidden}
nav{position:fixed;top:0;left:0;right:0;z-index:200;display:flex;align-items:center;justify-content:space-between;padding:0 56px;height:64px;background:rgba(255,255,255,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--rule)}
.logo{font-family:'IBM Plex Sans',sans-serif;font-weight:400;font-size:15px;letter-spacing:.08em;color:var(--ink);text-decoration:none}.logo span{color:var(--sage)}
.nav-links{display:flex;gap:32px;list-style:none}
.nav-links a{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);text-decoration:none;letter-spacing:.06em;transition:color .2s}.nav-links a:hover{color:var(--ink)}
.art-wrap{max-width:720px;margin:0 auto;padding:112px 40px 80px}
.art-back{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);text-decoration:none;letter-spacing:.06em;display:inline-flex;align-items:center;gap:6px;margin-bottom:40px;transition:color .2s}.art-back:hover{color:var(--sage)}
.art-meta{display:flex;gap:20px;align-items:center;margin-bottom:20px}
.art-date,.art-read{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--mid);letter-spacing:.08em}
.art-tag{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--sage);letter-spacing:.08em}
h1.art-title{font-family:'Cormorant Garamond',serif;font-size:44px;font-weight:300;line-height:1.12;color:var(--ink);margin-bottom:32px}
h1.art-title em{font-style:italic;color:var(--sage)}
.art-rule{border:none;border-top:1px solid var(--rule);margin:32px 0}
.art-body p{font-size:16px;line-height:1.8;color:var(--body);margin-bottom:22px;font-weight:300}
.art-h3{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:400;color:var(--ink);margin:40px 0 14px;line-height:1.25}
.art-pull{border-left:2px solid var(--sage);padding-left:24px;margin:36px 0;font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:300;font-style:italic;color:var(--moss);line-height:1.45}
.art-figure{margin:32px 0}
.art-img{width:100%;height:auto;border-radius:4px;display:block}
.art-caption{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--mid);margin-top:10px;letter-spacing:.04em}
.art-table-wrap{margin:28px 0;overflow-x:auto;border:1px solid var(--rule);border-radius:4px}
.art-table{width:100%;border-collapse:collapse;font-size:13px}
.art-table th{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--rule);text-align:left;font-weight:400;letter-spacing:.06em;background:var(--off)}
.art-table td{padding:10px 14px;border-bottom:1px solid var(--rule);color:var(--body);vertical-align:top}
.art-table tr:last-child td{border-bottom:none}
.art-citation{display:flex;align-items:baseline;gap:10px;padding:12px 16px;background:var(--off);border:1px solid var(--rule);border-radius:4px;margin:24px 0;flex-wrap:wrap}
.cit-label{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--mid);letter-spacing:.08em;text-transform:uppercase;flex-shrink:0}
.cit-link{font-size:13px;color:var(--sage);text-decoration:none;border-bottom:1px solid var(--sage-lt)}.cit-link:hover{color:var(--moss)}
.cit-desc{font-size:12px;color:var(--muted);font-style:italic}
.art-pdf{display:flex;align-items:center;gap:16px;padding:16px 20px;background:var(--off);border:1px solid var(--rule);border-radius:4px;margin:24px 0}
.pdf-icon{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--amber);letter-spacing:.08em;border:1px solid var(--amber);padding:4px 7px;border-radius:3px;flex-shrink:0}
.pdf-body{flex:1}.pdf-title{font-size:14px;color:var(--ink);font-weight:400;margin-bottom:2px}.pdf-desc{font-size:12px;color:var(--muted)}
.pdf-dl{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--sage);text-decoration:none;letter-spacing:.04em;flex-shrink:0;white-space:nowrap}.pdf-dl:hover{color:var(--moss)}
.art-cta{background:var(--moss);padding:36px 40px;border-radius:4px;margin:44px 0}
.cta-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--sage-lt);letter-spacing:.1em;margin-bottom:10px;text-transform:uppercase}
.cta-h{font-family:'Cormorant Garamond',serif;font-size:30px;font-weight:300;color:var(--off);margin-bottom:10px}
.cta-sub{font-size:14px;color:var(--sage-lt);font-weight:300;margin-bottom:20px;line-height:1.65}
.cta-link{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--sage-lt);text-decoration:none;letter-spacing:.06em;border-bottom:1px solid var(--sage);padding-bottom:2px;display:inline-block}.cta-link:hover{color:var(--off)}
.art-divider{border:none;border-top:1px solid var(--rule);margin:36px 0}
footer{border-top:1px solid var(--rule);padding:28px 56px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:80px}
.f-brand{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);letter-spacing:.05em}
.f-note{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--mid);letter-spacing:.04em}
.f-link{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);text-decoration:none;letter-spacing:.06em;transition:color .2s}.f-link:hover{color:var(--sage)}
@media(max-width:768px){nav{padding:0 24px}.nav-links{display:none}.art-wrap{padding:96px 24px 60px}h1.art-title{font-size:30px}.art-cta{padding:24px}footer{padding:24px;flex-direction:column}}
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">PREDICTIVE<span>PEST</span>.COM</a>
  <ul class="nav-links">
    <li><a href="/#science">The Science</a></li>
    <li><a href="/#model">The Model</a></li>
    <li><a href="/#thresholds">Thresholds</a></li>
    <li><a href="/#principles">Principles</a></li>
    <li><a href="/blog">Field Notes</a></li>
  </ul>
</nav>

<main class="art-wrap">
  <a href="/blog" class="art-back">&#8592; Field Notes</a>
  <div class="art-meta">
    <span class="art-date">${date.toUpperCase()}</span>
    <span class="art-tag">${safeTag}</span>
  </div>
  <h1 class="art-title">${safeTitle}</h1>
  <hr class="art-rule"/>
  <div class="art-body">
${content}
  </div>
</main>

<footer>
  <span class="f-brand">PredictivePest.com</span>
  <span class="f-note">A category resource maintained by ChemCal Pro LLC</span>
  <a href="https://zoneiq.co" class="f-link" target="_blank" rel="noopener">zoneiq.co &#8599;</a>
</footer>
</body>
</html>`;
}
