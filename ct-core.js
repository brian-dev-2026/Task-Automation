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
  const pool = async (items, fn) => {   // run fn over items, CONCURRENCY at a time
    let next = 0;
    const worker = async () => { while (next < items.length) await fn(items[next++]); };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
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

    async add(p, details, start, finish) {   // = saveChildTask
      const { user, main: m } = p;
      const issue = (await backlog(() => axios.post(`${BACKLOG}/issues?apiKey=${p.key}`, {
        projectId: p.projectId, summary: details, priorityId: parseInt(m.priority) + 1,
        assigneeId: parseInt(user.backLogUserID), startDate: start, dueDate: finish, issueTypeId: p.issueTypeId,
      }))).data;
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
          const res = await axios.post('api/addChildTask', child);
          if (res.data === 'OK') return;
          lastError = new Error(`addChildTask replied ${JSON.stringify(res.data)}`);
        } catch (e) { lastError = e; }
        await sleep(3000 * attempt);
        if (await savedAnyway().catch(() => false)) return;
      }
      // Not saved: close the Backlog issue we made so it isn't left Open with no task.
      await backlog(() => axios.patch(`${BACKLOG}/issues/${issue.id}?apiKey=${p.key}`, { statusId: 4 })).catch(() => {});
      throw lastError;
    },

    async start(r) {   // = putStartDate
      r.startDate = now();
      if (r.iirID !== null) axios.get(`http://10.169.141.123:6055/udpateIIRData/${r.iirID}/On-going`).catch(() => {});
      await axios.post('api/addStartDate', r);
      r.statusName = 'On-going'; r.status = '1';
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
        await axios.post('api/addEndDate', r);
        await backlog(() => axios.patch(`${BACKLOG}/issues/${parseInt(r.issueID_backLog)}?apiKey=${p.key}`, { statusId: 4 }))
          .catch(e => console.warn('Backlog close failed', e));
      }
      r.statusName = 'Finished'; r.status = 4;
    },

    // Add, start and finish every task. log(msg) reports progress.
    // Returns [{details, ok, error}] in the same order as `tasks`.
    async runBatch(code, tasks, start, finish, log) {
      const n = tasks.length, tag = i => `[${i + 1}/${n}]`;
      const results = tasks.map(details => ({ details, ok: false, error: null }));
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
      const p = await ct.prepare(code);
      open = await ct.openChildren(code, ['Not yet Started', 'On-going']);

      // 1. Save the tasks that aren't there yet (an earlier, interrupted run may have saved some).
      const toAdd = [];
      tasks.forEach((d, i) => {
        rows[i] = claim(d);
        if (rows[i]) log(`${tag(i)} already added as ${rows[i].reqCode} - continuing it`);
        else toAdd.push(i);
      });
      let saved = [];
      await pool(toAdd, async i => {
        try { await ct.add(p, tasks[i], start, finish); saved.push(i); log(`${tag(i)} saved`); }
        catch (e) { fail(i, e); }
      });

      // 2. Look up the new rows - new tasks are "Not yet Started", the fastest query
      //    (retry a few times if the server is slow to list them).
      for (let attempt = 0; saved.length && attempt < 4; attempt++) {
        if (attempt) await sleep(3000);
        log('Getting the new child tasks...');
        open = await ct.openChildren(code, ['Not yet Started']);
        saved = saved.filter(i => !(rows[i] = claim(tasks[i])));
      }
      saved.forEach(i => fail(i, new Error('saved, but it did not appear in the task list')));

      // 3. Start and finish.
      await pool(tasks.map((_, i) => i).filter(i => rows[i]), async i => {
        const r = rows[i];
        try {
          if (r.startDate == null) await ct.start(r);
          await ct.finish(p, r);
          results[i].ok = true;
          log(`${tag(i)} finished (${r.reqCode})`);
        } catch (e) { fail(i, e); }
      });
      return results;
    },
  };
  window.__ct = ct;
})();
