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
  // Split off the first task of `text` by the same rules: [task or null, rest of text, chars removed].
  const takeFirst = text => {
    const lines = text.split('\n');
    const numbered = lines.some(l => NUMBERED.test(l));
    for (let k = 0, from = 0; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      let end = k + 1;
      if (numbered && NUMBERED.test(lines[k])) while (end < lines.length && !NUMBERED.test(lines[end])) end++;
      const chunk = lines.slice(from, end).join('\n');
      const task = parseTasks(chunk)[0];
      const rest = lines.slice(end).join('\n');
      const cut = text.length - rest.length;
      if (task) return [task, rest, cut];
      // e.g. a bare "5." with no text: drop it and look further
      return (([t, r, c]) => [t, r, cut + c])(takeFirst(rest));
    }
    return [null, text, 0];
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
    .locked { color: #6b7280; background: #f4f5f7; border-radius: 4px; padding-top: 4px; padding-bottom: 4px; }
    [hidden] { display: none !important; }
    .bad { color: #c62828; font-weight: 500; }
    .run { background: #4caf50; color: #fff; border: 0; border-radius: 4px; padding: 10px; font-size: 14px; font-weight: 500;
           letter-spacing: .05em; cursor: pointer; text-transform: uppercase; }
    .run:disabled { background: #a5c9a7; cursor: default; }
    .run.stop { background: #c62828; } .run.stop:disabled { background: #e0a3a3; }
    .log { font: 12px/1.5 Consolas, monospace; background: #f4f5f7; border-radius: 4px; padding: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
    .log:empty { display: none; }
    .ok { color: #2e7d32; } .err { color: #c62828; } .dim { color: #6b7280; }
  </style>
  <div class="card">
    <div class="head"><span>Auto Child Tasks</span><button class="x" title="Close">&times;</button></div>
    <div class="body">
      <div><label>Main task</label><select id="main"><option>Loading...</option></select></div>
      <div id="savedWrap" hidden>
        <label id="savedLabel">Taken - locked</label>
        <ol id="saved" class="preview locked"></ol>
      </div>
      <div>
        <label id="tasksLabel">Child tasks (paste a numbered list: 1. ... 2. ...)</label>
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
  const BIG_BATCH = 100;   // above this, the count must be typed to confirm
  const LAST_RUN = 'ct-last-run';
  const TYPING_PAUSE = 2000;   // ms without typing before the task under the cursor may be taken
  let running = false, stopAsked = false, lastInput = 0, lastCaret = 0;

  // Progress of the last run, kept in the browser so a reload doesn't lose where it got to.
  const lastRun = {
    get() { try { return JSON.parse(localStorage.getItem(LAST_RUN)); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(LAST_RUN, JSON.stringify(v)); } catch (e) {} },
  };

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
    const savedCount = $('saved').children.length;
    $('summary').innerHTML = running
      ? `${savedCount} taken (locked) &middot; ${tasks.length} waiting`
        + (box.disabled ? '' : ' - you can still edit, add or delete these')
        + (tooLong ? ` &middot; <span class="bad">${tooLong} too long - fix before its turn or it is skipped</span>` : '')
      : tasks.length
      ? `${tasks.length} task(s) &middot; Target to Start ${start.replace(/-/g, '/')} &middot; Target to Finish ${finish.replace(/-/g, '/')}`
        + (tooLong ? ` &middot; <span class="bad">${tooLong} too long</span>` : '')
      : '';
    const opt = mainSel.selectedOptions[0];
    runBtn.textContent = running ? (stopAsked ? 'Stopping...' : 'Stop') : 'Add, start & finish';
    runBtn.classList.toggle('stop', running);
    runBtn.disabled = running ? stopAsked : (!tasks.length || tooLong > 0 || !opt || !opt.value);
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
  box.oninput = () => { lastInput = Date.now(); lastCaret = box.selectionStart; refresh(); };
  mainSel.onchange = refresh;

  runBtn.onclick = async () => {
    if (running) {   // the button is "Stop" while a run is going
      stopAsked = true; refresh();
      log('Stopping after the current task...', 'err');
      return;
    }
    const tasks = refresh(), code = mainSel.value;
    if (tasks.length > BIG_BATCH) {
      const typed = prompt(`This will add, start and finish ${tasks.length} child tasks on ${code}.\n`
        + `Type ${tasks.length} to confirm:`);
      if (typed === null) return;
      if (typed.trim() !== String(tasks.length)) { alert('The number did not match. Nothing was done.'); return; }
    } else if (!confirm(`Add, start and finish ${tasks.length} child task(s) on ${code}?`)) return;
    running = true; stopAsked = false; mainSel.disabled = true;
    $('saved').innerHTML = ''; $('savedWrap').hidden = false;
    $('tasksLabel').textContent = 'Not saved yet - you can still edit, add or delete these';
    logEl.textContent = '';
    refresh();
    const t0 = Date.now();
    const state = { code, total: tasks.length, saved: 0, finished: 0, startedAt: new Date().toLocaleString(), done: false };
    lastRun.set(state);
    const tooLongSkipped = [];
    // Hand the core the first task still in the box, moving it to the locked list.
    // Not while you are still typing in that task: it would be saved half-written, and the
    // rest of what you type would become tasks of its own.
    // Judged by where the cursor was at the last keystroke, not by focus: clicking Stop
    // takes focus away from the box, and must not count as "done typing".
    const typingIn = (rest, cut) => Date.now() - lastInput < TYPING_PAUSE
      && (lastCaret < cut || (rest === '' && lastCaret <= cut));
    const nextTask = async () => {
      let told = false;
      for (;;) {
        const [task, rest, cut] = takeFirst(box.value);
        if (task == null) return null;
        if (typingIn(rest, cut)) {
          if (stopAsked) return null;
          if (!told) { log('Waiting for you to finish typing the next task...', 'dim'); told = true; }
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        const caret = [box.selectionStart, box.selectionEnd].map(x => Math.max(0, x - cut));
        lastCaret = Math.max(0, lastCaret - cut);
        box.value = rest;
        if (root.activeElement === box) box.setSelectionRange(...caret);
        if (task.length > DETAILS_MAX) {
          tooLongSkipped.push(task);
          log(`Skipped (too long, ${task.length}/${DETAILS_MAX}): ${task.slice(0, 60)}...`, 'err');
          refresh(); continue;
        }
        const li = document.createElement('li'); li.textContent = task;
        $('saved').appendChild(li); $('saved').scrollTop = $('saved').scrollHeight;
        refresh();
        return task;
      }
    };
    const waiting = () => parseTasks(box.value).length;
    let failed, skipped = 0, stopped = 0, ok = 0;
    try {
      const results = await window.__ct.runBatch(code, nextTask, start, finish,
        msg => log(msg, msg.includes('FAILED') ? 'err' : 'dim'), {
          shouldStop: () => stopAsked,
          pending: waiting,
          progress: (i, what) => { state[what]++; state.total = $('saved').children.length + waiting(); lastRun.set(state); },
          savingDone: () => {
            box.disabled = true;
            $('tasksLabel').textContent = stopAsked ? 'Not taken (stopped)' : 'Saving is done - finishing the saved tasks';
            refresh();
          },
        });
      skipped = results.filter(r => r.skipped).length;
      stopped = results.filter(r => r.error === 'stopped').length;
      ok = results.filter(r => r.ok).length;
      failed = results.filter(r => !r.ok).map(r => r.details);
    } catch (e) {   // could not even load the list / system info: nothing was saved
      log(`FAILED: ${e.message || e}`, 'err');
      failed = [...$('saved').children].map(li => li.textContent);
    }
    // Whatever was never taken (stopped, or the run failed early) goes back in the box too.
    const notTaken = parseTasks(box.value);
    const left = [...failed, ...tooLongSkipped, ...notTaken];
    const total = ok + left.length;
    state.done = true; lastRun.set(state);
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`Done: ${ok}/${total} finished in ${secs}s`
      + (skipped ? ` (${skipped} were already finished)` : '')
      + (stopped + notTaken.length ? `, ${stopped + notTaken.length} not done (stopped)` : '') + '.',
      left.length ? 'err' : 'ok');
    if (left.length) log('The list now holds only the tasks not done. Click the button again to continue them.', 'err');
    box.value = left.map((t, i) => `${i + 1}. ${t}`).join('\n');
    $('savedWrap').hidden = true;
    $('tasksLabel').textContent = 'Child tasks (paste a numbered list: 1. ... 2. ...)';
    running = stopAsked = false; box.disabled = mainSel.disabled = false; refresh();
    window.__ct.reload().catch(() => {});
  };

  const prev = lastRun.get();
  if (prev && !prev.done) {
    log(`The last run (${prev.code}, started ${prev.startedAt}) did not complete: `
      + `${prev.saved} saved, ${prev.finished} finished of ${prev.total}. `
      + 'Paste the same list again to continue it - finished tasks are skipped.', 'err');
  }

  loadMains();
  box.focus();
})();
