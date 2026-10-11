#!/usr/bin/env python3
"""Bundle every connector component preview declared in fixtures/<app>.ts into out/ and write a gallery index.

Each fixtures module exports `previews` (component, title, inputs) and `handle(resourceType, action, args)`.
Usage: python3 dev/component-preview/build.py [app ...]   then serve dev/component-preview/out.
"""
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
OUT = HERE / "out"
UI = Path("/Users/jiantang/github/ui")
ESBUILD = UI / "node_modules/.bin/esbuild"
NODE_PATH = f"{UI}/node_modules:/tmp/connector-reviews/deps/node_modules"
# One React for the whole bundle: a stray ~/node_modules/react would otherwise win for files under the repo.
PIN = [f"--alias:{p}={UI}/node_modules/{p}" for p in ("react", "react-dom")]
APPS = ["confluence", "pagerduty", "datadog", "salesforce", "hubspot", "stripe", "box", "xero", "mixpanel"]

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<link rel="stylesheet" href="{id}.css"><style>
body{{margin:0}} #preview-log{{position:fixed;left:0;right:0;bottom:0;max-height:96px;overflow:auto;background:#0f172aee;color:#cbd5e1;
font:11px/1.5 ui-monospace,Menlo,monospace;padding:4px 10px;z-index:99999}} #preview-log .k-emit{{color:#86efac}}
#preview-log .k-error{{color:#fca5a5}} #preview-log .k-openUrl{{color:#93c5fd}} #root{{padding-bottom:100px}}
</style></head><body><div id="root"></div><div id="preview-log"></div><script src="{id}.js"></script></body></html>"""


def previews_of(app: str) -> list:
    """Read the `previews` array from the fixtures module by bundling it for node."""
    src = HERE / "fixtures" / f"{app}.ts"
    probe = OUT / "_probe" / f"{app}.cjs"
    probe.parent.mkdir(parents=True, exist_ok=True)
    entry = OUT / "_probe" / f"{app}-entry.ts"
    entry.write_text(f'import {{ previews }} from "{src}";\nconsole.log(JSON.stringify(previews));\n')
    run([str(ESBUILD), str(entry), "--bundle", "--platform=node", f"--outfile={probe}", "--log-level=error"])
    return json.loads(subprocess.check_output(["node", str(probe)], text=True))


def run(cmd: list) -> None:
    subprocess.run(cmd, check=True, env={**os.environ, "NODE_PATH": NODE_PATH})


def build(app: str) -> list:
    items = []
    for i, p in enumerate(previews_of(app)):
        comp = p["component"]
        entry = REPO / app / "manifests/ui/components" / comp / f"{comp}.tsx"
        pid = f"{app}-{comp}-{i}"
        src = OUT / "_src" / f"{pid}.tsx"
        setup = OUT / "_src" / f"{pid}-setup.ts"
        src.parent.mkdir(parents=True, exist_ok=True)
        # Setup runs first (import order) so the component's module-level `window.tangram` read sees the mock.
        setup.write_text(
            f'import {{ install }} from "{HERE / "mock-tangram"}";\n'
            f'import {{ handle }} from "{HERE / "fixtures" / app}";\n'
            f"install(handle, {json.dumps(p.get('inputs', {}))});\n"
        )
        src.write_text(
            f'import "./{pid}-setup";\n'
            'import { createRoot } from "react-dom/client";\n'
            'import { createElement } from "react";\n'
            f'import Component from "{entry}";\n'
            'createRoot(document.getElementById("root")!).render(createElement(Component));\n'
        )
        run([str(ESBUILD), str(src), "--bundle", "--format=iife", "--platform=browser", "--jsx=automatic",
             "--loader:.css=css", f"--outfile={OUT / (pid + '.js')}", "--log-level=error", *PIN])
        (OUT / f"{pid}.html").write_text(PAGE.format(title=html.escape(p.get("title", pid)), id=pid))
        items.append({"id": pid, "app": app, "component": comp, "title": p.get("title", comp),
                      "inputs": p.get("inputs", {}), "height": p.get("height", 640)})
        print(f"built {pid}")
    return items


def index(items: list) -> None:
    by_app = {}
    for it in items:
        by_app.setdefault(it["app"], []).append(it)
    nav = " · ".join(f'<a href="#{a}">{a}</a>' for a in by_app)
    sections = []
    for app, its in by_app.items():
        cards = "".join(
            f'<figure><figcaption><b>{html.escape(it["component"])}</b> — {html.escape(it["title"])}'
            f' <a href="{it["id"]}.html" target="_blank">open</a>'
            f'<code>{html.escape(json.dumps(it["inputs"]))}</code></figcaption>'
            f'<iframe src="{it["id"]}.html" style="height:{it["height"]}px" loading="lazy"></iframe></figure>'
            for it in its)
        sections.append(f'<section id="{app}"><h2>{app}</h2><div class="grid">{cards}</div></section>')
    (OUT / "index.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8"><title>Connector component previews</title>
<style>body{{font:14px -apple-system,Segoe UI,sans-serif;margin:0;background:#eef0f3;color:#1f2328}}
header{{position:sticky;top:0;background:#fff;padding:12px 24px;border-bottom:1px solid #d0d7de;z-index:2}}
header a{{color:#0969da;text-decoration:none}} section{{padding:8px 24px 24px}} h2{{text-transform:capitalize;margin:16px 0 8px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(720px,1fr));gap:20px}}
figure{{margin:0;background:#fff;border-radius:10px;box-shadow:0 1px 2px #0001,0 0 0 1px #0000000f;overflow:hidden}}
figcaption{{padding:8px 12px;border-bottom:1px solid #eaeef2;font-size:13px}} figcaption a{{float:right;color:#0969da}}
figcaption code{{display:block;color:#57606a;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
iframe{{width:100%;border:0;display:block}}</style></head><body>
<header><b>Connector component previews</b> — mock data, actions logged at the bottom of each frame · {nav}</header>
{"".join(sections)}</body></html>""")


if __name__ == "__main__":
    apps = sys.argv[1:] or [a for a in APPS if (HERE / "fixtures" / f"{a}.ts").exists()]
    OUT.mkdir(exist_ok=True)
    all_items = []
    for a in apps:
        all_items += build(a)
    # keep previously built apps in the index when building a subset
    manifest = OUT / "_items.json"
    known = {it["id"]: it for it in (json.loads(manifest.read_text()) if manifest.exists() else [])}
    for it in all_items:
        known[it["id"]] = it
    for stale in [k for k, v in known.items() if v["app"] in apps and k not in {i["id"] for i in all_items}]:
        known.pop(stale)
    ordered = sorted(known.values(), key=lambda it: (APPS.index(it["app"]) if it["app"] in APPS else 99, it["id"]))
    manifest.write_text(json.dumps(ordered))
    index(ordered)
    print(f"index: {OUT / 'index.html'} ({len(ordered)} previews)")
