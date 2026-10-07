"""Bundle ct-core.js + ct-panel.js into a bookmarklet and write install.html.

Run after changing either .js file:  python build.py
"""
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).parent
code = (HERE / "ct-core.js").read_text(encoding="utf-8") + "\n" + (HERE / "ct-panel.js").read_text(encoding="utf-8")
bookmarklet = "javascript:" + quote(code, safe="()=;,.:_-*'!~/[]{}")
href = bookmarklet.replace("&", "&amp;").replace('"', "&quot;")

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto Child Tasks</title>
<style>
  :root {{ --bg: #f4f5f7; --card: #fff; --text: #1f2430; --muted: #5b6170; --brand: #282f42; --ok: #4caf50; }}
  body {{ margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 Roboto, "Segoe UI", sans-serif; }}
  main {{ max-width: 720px; margin: 40px auto; padding: 0 16px; }}
  .card {{ background: var(--card); border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.08); padding: 28px 32px; }}
  h1 {{ margin: 0 0 4px; font-size: 24px; color: var(--brand); }}
  .sub {{ color: var(--muted); margin: 0 0 24px; }}
  h2 {{ font-size: 16px; margin: 28px 0 8px; color: var(--brand); }}
  .drag {{ display: inline-block; background: var(--ok); color: #fff; text-decoration: none; font-weight: 600;
          padding: 12px 22px; border-radius: 6px; cursor: grab; box-shadow: 0 2px 6px rgba(0,0,0,.2); }}
  .dropzone {{ margin: 16px 0; padding: 18px; border: 2px dashed #b8bdc8; border-radius: 8px; text-align: center; }}
  ol {{ padding-left: 22px; }} li {{ margin: 6px 0; }}
  code, kbd {{ background: #eceef2; padding: 1px 6px; border-radius: 4px; font-size: 13px; }}
  .note {{ color: var(--muted); font-size: 14px; }}
</style>
</head>
<body>
<main><div class="card">
  <h1>Auto Child Tasks</h1>
  <p class="sub">Paste a numbered list of child tasks; it adds, starts and finishes all of them on your main task.</p>

  <h2>1. Install (once)</h2>
  <ol>
    <li>Show your bookmarks bar: press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>.</li>
    <li>Drag this green button onto the bookmarks bar:
      <div class="dropzone"><a class="drag" href="{href}" onclick="alert('Drag this button to your bookmarks bar instead of clicking it.'); return false;">Auto Child Tasks</a></div>
    </li>
  </ol>

  <h2>2. Use</h2>
  <ol>
    <li>Open <a href="http://sd-apps_svr/SysDevRequest/programmertask">Programmer Task</a> and log in.</li>
    <li>Click <b>Auto Child Tasks</b> on your bookmarks bar. A panel opens on the right.</li>
    <li>Pick the main task (it must be <b>On-going</b>).</li>
    <li>Paste your child tasks, numbered:<br><code>1. refactored uploading</code><br><code>2. refactored downloading</code></li>
    <li>Check the preview, then click <b>Add, start &amp; finish</b>.</li>
  </ol>
  <p class="note">Target to Start and Target to Finish are set to today (a Sunday start or weekend finish moves to Monday).
  If some tasks fail, only those stay in the box, so clicking the button again retries just them.
  Click the bookmark again to close the panel.</p>
</div></main>
</body>
</html>
"""
(HERE / "install.html").write_text(page, encoding="utf-8")
print(f"install.html written (bookmarklet {len(bookmarklet):,} chars)")
