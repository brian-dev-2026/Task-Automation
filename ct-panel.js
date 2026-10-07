// Auto Child Tasks - panel shown inside the programmertask page.
// Needs ct-core.js (window.__ct) loaded first; build.py bundles both into the bookmarklet.
(() => {
  const PAGE = 'http://sd-apps_svr/SysDevRequest/programmertask';
  const DETAILS_MAX = 255;

  const old = document.getElementById('ct-panel-host');
  if (old) { old.remove(); return; }   // clicking the bookmark again closes the panel

  try { window.__ct.vm(); } catch (e) {
    if (confirm('Auto Child Tasks works on the Programmer Task page.\nOpen it now? (then click the bookmark again)')) location.href = PAGE;
    return;
  }

  // ---- same rules as child_tasks.py --------------------------------------
  const NUMBERED = /^\s*\d+\s*[.)\-:](?:\s+|$)(.*)$/;
  const parseTasks = text => {
    const lines = text.split(/\r?\n/);
    let tasks;
    if (!lines.some(l => NUMBERED.test(l))) {
      tasks = lines.filter(l => l.trim());
    } else {
      tasks = []; let cur = null;
      for (const l of lines) {
        const m = l.match(NUMBERED);
        if (m) { if (cur !== null) tasks.push(cur); cur = m[1]; }
        else if (l.trim()) { if (cur === null) tasks.push(l); else cur += ' ' + l; }
      }
      if (cur !== null) tasks.push(cur);
    }
    return tasks.map(t => t.split(/\s+/).filter(Boolean).join(' ')).filter(Boolean);
  };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const targetDates = () => {   // site blocks Sunday starts and weekend finishes
    const start = new Date();
    if (start.getDay() === 0) start.setDate(start.getDate() + 1);
    const finish = new Date(start);
    while (finish.getDay() === 0 || finish.getDay() === 6) finish.setDate(finish.getDate() + 1);
    return [iso(start), iso(finish)];
  };
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- UI -----------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'ct-panel-host';
  host.style.cssText = 'position:fixed;top:70px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: Roboto, "Segoe UI", sans-serif; }
    .card { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 90px); display: flex; flex-direction: column;
            background: #fff; color: #1f2430; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.28); overflow: hidden; }
    .head { background: #282f42; color: #fff; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; font-weight: 500; }
    .x { background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; }
    .body { padding: 12px 14px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
    label { font-size: 12px; color: #5b6170; display: block; margin-bottom: 4px; }
    select, textarea { width: 100%; border: 1px solid #b8bdc8; border-radius: 4px; padding: 7px 8px; font-size: 14px; color: inherit; background: #fff; }
    textarea { height: 150px; resize: vertical; }
    .hint { font-size: 12px; color: #5b6170; }
    .preview { font-size: 13px; margin: 0; padding-left: 22px; max-height: 120px; overflow: auto; }
    .preview li { margin: 2px 0; }
    .bad { color: #c62828; font-weight: 500; }
    .run { background: #4caf50; color: #fff; border: 0; border-radius: 4px; padding: 10px; font-size: 14px; font-weight: 500;
           letter-spacing: .05em; cursor: pointer; text-transform: uppercase; }
    .run:disabled { background: #a5c9a7; cursor: default; }
    .log { font: 12px/1.5 Consolas, monospace; background: #f4f5f7; border-radius: 4px; padding: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
    .log:empty { display: none; }
    .ok { color: #2e7d32; } .err { color: #c62828; } .dim { color: #6b7280; }
  </style>
  <div class="card">
    <div class="head"><span>Auto Child Tasks</span><button class="x" title="Close">&times;</button></div>
    <div class="body">
      <div><label>Main task</label><select id="main"><option>Loading...</option></select></div>
      <div>
        <label>Child tasks (paste a numbered list: 1. ... 2. ...)</label>
        <textarea id="tasks" placeholder="1. refactored uploading&#10;2. refactored downloading"></textarea>
      </div>
      <div id="summary" class="hint"></div>
      <ol id="preview" class="preview"></ol>
      <button id="run" class="run" disabled>Add, start &amp; finish</button>
      <div id="log" class="log"></div>
    </div>
  </div>`;
  document.body.appendChild(host);

  const $ = id => root.getElementById(id);
  const mainSel = $('main'), box = $('tasks'), runBtn = $('run'), logEl = $('log');
  const [start, finish] = targetDates();
  let running = false;

  const log = (text, cls = '') => {
    const line = document.createElement('div');
    line.className = cls; line.textContent = text;
    logEl.appendChild(line); logEl.scrollTop = logEl.scrollHeight;
  };

  const refresh = () => {
    const tasks = parseTasks(box.value);
    const tooLong = tasks.filter(t => t.length > DETAILS_MAX).length;
    $('preview').innerHTML = tasks.map(t => t.length > DETAILS_MAX
      ? `<li class="bad">${esc(t.slice(0, 80))}... (${t.length}/${DETAILS_MAX} - too long)</li>`
      : `<li>${esc(t)}</li>`).join('');
    $('summary').innerHTML = tasks.length
      ? `${tasks.length} task(s) &middot; Target to Start ${start.replace(/-/g, '/')} &middot; Target to Finish ${finish.replace(/-/g, '/')}`
        + (tooLong ? ` &middot; <span class="bad">${tooLong} too long</span>` : '')
      : '';
    const opt = mainSel.selectedOptions[0];
    runBtn.disabled = running || !tasks.length || tooLong > 0 || !opt || !opt.value;
    return tasks;
  };

  const loadMains = async () => {
    try {
      await window.__ct.reload();
      const mains = window.__ct.mainTasks();
      mainSel.innerHTML = mains.length
        ? mains.map(m => `<option value="${m.ongoing ? esc(m.code) : ''}" ${m.ongoing ? '' : 'disabled'}>`
            + `${esc(m.code)} [${esc(m.status)}] ${esc(m.details.slice(0, 45))}</option>`).join('')
        : '<option value="">No main tasks found</option>';
      const first = mains.find(m => m.ongoing);
      if (first) mainSel.value = first.code;
      else if (mains.length) log('Only On-going main tasks can get child tasks. Start the main task first.', 'err');
    } catch (e) {
      mainSel.innerHTML = '<option value="">Could not load tasks</option>';
      log(String(e.message || e), 'err');
    }
    refresh();
  };

  root.querySelector('.x').onclick = () => {
    if (!running || confirm('Tasks are still running. Close the panel anyway?')) host.remove();
  };
  box.oninput = refresh;
  mainSel.onchange = refresh;

  runBtn.onclick = async () => {
    const tasks = refresh(), code = mainSel.value;
    if (!confirm(`Add, start and finish ${tasks.length} child task(s) on ${code}?`)) return;
    running = true; refresh(); box.disabled = mainSel.disabled = true;
    logEl.textContent = '';
    const t0 = Date.now();
    let failed;
    try {
      const results = await window.__ct.runBatch(code, tasks, start, finish,
        msg => log(msg, msg.includes('FAILED') ? 'err' : 'dim'));
      failed = results.filter(r => !r.ok).map(r => r.details);
    } catch (e) {   // could not even load the list / system info: nothing was saved
      log(`FAILED: ${e.message || e}`, 'err');
      failed = tasks;
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`Done: ${tasks.length - failed.length}/${tasks.length} added and finished in ${secs}s.`, failed.length ? 'err' : 'ok');
    if (failed.length) {
      log('Click the button again to retry the failed ones.', 'err');
      box.value = failed.map((t, i) => `${i + 1}. ${t}`).join('\n');
    } else {
      box.value = '';
    }
    running = false; box.disabled = mainSel.disabled = false; refresh();
    window.__ct.reload().catch(() => {});
  };

  loadMains();
  box.focus();
})();
