// Auto Child Tasks - core. Installs window.__ct on the programmertask page.
// Mirrors the site's own saveChildTask, putStartDate and putEndDate, but awaits
// every request so a slow server only makes it slower, not broken.
// Shared by the bookmarklet panel (ct-panel.js) and child_tasks.py.
(() => {
  if (window.__ct) return;
  const BACKLOG = 'https://hrd-s.backlog.com/api/v2';
  // One at a time: the server numbers a new child task as "highest code + 1", so
  // parallel saves get the SAME code (seen 2026-10-07: 504-740 and 504-744 x3).
  const CONCURRENCY = 1;
  // Start and finish only touch rows that already have their own code, so these can overlap
  // (tested 2026-10-09: 6 tasks took 36s one at a time, 13s three at a time).
  const FINISH_CONCURRENCY = 3;
  const FINISH_RETRIES = 3;   // rounds of retrying start/finish failures, 10s apart
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pad = n => String(n).padStart(2, '0');
  const now = () => { const d = new Date();
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const until = async (cond, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return; await sleep(300); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const retry = async (fn, tries = 3) => {   // only used for reads
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(2000 * i); }
    }
  };
  // Backlog rejects bursts with HTTP 429 (nothing is created); wait for its reset and resend.
  const backlog = async fn => {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        if (!e.response || e.response.status !== 429 || i >= 8) throw e;
        const reset = (parseInt(e.response.headers['x-ratelimit-reset']) || 0) * 1000;
        await sleep(Math.min(Math.max(reset - Date.now(), 2000), 65000));
      }
    }
  };
  const pool = async (items, fn, n = CONCURRENCY) => {   // run fn over items, n at a time
    let next = 0;
    const worker = async () => { while (next < items.length) await fn(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  };
  // How long each kind of request takes, summed per run: {name: [count, total ms]}.
  let times = {};
  const timed = async (name, fn) => {
    const t = performance.now();
    try { return await fn(); } finally {
      const s = times[name] = times[name] || [0, 0];
      s[0]++; s[1] += performance.now() - t;
    }
  };
  const errText = e => e.response ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}` : String(e.message || e);

  let apiKey = null;
  const backlogKey = async () => {     // the site's Backlog key, read from its own script
    if (apiKey) return apiKey;
    const src = document.querySelector('script[src*="js/app.js"]').src;
    const text = await retry(() => fetch(src).then(r => r.text()));
    apiKey = text.match(/backlog\.com\/api\/v2\/issues\?apiKey=([A-Za-z0-9]+)/)[1];
    return apiKey;
  };

  const ct = {
    vm() {
      const app = document.querySelector('[data-app]');
      const all = [];
      const walk = v => { all.push(v); v.$children.forEach(walk); };
      if (app && app.__vue__) walk(app.__vue__.$root);
      const vm = all.find(v => v.$data && 'toAddChild' in v.$data);
      if (!vm) throw new Error('programmer task page not found');
      return vm;
    },
    async reload() {
      const vm = ct.vm();
      vm.loadRequestTask();
      await until(() => vm.overlay === false, 180000, 'the task list to reload');
    },
    // Unfinished child tasks of `code`, straight from the API (no page reload).
    // Rows are shaped like the page's own requestList rows, which Start/End send back.
    async openChildren(code, statuses) {
      const vm = ct.vm();
      const raw = (await retry(() => axios.post('api/getProgrammerTaskList',
        { programmer: vm.userInforDev.employeeID, status: statuses }))).data;
      const sample = vm.requestList[0];
      const keys = sample ? Object.keys(sample).filter(k => k !== 'process') : null;
      const groups = {};
      raw.filter(x => x.isChild == 1 && x.reqCode.startsWith(code + '-'))
        .forEach(x => (groups[x.reqCode] = groups[x.reqCode] || []).push(x));
      return Object.values(groups).map(g => {
        const row = {};
        (keys || Object.keys(g[0])).forEach(k => { row[k] = g[0][k]; });
        const seen = new Set();
        row.process = g.map(x => ({ processID: parseInt(x.processID), processName: x.processName, statusID: x.statusID,
            ID: x.prosID, targetDate: x.prostargetDate, finishedDate: x.prosfinishedDate,
            finishedBy: x.prosfinishedBy, disapproved: x.prosdisapproved }))
          .filter(p => !seen.has(p.ID) && seen.add(p.ID))
          .sort((a, b) => a.processID - b.processID);
        return row;
      });
    },
    mainTasks() {
      return ct.vm().requestList
        .filter(r => r.isChild != 1 && (r.status == 1 || r.status == 5))
        .map(r => ({ code: r.reqCode, details: r.details, status: r.statusName, ongoing: r.status == 1 }));
    },

    // Everything saveChildTask looks up, fetched once per run.
    async prepare(code) {
      const vm = ct.vm(), user = vm.userInforDev;
      const main = vm.requestList.find(r => r.reqCode === code && r.isChild != 1);
      if (!main) throw new Error(`main task ${code} not found`);
      const systems = (await retry(() => axios.get('api/getSystemList'))).data;
      const sys = systems.find(s => s.id == main.systemID);
      if (!sys) throw new Error(`system ${main.systemID} not found`);
      const projectId = parseInt(sys.projectId_backlog);
      const key = await backlogKey();
      const types = (await retry(() => axios.get(`${BACKLOG}/projects/${projectId}/issueTypes?apiKey=${key}`))).data;
      return { user, main, projectId, key, issueTypeId: types.find(t => t.name == 'Task').id };
    },

    async createIssue(p, details, start, finish) {   // the Backlog half of saveChildTask
      const { user, main: m } = p;
      return (await timed('Backlog create', () => backlog(() => axios.post(`${BACKLOG}/issues?apiKey=${p.key}`, {
        projectId: p.projectId, summary: details, priorityId: parseInt(m.priority) + 1,
        assigneeId: parseInt(user.backLogUserID), startDate: start, dueDate: finish, issueTypeId: p.issueTypeId,
      })))).data;
    },

    // = saveChildTask. `issue` is its Backlog issue if already made (see runBatch).
    async add(p, details, start, finish, issue) {
      const { user, main: m } = p;
      issue = issue || await ct.createIssue(p, details, start, finish);
      const child = {
        reqCode: m.reqCode, systemID: m.systemID, priority: m.priority, requester: m.requester,
        contact_No: m.contact_No, req_Company: m.req_Company, req_Department: m.req_Department,
        req_Section: m.req_Section, minDate: m.targetToStart, maxDate: m.targetDate,
        details, targetToStart: start, targetDate: finish,
        isApproved: 1, status: 5, reqType: 5, reqKind: 6,
        issueID: issue.id, assignProgrammer: user.employeeID, updatedBy: user.employeeID,
        process: [{ statusID: 5, processID: 1, processName: 'Making of Request' }],
      };
      // The server sometimes answers 500. Before resending, check whether it saved anyway
      // (the row carries this Backlog issue id), so a retry never creates a duplicate.
      const savedAnyway = async () => (await ct.openChildren(m.reqCode, ['Not yet Started']))
        .some(r => String(r.issueID_backLog) === String(issue.id));
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await timed('addChildTask', () => axios.post('api/addChildTask', child));
          if (res.data === 'OK') return;
          lastError = new Error(`addChildTask replied ${JSON.stringify(res.data)}`);
        } catch (e) { lastError = e; }
        await timed('500 retry wait', () => sleep(3000 * attempt));
        if (await timed('500 saved-anyway check', savedAnyway).catch(() => false)) return;
      }
      // Not saved: close the Backlog issue we made so it isn't left Open with no task.
      await backlog(() => axios.patch(`${BACKLOG}/issues/${issue.id}?apiKey=${p.key}`, { statusId: 4 })).catch(() => {});
      throw lastError;
    },

    async start(r) {   // = putStartDate
      r.startDate = now();
      if (r.iirID !== null) axios.get(`http://10.169.141.123:6055/udpateIIRData/${r.iirID}/On-going`).catch(() => {});
      await timed('addStartDate', () => axios.post('api/addStartDate', r));
      r.statusName = 'On-going'; r.status = '1';
    },

    async closeIssue(p, r) {   // Backlog issue -> Closed (closing it twice is harmless)
      await timed('Backlog close', () => backlog(() => axios.patch(`${BACKLOG}/issues/${parseInt(r.issueID_backLog)}?apiKey=${p.key}`, { statusId: 4 })))
        .catch(e => console.warn('Backlog close failed', e));
    },

    async finish(p, r) {   // = putEndDate (child task path)
      if (r.reqType == 3 || (r.reqKind == 3 && r.iirID !== null))
        throw new Error('this task type needs the End >> dialog; finish it by hand');
      r.endDate = now();
      if (r.systemID == '983') {
        await axios.post('api/updateMeetingEndController', r);
      } else {
        r.updatedBy = p.user.employeeID;
        const open = r.process.filter(x => x.finishedDate == null)
          .sort((a, b) => parseInt(a.processID) - parseInt(b.processID));
        if (!open.length) throw new Error('no open process step to finish');
        r.processID = parseInt(open[0].processID);
        r.statusID = open[0].statusID;
        await timed('addEndDate', () => axios.post('api/addEndDate', r));
        await ct.closeIssue(p, r);
      }
      r.statusName = 'Finished'; r.status = 4;
    },

    // Add, start and finish every task. log(msg) reports progress.
    // `tasks` is an array, or a (possibly async) function returning the next task (null when there are no more)
    // so the panel can keep the not-yet-saved part of the list editable during the run;
    // then pending() tells how many are still waiting, for the [i/n] counter.
    // shouldStop() is checked before each task: true stops after the task in hand.
    // progress(i, 'saved' | 'finished') is called as each task gets there;
    // savingDone() once no more tasks will be taken.
    // Returns [{details, ok, skipped, error}] in the order the tasks were taken.
    async runBatch(code, tasks, start, finish, log,
                   { shouldStop = () => false, progress = () => {}, pending = () => 0, savingDone = () => {},
                     finishConcurrency = FINISH_CONCURRENCY } = {}) {
      times = {};
      const phase = {}, mark = name => { phase[name] = performance.now(); };
      mark('run');
      let next = tasks;
      if (Array.isArray(tasks)) { let k = 0; next = () => (k < tasks.length ? tasks[k++] : null); pending = () => tasks.length - k; }
      const results = [], taken = [];   // taken[i] = details of the i-th task taken
      const tag = i => `[${i + 1}/${results.length + pending()}]`;
      const rows = [], claimed = new Set();
      const fail = (i, e) => { results[i].error = errText(e); log(`${tag(i)} FAILED: ${results[i].error}`); };
      // An unfinished child with these details that no other task has taken.
      let open = [];
      const claim = details => {
        const r = open.find(x => norm(x.details) === norm(details) && x.status != 4 && !claimed.has(x.id));
        if (r) claimed.add(r.id);
        return r;
      };

      log('Checking for tasks already added...');
      // All at once: each list query takes 5-10s.
      // Finished children are counted by text, so re-running a list never re-adds them
      // (seen 2026-10-08: a re-run re-added 19 finished tasks as new ones).
      const [p, openRows, finished] = await Promise.all([
        timed('prepare', () => ct.prepare(code)),
        timed('list query', () => ct.openChildren(code, ['Not yet Started', 'On-going'])),
        timed('list query', () => ct.openChildren(code, ['Finished'])),
      ]);
      open = openRows;
      const done = new Map();
      finished.forEach(r => done.set(norm(r.details), (done.get(norm(r.details)) || 0) + 1));

      // 1. Save the tasks that aren't there yet (an earlier, interrupted run may have saved some).
      //    Saves go one at a time (see CONCURRENCY), but the next task's Backlog issue is made
      //    while the current one saves, since only addChildTask needs its turn.
      //    So a task is taken one save early, and Stop stops after the (up to two) tasks in hand.
      mark('save');
      let saved = [], stopped = false;
      const stopNow = () => stopped || (stopped = shouldStop());
      // The next task that needs saving, with its Backlog issue under way; null when there are no more.
      const takeNext = async () => {
        for (let d; !stopNow() && (d = await next()) != null;) {
          const i = results.length;
          taken.push(d); results.push({ details: d, ok: false, error: null });
          rows[i] = claim(d);
          if (rows[i]) { log(`${tag(i)} already added as ${rows[i].reqCode} - continuing it`); continue; }
          const left = done.get(norm(d)) || 0;
          if (left) {
            done.set(norm(d), left - 1);
            results[i].ok = true; results[i].skipped = true;
            log(`${tag(i)} already finished - skipped`);
            continue;
          }
          const issue = ct.createIssue(p, d, start, finish);
          issue.catch(() => {});   // a failure is reported when this task saves
          return { i, d, issue };
        }
        return null;
      };
      for (let cur = await takeNext(); cur;) {
        const upcoming = takeNext();
        try { await ct.add(p, cur.d, start, finish, await cur.issue); saved.push(cur.i); log(`${tag(cur.i)} saved`); progress(cur.i, 'saved'); }
        catch (e) { fail(cur.i, e); }
        cur = await upcoming;
      }
      savingDone();   // no more tasks will be taken from here on

      // 2. Look up the new rows - new tasks are "Not yet Started", the fastest query
      //    (retry a few times if the server is slow to list them).
      for (let attempt = 0; saved.length && attempt < 4; attempt++) {
        if (attempt) await sleep(3000);
        log('Getting the new child tasks...');
        open = await timed('list query', () => ct.openChildren(code, ['Not yet Started']));
        saved = saved.filter(i => !(rows[i] = claim(taken[i])));
      }
      saved.forEach(i => fail(i, new Error('saved, but it did not appear in the task list')));

      // 3. Start and finish.
      mark('finish');
      await pool(taken.map((_, i) => i).filter(i => rows[i]), async i => {
        const r = rows[i];
        if (stopNow()) { results[i].error = 'stopped'; return; }
        try {
          if (r.startDate == null) await ct.start(r);
          await ct.finish(p, r);
          results[i].ok = true;
          log(`${tag(i)} finished (${r.reqCode})`); progress(i, 'finished');
        } catch (e) { fail(i, e); }
      }, finishConcurrency);

      // 4. Retry start/finish failures: the database sometimes refuses connections for a moment
      //    (seen 2026-10-09: SQLSTATE[08001] on addEndDate). Each round re-reads the rows first,
      //    so a step the server did take before the error is not done twice.
      for (let round = 1; round <= FINISH_RETRIES; round++) {
        const again = taken.map((_, i) => i).filter(i => rows[i] && !results[i].ok && results[i].error !== 'stopped');
        if (!again.length || stopNow()) break;
        log(`Retrying ${again.length} task(s) that did not start/finish (round ${round}/${FINISH_RETRIES})...`);
        await sleep(10000);
        let now;
        try {   // all statuses: a task that did finish must be told apart from one that is gone
          now = await timed('list query', () => ct.openChildren(code, ['Not yet Started', 'On-going', 'Finished']));
        } catch (e) { log(`Could not re-read the task list: ${errText(e)}`); continue; }
        await pool(again, async i => {
          const r = now.find(x => x.reqCode === rows[i].reqCode);
          if (!r) return fail(i, new Error(`${rows[i].reqCode} is no longer in the task list`));
          rows[i] = r;
          const wasDone = r.status == 4;   // read now: finish() sets it
          try {
            if (!wasDone) {
              if (r.startDate == null) await ct.start(r);
              await ct.finish(p, r);
            } else if (r.systemID != '983') {
              await ct.closeIssue(p, r);   // addEndDate went through, the Backlog close after it did not
            }
            results[i].ok = true; results[i].error = null;
            log(`${tag(i)} finished (${r.reqCode})${wasDone ? ' - it had gone through' : ' on retry'}`);
            progress(i, 'finished');
          } catch (e) { fail(i, e); }
        }, finishConcurrency);
      }
      mark('end');
      const sec = (a, b) => ((phase[b] - phase[a]) / 1000).toFixed(1) + 's';
      log(`Timing: checks ${sec('run', 'save')}, saving + lookup ${sec('save', 'finish')}, `
        + `start/finish ${sec('finish', 'end')} (${finishConcurrency} at a time)`);
      log('Requests: ' + Object.entries(times)
        .map(([k, [n, ms]]) => `${k} ${n}x avg ${(ms / n / 1000).toFixed(2)}s`).join(', '));
      if (stopped) {
        const notDone = results.filter(r => r.error === 'stopped').length;
        log(`Stopped. ${notDone} task(s) not done - run the same list again to continue (finished ones are skipped).`);
      }
      return results;
    },
  };
  window.__ct = ct;
})();
