"""
Bulk-add child tasks to a main task on SysDevRequest/programmertask,
then Start and Finish each one.

It makes the same API calls as the page's Save / Start >> / End >> buttons,
from inside a logged-in browser, and waits for each server reply - so a slow
server just makes it slower, not broken.

Usage:
    python child_tasks.py              # paste tasks in the terminal
    python child_tasks.py tasks.txt    # read tasks from a file
    python child_tasks.py --dry-run    # only show how the tasks are split
    python child_tasks.py --show       # show the browser window while it works
"""
import getpass
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

BASE = "http://sd-apps_svr/SysDevRequest"
URL = f"{BASE}/programmertask"
PROFILE_DIR = Path(__file__).with_name(".browser-profile")  # keeps you logged in between runs
DETAILS_MAX = 255
TABLE = 'table:has(th:text-is("Request Code"))'

# "1. text", "2) text", "3 - text", "4: text"
NUMBERED = re.compile(r"^\s*\d+\s*[.)\-:](?:\s+|$)(.*)$")

# Windows consoles (cp932 etc.) can't print every character; don't crash on them.
sys.stdout.reconfigure(errors="replace")


# --------------------------------------------------------------------------- parsing

def parse_tasks(text):
    """Split pasted text into tasks by their leading numbers.

    Unnumbered lines continue the previous numbered task. If nothing is
    numbered, every non-blank line is its own task.
    """
    lines = text.splitlines()
    if not any(NUMBERED.match(line) for line in lines):
        tasks = [line for line in lines if line.strip()]
    else:
        tasks, current = [], None
        for line in lines:
            m = NUMBERED.match(line)
            if m:
                if current is not None:
                    tasks.append(current)
                current = m.group(1)
            elif line.strip():
                if current is None:
                    tasks.append(line)
                else:
                    current += " " + line
        if current is not None:
            tasks.append(current)
    return [" ".join(t.split()) for t in tasks if t.strip()]


def read_pasted_tasks():
    print("Paste your child tasks, then type END on its own line and press Enter:")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip().upper() == "END":
            break
        lines.append(line)
    return "\n".join(lines)


def target_dates(today):
    """The site blocks Sundays for Target to Start and weekends for Target to Finish."""
    start = today + timedelta(days=1) if today.isoweekday() == 7 else today
    finish = start
    while finish.isoweekday() in (6, 7):
        finish += timedelta(days=1)
    return start, finish


# --------------------------------------------------------------------------- in-page API calls

# window.__ct - the same API logic the bookmarklet panel uses.
CORE_JS = Path(__file__).with_name("ct-core.js").read_text(encoding="utf-8")


def api(page, call, *args):
    """Run window.__ct.<call>(*args) in the page and return its result."""
    page.evaluate(f"() => {{ {CORE_JS} }}")  # (re)install if the page reloaded
    return page.evaluate(f"(a) => window.__ct.{call}(...a)", list(args))


def clean_error(e):
    msg = str(e)
    m = re.search(r"Error: (.*?)(\n|$)", msg)
    return m.group(1) if m else msg.splitlines()[0]


# --------------------------------------------------------------------------- flow

def wait_for(predicate, timeout=15.0, interval=0.3):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def login_if_needed(page):
    page.goto(URL)
    if wait_for(lambda: page.locator(TABLE).count() > 0, timeout=10):
        return
    page.goto(f"{BASE}/login")
    if not wait_for(lambda: page.get_by_label("Employee ID").is_visible(), timeout=10):
        page.goto(URL)  # login page redirected away: already logged in, just slow
        if wait_for(lambda: page.locator(TABLE).count() > 0, timeout=20):
            return
        sys.exit("Could not find the task list or the login form.")
    user = os.environ.get("SDR_USER") or input("Employee ID: ").strip()
    pw = os.environ.get("SDR_PASS") or getpass.getpass("Password (hidden): ")
    page.get_by_label("Employee ID").fill(user)
    page.get_by_label("Password").fill(pw)
    page.get_by_role("button", name="LOGIN").click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=60_000)
    page.goto(URL)
    if not wait_for(lambda: page.locator(TABLE).count() > 0, timeout=60):
        sys.exit("Login failed or the task list did not load.")


def choose_main_task(page):
    api(page, "reload")
    mains = api(page, "mainTasks")
    if not mains:
        sys.exit("No main tasks found (only On-going / Not yet started main tasks can get child tasks).")
    print("\nYour main tasks:")
    for n, m in enumerate(mains, 1):
        print(f"  {n}. {m['code']}  [{m['status']}]  {m['details'][:60]}")
    while True:
        pick = input("Choose a main task number: ").strip()
        if pick.isdigit() and 1 <= int(pick) <= len(mains):
            main = mains[int(pick) - 1]
            break
    if main["status"].lower() != "on-going":
        sys.exit(f'\n{main["code"]} is "{main["status"]}". Start the main task first - the site only '
                 "lets you start child tasks while the main task is On-going.")
    return main["code"]


def run(tasks, show=False):
    from playwright.sync_api import sync_playwright

    start, finish = target_dates(date.today())
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=not show, no_viewport=True,
            args=["--start-maximized"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.set_default_timeout(60_000)
        page.on("dialog", lambda d: d.accept())
        page.expose_function("__ctLog", lambda msg: print(msg))

        print("\nOpening the request system...")
        login_if_needed(page)
        main_code = choose_main_task(page)
        print(f"\nTarget to Start {start:%Y/%m/%d}, Target to Finish {finish:%Y/%m/%d}\n")

        t0 = time.time()
        try:
            results = page.evaluate(
                "([c, t, s, f]) => window.__ct.runBatch(c, t, s, f, m => window.__ctLog(m))",
                [main_code, tasks, start.isoformat(), finish.isoformat()],
            )
            failed = [r["details"] for r in results if not r["ok"]]
            skipped = sum(1 for r in results if r.get("skipped"))
        except Exception as e:  # could not load the list / system info
            print(f"FAILED: {clean_error(e)}")
            failed, skipped = tasks, 0

        print(f"\nDone: {len(tasks) - len(failed)}/{len(tasks)} child tasks finished "
              f"in {time.time() - t0:.0f}s" + (f" ({skipped} were already finished)" if skipped else "") + ".")
        if failed:
            print("Not completed (run again with just these to retry - saved ones are continued, not re-added):")
            for i, d in enumerate(failed, 1):
                print(f"  {i}. {d}")
        ctx.close()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv

    # utf-8-sig: files saved by Notepad/PowerShell often start with a BOM, which would hide the first "1."
    text = Path(args[0]).read_text(encoding="utf-8-sig") if args else read_pasted_tasks()
    tasks = parse_tasks(text)
    if not tasks:
        sys.exit("No tasks found.")

    print(f"\nFound {len(tasks)} child task(s):")
    too_long = False
    for i, t in enumerate(tasks, 1):
        flag = ""
        if len(t) > DETAILS_MAX:
            flag, too_long = f"   <-- TOO LONG ({len(t)}/{DETAILS_MAX})", True
        print(f"  {i}. {t}{flag}")
    if too_long:
        sys.exit("\nShorten the tasks marked TOO LONG and run again.")
    if dry_run:
        return
    if len(tasks) > 100:
        if input(f"\nThat is {len(tasks)} tasks. Type {len(tasks)} to confirm: ").strip() != str(len(tasks)):
            sys.exit("Cancelled.")
    elif input("\nAdd, start and finish all of these? (y/n): ").strip().lower() != "y":
        sys.exit("Cancelled.")
    run(tasks, show="--show" in sys.argv)


if __name__ == "__main__":
    main()
