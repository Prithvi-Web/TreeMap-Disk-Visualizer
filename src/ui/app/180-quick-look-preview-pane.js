/* ───────────────────────────── Quick-look preview pane (Feature 4) ───────────────────────────── */
const PV_IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const PV_CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'swift', 'php', 'lua', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql', 'vue', 'svelte', 'gradle']);
const PV_KW = new Set('const,let,var,function,return,if,else,for,while,do,switch,case,break,continue,import,export,default,from,as,class,new,await,async,def,lambda,self,public,private,protected,static,final,void,int,float,double,string,bool,boolean,true,false,null,nil,none,None,True,False,undefined,this,super,struct,enum,interface,type,typeof,instanceof,extends,implements,package,namespace,using,fn,mut,pub,impl,match,try,catch,finally,throw,throws,raise,yield,with,in,is,and,or,not'.split(','));

function pvEsc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function previewExt(node) { return (node.extension || node.name.split('.').pop() || '').toLowerCase(); }

/** Tiny single-pass highlighter (comments, strings, numbers, keywords). */
function highlightCode(src, ext) {
  if (!PV_CODE_EXT.has(ext)) return pvEsc(src);
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if ((c === '/' && src[i + 1] === '/') || (c === '#' && ext !== 'css' && ext !== 'scss')) {
      let j = i; while (j < n && src[j] !== '\n') j++;
      out += '<span class="tk-com">' + pvEsc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(n, j + 2);
      out += '<span class="tk-com">' + pvEsc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; } j = Math.min(n, j + 1);
      out += '<span class="tk-str">' + pvEsc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i; while (j < n && /[0-9a-fxA-FX._]/.test(src[j])) j++;
      out += '<span class="tk-num">' + pvEsc(src.slice(i, j)) + '</span>'; i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      out += PV_KW.has(w) ? '<span class="tk-kw">' + pvEsc(w) + '</span>' : pvEsc(w);
      i = j; continue;
    }
    out += pvEsc(c); i++;
  }
  return out;
}

let pvReqId = 0;
function openPreview(node) {
  if (!node || node.type !== 'file') return;
  if (node.path.startsWith('cloud://')) { toast('Quick Look needs file contents — cloud scans never download any'); return; }
  const pane = $('previewPane');
  pane.hidden = false;
  document.body.classList.add('preview-open');
  requestAnimationFrame(() => pane.classList.add('open'));
  const ext = previewExt(node);
  $('pvIcon').innerHTML = chipFor({ type: 'file', extension: ext }, 16);
  $('pvName').textContent = node.name; $('pvName').title = node.name;
  $('pvSub').textContent = formatBytes(node.size) + ' · ' + formatDate(node.modifiedAt);
  $('pvFoot').textContent = node.path; $('pvFoot').title = node.path;
  const body = $('pvBody');
  body.innerHTML = '<div class="pv-empty">Loading…</div>';
  const reqId = ++pvReqId;
  const url = `/api/files/preview?path=${encodeURIComponent(node.path)}`;
  loadProvenance(node.path, reqId);

  if (PV_IMG_EXT.has(ext)) {
    const img = new Image();
    img.alt = node.name;
    img.onload = () => { if (reqId === pvReqId) { body.innerHTML = ''; body.appendChild(img); } };
    img.onerror = () => { if (reqId === pvReqId) renderPreviewMeta(node); };
    img.src = url;
    return;
  }
  api(url).then((data) => {
    if (reqId !== pvReqId) return;
    if (data && data.type === 'text') {
      body.innerHTML = `<pre>${highlightCode(data.content, ext)}</pre>` +
        (data.truncated ? '<div class="pv-trunc">— first 8 KB shown —</div>' : '');
      body.scrollTop = 0;
    } else {
      renderPreviewMeta(node, data);
    }
  }).catch((e) => {
    if (reqId === pvReqId) body.innerHTML = `<div class="pv-empty">Can’t preview this file.<br>${escapeHtml(e.message)}</div>`;
  });
}

