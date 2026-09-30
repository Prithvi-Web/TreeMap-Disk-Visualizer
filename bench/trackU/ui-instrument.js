// Pasted into the page (javascript_tool) before a scan. Records long tasks, rAF gaps, visibility,
// and wraps the app's global functions that run on completion, timing each call's synchronous part
// and, for async ones, when the promise settled. Big JSON.parse calls are timed too.
(() => {
  const P = (window.__perf = { longtasks: [], loaf: [], rafGaps: [], marks: [], calls: [], parses: [], vis: [], t0: performance.now() });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch (e) { P.ltErr = String(e); }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if ((e.blockingDuration || 0) < 50) continue;
        P.loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration), scripts: (e.scripts || []).filter((s) => s.duration > 20).map((s) => ({ fn: s.sourceFunctionName, inv: s.invoker, dur: Math.round(s.duration), layout: Math.round(s.forcedStyleAndLayoutDuration || 0) })) });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { P.loafErr = String(e); }
  let last = performance.now();
  const tick = (now) => { const gap = now - last; if (gap > 32) P.rafGaps.push({ at: Math.round(last), gap: Math.round(gap), vis: document.visibilityState }); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  P.vis.push({ at: Math.round(performance.now()), s: document.visibilityState });
  document.addEventListener('visibilitychange', () => P.vis.push({ at: Math.round(performance.now()), s: document.visibilityState }));
  window.__mark = (n) => P.marks.push({ n, at: Math.round(performance.now()), wall: Date.now() });
  const origParse = JSON.parse;
  JSON.parse = function (text, rev) {
    const big = typeof text === 'string' && text.length > 1e6;
    const t = performance.now();
    const r = origParse.call(this, text, rev);
    if (big) P.parses.push({ at: Math.round(t), ms: Math.round(performance.now() - t), chars: text.length });
    return r;
  };
  const names = ['finishScan', 'indexTree', 'loadDashboardLists', 'loadTreemap', 'drawTreemap', 'renderDonut', 'refreshBigFiles', 'renderBigFolders', 'switchView', 'renderCart', 'ensureSubtree', 'graftSubtree', 'buildIndexInBackground', 'renderGrowthProjection', 'loadBudgets', 'refreshTimebar', 'renderDiskNotes', 'loadWhatsNew', 'emit', 'drawSunburst', 'drawCells', 'renderGridWindow', 'tmHover', 'onTreemapMove'];
  P.wrapped = [];
  for (const n of names) {
    const f = window[n];
    if (typeof f !== 'function') continue;
    window[n] = function (...args) {
      const t = performance.now();
      const rec = { fn: n, at: Math.round(t), arg: typeof args[0] === 'string' ? (args[0].split('/').length - 1) + ' levels' : typeof args[0] };
      P.calls.push(rec);
      const r = f.apply(this, args);
      rec.syncMs = Math.round(performance.now() - t);
      if (r && typeof r.then === 'function') r.then(() => { rec.settledMs = Math.round(performance.now() - t); }, () => { rec.settledMs = -1; });
      return r;
    };
    P.wrapped.push(n);
  }
  __mark('installed');
  return JSON.stringify({ wrapped: P.wrapped, ltErr: P.ltErr || null, loafErr: P.loafErr || null });
})();
