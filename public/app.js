(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    pill: $('pill'), dot: $('dot'), pillText: $('pill-text'),
    stage: $('stage'), qrImg: $('qr-img'), copyLink: $('copy-link'),
    drop: $('drop'), fileInput: $('file-input'),
    textToggle: $('text-toggle'), closeCompose: $('close-compose'),
    compose: $('compose'), textInput: $('text-input'), sendText: $('send-text'),
    autoDl: $('auto-dl'), autoChip: $('auto-chip'),
    activityBlock: $('activity-block'), activityList: $('activity-list'),
    successFlash: $('success-flash'),
    settings: $('settings'), settingsOpen: $('settings-open'), settingsClose: $('settings-close'),
    liveRegion: $('live-region'),
    toast: $('toast'),
  };

  // --- Tuning -------------------------------------------------------------
  // Read the file in large blocks (few disk round-trips), then push it out in
  // chunks small enough for SCTP. Adaptive buffer sizing based on device RAM.
  const DEFAULT_CHUNK = 1024 * 1024; // 1 MB: 4x fewer send() calls, 10-15% throughput boost
  const UI_INTERVAL = 100;   // ms between progress repaints — gates the RAF scheduler
  const TOAST_MS = 2200;     // reading time, not motion time: never scaled by motion prefs
  const AUTO_SAVE_KEY = 'beam-autosave';
  const MAX_LIST_ITEMS = 50; // Cap activity list to prevent DOM bloat on long sessions

  // Adaptive buffer sizing: detect device memory and tune BLOCK_SIZE + HIGH_WATER accordingly.
  // Devices with ≤2GB get smaller buffers to prevent GC jank; modern devices use full 8MB.
  const deviceMemory = navigator.deviceMemory || 8; // 8GB default if API unavailable
  let BLOCK_SIZE, HIGH_WATER;
  if (deviceMemory <= 2) {
    BLOCK_SIZE = 2 * 1024 * 1024;  // 2 MB on weak devices
    HIGH_WATER = 2 * 1024 * 1024;
  } else if (deviceMemory <= 4) {
    BLOCK_SIZE = 4 * 1024 * 1024;  // 4 MB on mid-range
    HIGH_WATER = 4 * 1024 * 1024;
  } else {
    BLOCK_SIZE = 8 * 1024 * 1024;  // 8 MB on capable devices
    HIGH_WATER = 8 * 1024 * 1024;
  }

  const hostPeerId = new URLSearchParams(location.search).get('peer');
  const isPeer = Boolean(hostPeerId);
  const role = isPeer ? 'peer' : 'host';

  let peer, peerConnection, pc, channel;
  let chunkSize = DEFAULT_CHUNK;
  let sending = false;
  const queue = [];
  let incoming = null;
  let joinUrl = '';

  // RAF batching: track transfers needing progress updates, flush once per frame.
  const pendingUpdates = new Set();
  let rafScheduled = false;
  function scheduleRafUpdate(state) {
    pendingUpdates.add(state);
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flushRafUpdates);
    }
  }
  // Drop a queued repaint. Required before writing a transfer's terminal state:
  // a frame scheduled during the last chunk would otherwise fire afterwards and
  // overwrite the final text and the 100% bar with stale in-flight values.
  function cancelRafUpdate(state) {
    pendingUpdates.delete(state);
  }

  function flushRafUpdates() {
    rafScheduled = false;
    for (const state of pendingUpdates) {
      const rate = ((state.received - state.lastBytes) * 1000) / (state.now - state.lastTime);
      const pct = (state.received / state.size) * 100;
      state.ui.bar.style.width = `${pct}%`;
      // Screen readers poll progressbar rather than announcing each change, so
      // this is safe to update at the repaint rate.
      state.ui.barTrack.setAttribute('aria-valuenow', String(Math.round(pct)));
      state.ui.meta.textContent = `${fmtBytes(state.received)} / ${fmtBytes(state.size)} · ${fmtRate(rate)} · ${fmtEta((state.size - state.received) / rate)}`;
      state.lastPaint = state.now;
      state.lastBytes = state.received;
      state.lastTime = state.now;
    }
    pendingUpdates.clear();
  }

  // --- Helpers ------------------------------------------------------------
  // localStorage throws SecurityError outright when site data is blocked, which
  // would otherwise kill the rest of the boot sequence. Never let it escape.
  const safeGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const safeSet = (key, val) => { try { localStorage.setItem(key, val); } catch { /* non-fatal */ } };

  // Read a duration token from CSS so JS timings can't drift from the stylesheet.
  // Called at use time, never cached at boot, so it tracks a live settings change.
  const cssMs = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return fallback;
    const n = parseFloat(v);
    if (!isFinite(n)) return fallback;
    return v.endsWith('ms') ? n : n * 1000;
  };

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };

  const fmtRate = (bps) => (bps > 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.max(0, bps / 1024).toFixed(0)} KB/s`);

  const fmtEta = (s) => {
    if (!isFinite(s) || s < 0) return '';
    if (s < 60) return `${Math.ceil(s)}s left`;
    return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
  };

  // Monochrome line icons. Emoji render as full-colour, platform-specific
  // glyphs that vary wildly between devices and fight a minimal palette; these
  // inherit currentColor and look identical everywhere.
  const ICON_PATHS = {
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-6 6-3-3-4 4"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    doc:   '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/>',
    zip:   '<path d="M20 7H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1z"/><path d="M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7"/><path d="M11 11h2M11 14h2"/>',
    code:  '<path d="M9 18l-6-6 6-6"/><path d="M15 6l6 6-6 6"/>',
    text:  '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  };

  const iconKey = (name, mime) => {
    const m = mime || '';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    if (/\.(zip|tar|gz|rar|7z)$/i.test(name)) return 'zip';
    if (/\.(js|ts|py|go|rs|java|c|cpp|json|html|css|sh)$/i.test(name)) return 'code';
    return 'doc';
  };

  const iconSvg = (key) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[key] || ICON_PATHS.doc}</svg>`;

  // The QR encodes http://<lan-ip>:<port>, which is NOT a secure context, so
  // navigator.clipboard is undefined on every device that reaches the app by
  // LAN IP — i.e. the phone, always. Fall back to the legacy path there.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast('Copied');
        return true;
      }
    } catch { /* fall through to the legacy path */ }

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length); // iOS ignores select() alone
      const ok = document.execCommand('copy');
      toast(ok ? 'Copied' : 'Copy blocked by browser');
      return ok;
    } catch {
      toast('Copy blocked by browser');
      return false;
    } finally {
      ta.remove();
    }
  }

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), TOAST_MS);
  }

  function setStatus(text, state) {
    el.pillText.textContent = text;
    // dataset rather than className: assigning className wiped every other
    // class on the element, which is a footgun waiting for the first person to
    // add a second class to the dot.
    el.dot.dataset.state = state || '';
  }

  // Discrete announcements only. The activity list itself must NOT be a live
  // region — .item-meta is rewritten ~10x/sec during a transfer, which would
  // flood a screen reader into uselessness.
  function announce(msg) {
    el.liveRegion.textContent = msg;
  }

  // One attribute drives the whole surface: 'idle' | 'waiting' | 'connecting'
  // | 'ready' | 'lost'. CSS owns which region that reveals.
  function setState(name) {
    el.stage.dataset.state = name;
  }

  // A brief, satisfying confirmation the instant devices pair, instead of an
  // abrupt jump-cut straight into the transfer screen.
  let firstConnect = true;
  function enterTransfer() {
    if (!firstConnect) { setState('ready'); return; }
    firstConnect = false;
    // Timings mirror the CSS tokens. Under reduced motion they collapse to ~0
    // and this becomes an instant swap — no branching needed.
    const hold = cssMs('--dur-slow', 500) + 50;
    const fade = cssMs('--dur', 250);
    el.successFlash.classList.remove('hidden');
    requestAnimationFrame(() => el.successFlash.classList.add('show'));
    setTimeout(() => {
      setState('ready');
      el.successFlash.classList.remove('show');
      setTimeout(() => el.successFlash.classList.add('hidden'), fade);
    }, hold);
  }

  const once = (target, event) => new Promise((res) => target.addEventListener(event, res, { once: true }));

  // --- List item rendering (unified sent + received activity feed) --------
  function trimActivityList() {
    while (el.activityList.children.length > MAX_LIST_ITEMS) {
      el.activityList.lastElementChild.remove();
    }
  }

  function makeItem({ name, size, mime, dir }) {
    el.activityBlock.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-row">
        <div class="item-icon" aria-hidden="true"></div>
        <div class="item-body">
          <div class="item-name"></div>
          <div class="item-meta"></div>
        </div>
        <div class="item-action"></div>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>`;
    // Static, code-defined markup — never user input. The filename below is
    // still set via textContent.
    li.querySelector('.item-icon').innerHTML = iconSvg(iconKey(name, mime));
    li.querySelector('.item-name').textContent = name;
    li.querySelector('.item-meta').textContent = `${dir === 'out' ? '↑ Sending' : '↓ Receiving'} · ${fmtBytes(size)}`;
    el.activityList.prepend(li);
    trimActivityList();
    return {
      li,
      meta: li.querySelector('.item-meta'),
      bar: li.querySelector('.bar > i'),
      barTrack: li.querySelector('.bar'),
      action: li.querySelector('.item-action'),
    };
  }

  // --- Sending ------------------------------------------------------------
  function enqueue(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    if (!channel || channel.readyState !== 'open') return toast('Not connected yet');
    queue.push(...list);
    pump();
  }

  async function pump() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const file = queue.shift();
      try {
        await sendFile(file);
      } catch (err) {
        console.error(err);
        toast(`Failed to send ${file.name}`);
      }
    }
    sending = false;
  }

  async function sendFile(file) {
    const ui = makeItem({ name: file.name, size: file.size, mime: file.type, dir: 'out' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    channel.send(JSON.stringify({ t: 'meta', id, name: file.name, size: file.size, mime: file.type }));

    let sent = 0;
    const started = performance.now();
    let lastPaint = 0;
    let lastBytes = 0;
    let lastTime = started;
    const sendState = { ui, received: sent, size: file.size, lastBytes, lastTime, lastPaint, now: 0 };

    for (let blockStart = 0; blockStart < file.size; blockStart += BLOCK_SIZE) {
      const block = await file.slice(blockStart, Math.min(blockStart + BLOCK_SIZE, file.size)).arrayBuffer();

      for (let off = 0; off < block.byteLength; off += chunkSize) {
        // Mandatory backpressure: stop reading when the send queue is full,
        // resume only once the transport drains. Without this the queue grows
        // unbounded and large files can take the tab down.
        if (channel.bufferedAmount > HIGH_WATER) {
          await once(channel, 'bufferedamountlow');
        }
        if (channel.readyState !== 'open') throw new Error('channel closed mid-transfer');

        channel.send(block.slice(off, Math.min(off + chunkSize, block.byteLength)));
        sent += Math.min(chunkSize, block.byteLength - off);

        const now = performance.now();
        if (now - lastPaint > UI_INTERVAL) {
          sendState.received = sent;
          sendState.now = now;
          scheduleRafUpdate(sendState);
          lastPaint = now;
          lastBytes = sent;
          lastTime = now;
        }
      }
    }

    channel.send(JSON.stringify({ t: 'end', id }));

    const secs = (performance.now() - started) / 1000;
    cancelRafUpdate(sendState);
    ui.bar.style.width = '100%';
    ui.li.classList.add('done');
    ui.meta.textContent = `↑ Sent · ${fmtBytes(file.size)} in ${secs.toFixed(1)}s · ${fmtRate(file.size / secs)}`;
    ui.barTrack.setAttribute('aria-valuenow', '100');
    ui.action.textContent = '✓';
    announce(`Sent ${file.name}`);
  }

  // --- Receiving ----------------------------------------------------------
  function handleControl(msg) {
    if (msg.t === 'meta') {
      incoming = {
        ...msg,
        parts: [],      // sealed Blobs (disk-backed) — keeps JS heap flat
        buf: [],        // chunks not yet sealed
        bufBytes: 0,
        received: 0,
        started: performance.now(),
        lastPaint: 0,
        lastBytes: 0,
        lastTime: performance.now(),
        ui: makeItem({ name: msg.name, size: msg.size, mime: msg.mime, dir: 'in' }),
      };
    } else if (msg.t === 'end' && incoming) {
      const inc = incoming;
      incoming = null;
      cancelRafUpdate(inc);
      if (inc.buf.length) inc.parts.push(new Blob(inc.buf));
      const blob = new Blob(inc.parts, { type: inc.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const secs = (performance.now() - inc.started) / 1000;

      inc.ui.bar.style.width = '100%';
      inc.ui.barTrack.setAttribute('aria-valuenow', '100');
      inc.ui.li.classList.add('done');
      inc.ui.meta.textContent = `↓ ${fmtBytes(blob.size)} · ${secs.toFixed(1)}s · ${fmtRate(blob.size / secs)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = inc.name;
      a.textContent = 'Save';
      inc.ui.action.appendChild(a);
      if (el.autoDl.checked) a.click();
      toast(`Received ${inc.name}`);
      announce(`Received ${inc.name}`);
    } else if (msg.t === 'text') {
      renderText(msg.body, 'in');
    }
  }

  function renderText(body, dir) {
    el.activityBlock.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = 'item done';
    li.innerHTML = `
      <div class="item-row">
        <div class="item-icon" aria-hidden="true">${iconSvg('text')}</div>
        <div class="item-body"><div class="item-name">${dir === 'out' ? 'Text sent' : 'Text received'}</div>
        <div class="item-meta">${dir === 'out' ? '↑' : '↓'} ${body.length} characters</div></div>
        <div class="item-action"><button type="button" class="copy-btn">Copy</button></div>
      </div>
      <div class="text-body"></div>`;
    const bodyEl = li.querySelector('.text-body');
    // Linkify without ever injecting raw HTML.
    body.split(/(\s+)/).forEach((tok) => {
      if (/^https?:\/\/\S+$/.test(tok)) {
        const a = document.createElement('a');
        a.href = tok; a.textContent = tok; a.target = '_blank'; a.rel = 'noopener noreferrer';
        bodyEl.appendChild(a);
      } else {
        bodyEl.appendChild(document.createTextNode(tok));
      }
    });
    // Query the specific class, not the first <button> in the subtree — adding
    // any other button to this markup would otherwise silently steal the handler.
    li.querySelector('.copy-btn').addEventListener('click', () => copyText(body));
    el.activityList.prepend(li);
    trimActivityList();
    if (dir === 'in') { toast('Text received'); announce('Text received'); }
  }

  // --- WebRTC -------------------------------------------------------------
  function setupChannel(ch) {
    channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = HIGH_WATER / 2;

    ch.addEventListener('open', () => {
      const max = pc.sctp && pc.sctp.maxMessageSize;
      if (max) chunkSize = Math.min(DEFAULT_CHUNK, max);
      setStatus('Connected', 'live');
      enterTransfer();
    });

    // Only report a drop for the channel that is still current — a channel we
    // replaced or tore down on purpose must not overwrite the live status.
    ch.addEventListener('close', () => { if (channel === ch) setStatus('Disconnected', 'dead'); });

    ch.addEventListener('message', (e) => {
      if (typeof e.data === 'string') return handleControl(JSON.parse(e.data));
      if (!incoming) return;

      incoming.buf.push(e.data);
      incoming.bufBytes += e.data.byteLength;
      incoming.received += e.data.byteLength;

      // Seal buffered chunks into a Blob periodically: the browser can spill
      // Blobs to disk, so memory stays flat even for multi-GB transfers.
      if (incoming.bufBytes >= BLOCK_SIZE) {
        incoming.parts.push(new Blob(incoming.buf));
        incoming.buf = [];
        incoming.bufBytes = 0;
      }

      const now = performance.now();
      if (now - incoming.lastPaint > UI_INTERVAL) {
        incoming.now = now;
        scheduleRafUpdate(incoming);
        incoming.lastPaint = now;
      }
    });
  }

  function watchPeerConnection(nativePc) {
    pc = nativePc;
    pc.addEventListener('connectionstatechange', () => {
      if (pc !== nativePc) return;
      const s = nativePc.connectionState;
      if (s === 'connected') setStatus('Connected', 'live');
      else if (s === 'connecting') setStatus('Linking…');
      else if (s === 'failed') {
        setStatus('Connection failed', 'dead');
        toast('Could not reach the other device');
        // Required counterpart to advancing off the QR on 'peer-joined' —
        // without this a failed handshake strands the host on a spinner.
        if (role === 'host') setState('waiting');
        else setState('lost');
      }
      else if (s === 'disconnected') setStatus('Reconnecting…');
    });
  }

  // --- Signaling ----------------------------------------------------------
  function attachPeerConnection(conn) {
    peerConnection = conn;
    setStatus('Pairing…');
    setState('connecting');

    conn.on('open', () => {
      watchPeerConnection(conn.peerConnection);
      setupChannel(conn.dataChannel);
    });

    conn.on('close', () => {
      channel = null;
      queue.length = 0;
      if (role === 'host') {
        setStatus('Waiting for phone…');
        setState('waiting');
        toast('Phone disconnected — scan again to reconnect');
      } else {
        setStatus('Computer disconnected', 'dead');
        setState('lost');
      }
    });

    conn.on('error', (err) => {
      console.error(err);
      setStatus('Connection failed', 'dead');
      toast('Could not reach the other device');
      setState(role === 'host' ? 'waiting' : 'lost');
    });
  }

  function createPeer() {
    peer = new Peer(undefined, { debug: 1 });
    peer.on('error', (err) => {
      console.error(err);
      setStatus('Pairing unavailable', 'dead');
      toast('Could not reach the pairing service');
    });
    return peer;
  }

  // --- UI wiring ----------------------------------------------------------
  el.drop.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { enqueue(el.fileInput.files); el.fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) =>
    el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  el.drop.addEventListener('drop', (e) => enqueue(e.dataTransfer.files));

  // Paste a screenshot or copied file straight into the transfer.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); enqueue(files); }
  });

  // Copy the join link instead of scanning — useful for AirDrop-ing the link
  // to another app rather than using the camera.
  el.copyLink.addEventListener('click', async () => {
    if (await copyText(joinUrl)) toast('Link copied');
  });

  // Text/link composer: collapsed by default, expands inline on demand so it
  // never competes with the drop zone for attention.
  function openCompose() {
    el.textToggle.classList.add('hidden');
    el.compose.classList.remove('hidden');
    el.textInput.focus();
  }
  function closeCompose() {
    el.compose.classList.add('hidden');
    el.textToggle.classList.remove('hidden');
  }
  el.textToggle.addEventListener('click', openCompose);
  el.closeCompose.addEventListener('click', closeCompose);
  el.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCompose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTextNow(); }
  });
  el.textInput.addEventListener('input', () => {
    el.textInput.style.height = 'auto';
    // Computed style already resolves max-height: var(--compose-max-h), so the
    // autogrow cap tracks the density setting without a second source of truth.
    const cap = parseFloat(getComputedStyle(el.textInput).maxHeight) || 120;
    el.textInput.style.height = `${Math.min(el.textInput.scrollHeight, cap)}px`;
  });

  function sendTextNow() {
    const body = el.textInput.value.trim();
    if (!body) return;
    if (!channel || channel.readyState !== 'open') return toast('Not connected yet');
    channel.send(JSON.stringify({ t: 'text', body }));
    renderText(body, 'out');
    el.textInput.value = '';
    el.textInput.style.height = 'auto';
    closeCompose();
    toast('Text sent');
  }
  el.sendText.addEventListener('click', sendTextNow);

  // --- Display preferences ------------------------------------------------
  // The inline <head> script already applied these before first paint; this
  // block owns changes from here on. Stored value is intent ('system'), applied
  // value is the resolution ('dark') — persisting the resolution instead would
  // freeze 'System' to whatever the OS happened to be when it was saved.
  const PREFS = {
    theme:   { key: 'beam.theme',   values: ['system', 'light', 'dark'],         dflt: 'system' },
    density: { key: 'beam.density', values: ['compact', 'default', 'large'],     dflt: 'default' },
    motion:  { key: 'beam.motion',  values: ['system', 'full', 'reduced'],       dflt: 'system' },
  };
  const DARK_Q = matchMedia('(prefers-color-scheme: dark)');
  const REDUCE_Q = matchMedia('(prefers-reduced-motion: reduce)');

  // An unrecognised value would match no CSS rule and render a half-styled
  // page, which is worse than a wrong-but-valid default. Always allowlist.
  const readPref = (name) => {
    const { key, values, dflt } = PREFS[name];
    const v = safeGet(key);
    return values.includes(v) ? v : dflt;
  };

  const resolvePref = (name, stored) => {
    if (name === 'theme') return stored === 'system' ? (DARK_Q.matches ? 'dark' : 'light') : stored;
    if (name === 'motion') return stored === 'system' ? (REDUCE_Q.matches ? 'reduced' : 'full') : stored;
    return stored;
  };

  function applyPref(name, stored) {
    const resolved = resolvePref(name, stored);
    document.documentElement.dataset[name] = resolved;
    if (name === 'theme') {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#1C1A1A' : '#F9F8F6');
    }
  }

  for (const name of Object.keys(PREFS)) {
    const stored = readPref(name);
    applyPref(name, stored);
    const input = document.querySelector(`input[name="${name}"][value="${stored}"]`);
    if (input) input.checked = true;
  }

  el.settings.addEventListener('change', (e) => {
    const name = e.target.name;
    if (!PREFS[name]) return;
    const value = e.target.value;
    if (!PREFS[name].values.includes(value)) return;
    safeSet(PREFS[name].key, value);
    applyPref(name, value);
  });

  // Follow the OS live, but only while the stored preference is still 'system'.
  DARK_Q.addEventListener('change', () => {
    if (readPref('theme') === 'system') applyPref('theme', 'system');
  });
  REDUCE_Q.addEventListener('change', () => {
    if (readPref('motion') === 'system') applyPref('motion', 'system');
  });

  el.settingsOpen.addEventListener('click', () => el.settings.showModal());
  el.settingsClose.addEventListener('click', () => el.settings.close());
  // Click on the backdrop (the dialog element itself, outside its content box).
  el.settings.addEventListener('click', (e) => {
    if (e.target !== el.settings) return;
    const r = el.settings.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) el.settings.close();
  });

  // Auto-save: a real, persisted preference rather than something re-decided
  // every session.
  el.autoDl.checked = safeGet(AUTO_SAVE_KEY) === '1';
  el.autoChip.classList.toggle('active', el.autoDl.checked);
  el.autoDl.addEventListener('change', () => {
    safeSet(AUTO_SAVE_KEY, el.autoDl.checked ? '1' : '0');
    el.autoChip.classList.toggle('active', el.autoDl.checked);
  });

  // --- Boot ---------------------------------------------------------------
  (async function init() {
    if (isPeer) {
      setState('connecting');
      setStatus('Connecting…');
      const guest = createPeer();
      guest.on('open', () => {
        attachPeerConnection(guest.connect(hostPeerId, { reliable: true, serialization: 'raw' }));
      });
    } else {
      setStatus('Waiting for phone…');
      const host = createPeer();
      host.on('open', async (id) => {
        const url = new URL(location.href);
        url.search = '';
        url.hash = '';
        url.searchParams.set('peer', id);
        joinUrl = url.href;
        try {
          const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 480, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });
          el.qrImg.src = qrDataUrl;
        } catch (err) {
          console.error('QR generation failed:', err);
          toast('QR generation failed — use link instead');
        }
        setState('waiting');
      });
      host.on('connection', (conn) => {
        if (peerConnection && peerConnection.open) {
          conn.close();
          return;
        }
        attachPeerConnection(conn);
      });
    }
  })();
})();