/* ── Download provenance (§C3) ──────────────────────────────────────────────
   The origin URL is untrusted text that arrived from a website. It is shown as
   the HOST only, escaped, with the full URL behind a deliberate click — a full
   URL in a panel is both ugly and a shoulder-surfing risk. It is never rendered
   as a live link and never fetched: the whole app makes no outbound request. */
async function loadProvenance(filePath, reqId) {
  const host = $('pvOrigin');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
  let data;
  try { data = await api('/api/provenance?path=' + encodeURIComponent(filePath)); } catch { return; }
  if (reqId !== pvReqId) return; // a newer file superseded this one

  const opened = data.lastOpenedAt
    ? `last opened ${escapeHtml(formatDate(data.lastOpenedAt))}`
    : 'never opened since it was saved, as far as this Mac records';

  if (!data.supported) {
    host.innerHTML = `<div class="pv-orig-line muted">${icon('globe', 12)} ${escapeHtml(data.unsupportedReason || 'This system does not record where files came from.')}</div>`;
  } else if (!data.found) {
    host.innerHTML = `<div class="pv-orig-line muted">${icon('globe', 12)} ${escapeHtml(data.absentReason || 'No origin recorded.')}</div>
      <div class="pv-orig-line muted">${escapeHtml(opened.charAt(0).toUpperCase() + opened.slice(1))}.</div>`;
  } else {
    const when = data.downloadedAt ? ` on ${escapeHtml(formatDate(data.downloadedAt))}` : '';
    // A quarantine record without a Spotlight entry gives the date but no URL
    // (Spotlight does not index every volume). "Downloaded on the 3rd" is true;
    // "downloaded from an unknown site" invents a site that was never recorded.
    const headline = data.host
      ? `Downloaded from ${escapeHtml(data.host)}`
      : 'Downloaded from the web';
    host.innerHTML =
      `<div class="pv-orig-line"><b>${icon('globe', 12)} ${headline}</b>${when}.</div>` +
      `<div class="pv-orig-line muted">${escapeHtml(opened.charAt(0).toUpperCase() + opened.slice(1))}.</div>` +
      (data.url ? `<button class="pv-orig-show" type="button">Show the full address</button>
         <div class="pv-orig-url" hidden><code></code></div>` : '');
    const show = host.querySelector('.pv-orig-show');
    if (show) {
      show.addEventListener('click', () => {
        const box = host.querySelector('.pv-orig-url');
        // textContent, never innerHTML and never an <a>: this string came from
        // a web page, and nothing here should be clickable by accident.
        box.querySelector('code').textContent = data.url;
        box.hidden = false;
        show.remove();
      });
    }
  }
  host.hidden = false;
}

function renderPreviewMeta(node, data) {
  const ext = previewExt(node);
  const reason = data && data.reason ? `<div class="pv-trunc">${escapeHtml(data.reason)}</div>` : '';
  $('pvBody').innerHTML =
    `<div style="text-align:center;padding:26px 0 18px;">${chipFor({ type: node.type, extension: ext }, 44)}</div>` +
    `<div class="pv-kv">` +
      `<span class="k">Type</span><span>${escapeHtml(ext ? ext.toUpperCase() + ' file' : 'File')}</span>` +
      `<span class="k">Size</span><span>${formatBytes(node.size)}</span>` +
      `<span class="k">Modified</span><span>${formatDate(node.modifiedAt)}</span>` +
    `</div>` + reason +
    `<div class="pv-empty">No inline preview for this file type.</div>`;
}

function closePreview() {
  const pane = $('previewPane');
  pane.classList.remove('open');
  document.body.classList.remove('preview-open');
  pvReqId++; // cancel any in-flight render
  setTimeout(() => { if (!pane.classList.contains('open')) pane.hidden = true; }, 260);
}
function previewIsOpen() { const p = $('previewPane'); return p && !p.hidden && p.classList.contains('open'); }
$('pvClose').addEventListener('click', closePreview);
