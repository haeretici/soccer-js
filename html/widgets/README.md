# Widgets

UI panels as **child browser windows** (`window.open`) talking to the match page via `postMessage`.

## Engine Tweakings

```text
widgets/engine_tweakings/
  index.html       # Popup page
  panel.html       # Form markup
  popup.js         # Child: form → postMessage
  parent_bridge.js # Parent: open / focus+resync / close + apply Settings
  protocol.js      # Channel, window name, URL
  bind.js          # loadPersistedAiStrategy only
```

| Action | Result |
|--------|--------|
| Click **Engine Tweakings** | Opens 800×780 popup |
| Click again while open | Focus + **re-push live Settings** (no full reload — avoids wrong defaults) |
| Parent reload / leave | Popup closes |
| Change a control | Parent updates `Settings` immediately |

Serve with `npm run dev` so the popup can `fetch('panel.html')`.
