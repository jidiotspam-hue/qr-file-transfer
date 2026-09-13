# ⚡ Beam — QR File Transfer

Move files between your phone and computer by scanning a QR code. No Bluetooth, no AirDrop, no app install, no cloud upload. Files travel **directly between the two devices** over your local Wi‑Fi via WebRTC.

**Hosted app:** https://jidiotspam-hue.github.io/qr-file-transfer/

```bash
npm install
node server.js
```

Open the printed LAN URL on your computer, scan the QR with your phone's camera, and start sending — in either direction.

## How it works

| Layer | What it does |
|---|---|
| **Signaling** | PeerJS Cloud on the hosted app; Express + `ws` remains available for local-only use. Only WebRTC SDP/ICE metadata is relayed. |
| **Transport** | `RTCDataChannel`, peer‑to‑peer. **File bytes never touch the server.** |
| **Pairing** | The QR encodes the hosted page plus a random, short-lived PeerJS ID. Scanning it joins that browser session. |

The browsers establish a direct connection with public STUN discovery. There is no TURN relay, so particularly restrictive networks may prevent a connection.

The GitHub Pages version uses the public PeerJS broker for pairing metadata. File bytes still travel directly between the two browsers over the encrypted WebRTC data channel and are not uploaded to GitHub or PeerJS.

## Features

- **Any direction** — phone → computer or computer → phone, same UI on both.
- **Multi‑file queue** — drag & drop, browse, or paste (⌘V a screenshot straight into the transfer).
- **Send text & links** — a snippet box for URLs, Wi‑Fi passwords, or code, with one‑tap copy on the far end.
- **Live progress** — per‑file percentage, throughput in MB/s, and ETA.
- **Auto‑save** — optional; received files download automatically.
- **Reconnect** — if the phone locks or backgrounds its tab, the same QR can simply be scanned again.
- **No size or type limits.**
- **Settings panel** — Theme (System/Light/Dark), Density (Compact/Default/Large), Motion (System/Full/Reduced).
- **Keyboard accessible** — focus rings, drop-zone reachable by Tab, live announcements for assistive tech.
- **Offline-first** — QR code bundled locally; works without CDN access.

## Display & Accessibility

The UI is fully responsive and adaptable to user preferences:

- **Theme:** Switch between System, Light, and Dark modes. Settings persist across sessions.
- **Density:** Choose Compact, Default, or Large spacing and text sizes. Touch targets stay at least 44px in all modes.
- **Motion:** Respect system-level reduced-motion preference, or override it with Full or Reduced. Under Reduced, animations collapse to near-instant and decorative motion is hidden.
- **Keyboard navigation:** All controls reachable via Tab. Focus rings visible on keyboard focus. Native radio groups for settings provide arrow-key navigation.
- **Screen readers:** Live regions announce transfer start/complete and text receipt. Progress bars expose `aria-valuenow` as transfers progress. All decorative elements marked `aria-hidden`.

Settings are stored in localStorage and restored on page load. The inline `<head>` script resolves theme/motion settings before first paint, eliminating flash-of-wrong-color.

## Performance notes

Two things dominate throughput, and both are handled explicitly in [`public/app.js`](public/app.js):

- **Backpressure.** The sender checks `RTCDataChannel.bufferedAmount` and stops reading from disk once 8 MB is in flight, resuming on `bufferedamountlow`. Without this, `send()` queues without bound and a large file can take the tab down.
- **Block reads + chunk sizing.** The file is read from disk in 8 MB blocks and pushed out in 256 KB chunks (clamped to `pc.sctp.maxMessageSize`). Far fewer disk round‑trips and event‑loop turns than naive 64 KB `FileReader` chunking.

On the receiving side, chunks are sealed into `Blob`s every 8 MB. Browsers spill Blobs to disk, so JS heap stays flat even on multi‑gigabyte transfers instead of accumulating every chunk in memory.

Measured locally: **64 MB transferred byte‑perfect in 5.6 s (~11.4 MB/s)** with three files queued back‑to‑back.

## Security

- Session IDs are `crypto.randomUUID()`, plus a separate random 16‑hex‑char token required on the signaling WebSocket — the QR URL *is* the shared secret, and guessing the UUID alone isn't enough to join. See [`SECURITY.md`](SECURITY.md) for details and hardening options (HTTPS tunnels, Tailscale, etc).
- A session holds exactly one host and one peer slot; extra joiners are rejected.
- Unpaired sessions (host opened the page but no phone ever scanned) are swept after 5 minutes so they don't accumulate in memory.
- WebRTC data channels are **DTLS‑encrypted end to end** by default.
- The signaling server sees SDP/ICE only — never file contents.
- Received text is rendered via `createTextNode`, never `innerHTML`, so a sender cannot inject markup.

Runs over plain HTTP/WS for LAN simplicity. **Use it on a trusted network; don't expose the port to the internet.**

## Architecture

**No build step, no dependencies beyond Express and ws.** The app is three files:

- `server.js` — Express + WebSocket signaling server. Generates QR URLs, relays WebRTC metadata, reaps stale sessions.
- `public/app.js` — All client logic: QR rendering, WebRTC peer setup, file I/O, UI state, settings persistence. ~700 lines, vanilla JS.
- `public/style.css` — Responsive layout using CSS custom properties for theming and density. ~600 lines.
- `public/index.html` — Semantic HTML, no template engine.

The QR library (`qrcode.min.js`) is bundled locally so the app works offline.

## Customization

- **Max file size** — none enforced; add a check in `sendFile()` if you want one.
- **Allowed file types** — none enforced; filter in `enqueue()` if you want a whitelist.
- **Port** — override with the `PORT` env var (default 6798).
- **Theme colors** — edit the `--text`, `--bg`, `--accent` tokens in `style.css` under `:root` and `:root[data-theme="dark"]`.
- **LAN address detection** — `getLanIp()` in `server.js` prefers private-range IPv4, falls back to Bonjour hostname (handles hotspots).

## Testing

```bash
npm start
# Opens http://MacBook-Pro.local:6798

# In another terminal, check the API:
curl -X POST http://localhost:6798/api/session | jq
```

Performance benchmarks are in [`BENCHMARKS.md`](BENCHMARKS.md) and run via `node benchmarks.js`.
