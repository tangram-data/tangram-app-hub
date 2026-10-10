# Connector component previews

Renders every connector UI component in a browser against fixture data — no Tangram, no vendor accounts.

```bash
python3 dev/component-preview/build.py            # all apps with fixtures (or: build.py stripe box)
cd dev/component-preview/out && python3 -m http.server 8765   # open http://localhost:8765/
```

- `mock-tangram.ts` stands in for the sandbox shell's `window.tangram` (promise `getInputs`, `onInput` on init,
  `performAction` → fixtures with a 250 ms delay, `emit`/`openUrl` logged in the strip at the bottom of each frame).
  `window.previewInputs({...})` in a frame's console pushes new inputs (repeat the same object to simulate a token renewal).
- `fixtures/<app>.ts` exports `previews` (component, title, inputs, optional height) and
  `handle(resourceType, action, args)` returning vendor-shaped JSON; throw `new UpstreamError(status, body)` for errors.
  Writes are not confirmation-gated here — the real host shows the confirm dialog.
