# Task-Automation

Bulk-adds child tasks to a main task in the IHS Request System
(`http://sd-apps_svr/SysDevRequest/programmertask`), then starts and finishes each one.

You paste a numbered list:

```
1. refactored uploading
2. refactored downloading
```

For each line it makes the same API calls the page's buttons make:

| Button | API |
|---|---|
| ADD CHILD TASK → Save | Backlog `POST /issues`, then `api/addChildTask` |
| Start Date `»` | `api/addStartDate` |
| End Date `»` | `api/addEndDate`, then Backlog issue → Closed |

Target to Start and Target to Finish are today. A Sunday start or a weekend finish moves to Monday, because the site doesn't allow them.

## Two ways to use it

**Bookmark panel (no install):** open `install.html` and drag the green button to the bookmarks bar.
Then, on the Programmer Task page, click the bookmark. A panel opens where you pick the main task, paste the list, and click **Add, start & finish**.

**Command line (Python + Playwright):**

```
pip install playwright
run.bat                      # paste tasks, type END
run.bat tasks.txt            # or read them from a file
run.bat --show               # watch the browser
python child_tasks.py --dry-run   # only show how the list is split
```

The script logs in with your Employee ID if needed. The session is kept in `.browser-profile/`, which is git-ignored.

## Files

| File | What |
|---|---|
| `ct-core.js` | The API logic (`window.__ct`). Used by both the panel and the Python script |
| `ct-panel.js` | The in-page panel |
| `build.py` | Bundles both into the bookmarklet in `install.html`. Re-run it after editing either `.js` file |
| `child_tasks.py`, `run.bat` | Command-line runner |

## Rules

- **Saves run one at a time.** The server numbers a new child task as "highest code + 1", so parallel saves got duplicate codes.
- The main task must be **On-going**; the site only allows starting child tasks then.
- **Re-running a list is safe:** unfinished tasks with the same text are continued, and finished ones are skipped, instead of being re-added.
- **Stop:** while a run is going, the panel's button becomes **Stop**. It stops after the task in hand; run the same list again to continue.
- **Editing during a run (panel):** tasks are taken from the top of the list one at a time and moved to a locked "Taken" list. Until a task is taken you can still edit it, delete it (e.g. cut 1000 down to 700) or add more at the end. Once saving is done, the list locks.
- **Big batches:** over 100 tasks, you type the count to confirm.
- If the page is reloaded mid-run, reopening the panel shows how far the last run got.
- No credentials are stored in the code. The Backlog API key is read from the site's own script at run time.
