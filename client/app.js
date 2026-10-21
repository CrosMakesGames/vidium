/* Cinebyte - custom vidsrc-based player demo
 * Modes:
 *  - self-hosted: page served by server.js; calls same-origin /resolve
 *  - injected demo: ?data=<base64 resolve JSON> (fresh mint, short-lived)
 *  - mock: ?mock=1 or resolve failure -> public test streams so every feature works
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var shell = $('player-shell');
  var MOCK_STREAMS = [
    { label: 'Server 1', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', kind: 'hls' },
    { label: 'Server 2', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8', kind: 'hls' },
    { label: 'Server 3', url: 'https://test-streams.mux.dev/tos_ismc/main.m3u8', kind: 'hls' }
  ];
  var MOCK_SUBS = [
    { lang: 'English (demo)', code: 'en', url: '',
      srtB64: btoa('1\n00:00:02,000 --> 00:00:06,500\nCustom player demo - subtitles render from SRT.\n\n2\n00:00:07,000 --> 00:00:11,000\nSize, background and sync are adjustable in the CC panel.\n') },
    { lang: 'Japanese (demo)', code: 'ja', url: '',
      srtB64: btoa('1\n00:00:02,000 --> 00:00:06,500\nTest subtitle track - Japanese.\n\n2\n00:00:07,000 --> 00:00:11,000\nSwitch languages in the CC panel.\n') }
  ];

  var state = {
    route: Router.parseLocation(),
    data: null,            // resolve JSON: {servers, meta, subs}
    mode: 'unknown',       // 'live' | 'injected' | 'mock'
    serverIdx: 0,
    hls: null,
    switching: false,
    audioFix: null, actx: null,
    subManagers: {}, subLang: null, subStyle: (function () {
      try { var st = JSON.parse(localStorage.getItem('cinebyte_sub_style')); if (st && st.fontSize) return st; } catch (e) {}
      return { fontSize: 1, bgOpacity: 0, bottomOffset: 64, color: '#ffffff', fontWeight: '700', edge: 'outline', letterSpacing: 0 };
    })(),
    autoHideTimer: null,
    seeking: false,
    endedOnce: false,
    readyToken: 0
  };

  /* ---------- helpers ---------- */
  function toast(msg, ms) { UIKit.toast(msg, ms, $('toast-host')); }
  function setNote(t) { try { console.info('[cinebyte]', t); } catch (e) {} }
  function escHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function flash(text) {
    var f = $('center-flash');
    f.textContent = text; f.classList.add('on');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { f.classList.remove('on'); }, 420);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function showUI(on) {
    shell.classList.toggle('hide-ui', on === false && !video.paused);
    shell.classList.toggle('show-ui', on !== false);
  }
  function pokeUI() {
    showUI(true);
    clearTimeout(state.autoHideTimer);
    if (!video.paused) state.autoHideTimer = setTimeout(function () { showUI(false); }, 2800);
  }
  var clickTimer = null;
  video.addEventListener('click', function () {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(function () {
      clickTimer = null;
      if (video.paused) video.play().catch(function () {}); else video.pause();
    }, 240);
  });
  video.addEventListener('dblclick', function (e) {
    var r = video.getBoundingClientRect();
    var fwd = (e.clientX - r.left) > r.width / 2;
    video.currentTime = Math.max(0, Math.min(video.duration || 1e9, video.currentTime + (fwd ? 10 : -10)));
    flash(fwd ? '+10s' : '-10s');
  });

  var cursorTimer = null;
  ['mousemove', 'mousedown', 'touchstart'].forEach(function (ev) {
    shell.addEventListener(ev, function () {
      shell.classList.remove('cursor-none');
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(function () {
        if (!video.paused && !openPanel) shell.classList.add('cursor-none');
      }, 5000);
    });
  });
  shell.addEventListener('mouseleave', function () {
    shell.classList.remove('cursor-none');
    clearTimeout(cursorTimer);
  });

  /* ---------- data acquisition ---------- */
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }
  function fetchResolveJson() {
    if (window.__CINEBYTE_DATA__) return Promise.resolve(window.__CINEBYTE_DATA__);
    var raw = qs('data');
    if (raw) {
      try { return Promise.resolve(JSON.parse(b64ToUtf8(raw))); }
      catch (e) { toast('Injected data was unreadable, falling back'); }
    }
    var base = qs('resolve') || '';
    var url = base + '/resolve?type=' + state.route.type + '&id=' + state.route.tmdbId +
      '&season=' + state.route.season + '&episode=' + state.route.episode;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 25000);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('resolve HTTP ' + r.status);
      return r.json();
    });
  }
  function isMockWanted() { return qs('mock') === '1'; }

  /* ---------- meta + chrome ---------- */
  function currentEpisode(meta) {
    if (!meta || state.route.type !== 'tv') return null;
    var eps = meta.episodes || [];
    return eps[state.route.episode - 1] || null;
  }
  function applyMeta(meta) {
    meta = meta || state.meta || null;
    var title = (meta && meta.title) || ($('media-title').textContent !== 'Loading' ? $('media-title').textContent : 'Loading');
    var epTag = state.route.type === 'tv' ? ('S' + state.route.season + 'E' + state.route.episode) : '';
    $('media-title').textContent = title + (epTag ? ' - ' + epTag : '');
    $('media-sub').textContent = '';
    if (title && title !== 'Loading') document.title = title + (epTag ? ' - ' + epTag : '') + ' - Vidium';
    if (state.route.type === 'tv') { $('btn-next').hidden = false; $('btn-episodes').hidden = false; }
  }

  /* ---------- live stream token: browser fetches its own generate.php JWT ---------- */
  function streamUrlWithToken(server) {
    if (!server || !server.url) return null;
    if (state.mode === 'mock') return server.url;
    var host = new URL(server.url).origin;
    return fetch(host + '/generate.php', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        var tok = (txt || '').trim();
        if (tok && tok.indexOf('eyJ') === 0) {
          return server.url + (server.url.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(tok);
        }
        throw new Error('generate.php refused');
      })
      .catch(function () {
        if (server.token) {
          return server.url + (server.url.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(server.token);
        }
        return server.url;
      });
  }

  /* ---------- HLS core ---------- */
  function destroyHls() {
    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  }
  function playServer(idx, seekTo) {
    if (!state.data || !state.data.servers) return setLoadState('Loading stream...');
    var servers = state.data.servers || [];
    if (!servers.length) return setLoadState('Loading stream...');
    idx = Math.max(0, Math.min(servers.length - 1, idx));
    state.serverIdx = idx;
    $('server-chip').textContent = servers[idx].label || ('Server ' + (idx + 1));
    destroyHls();

    var url = servers[idx].url;
    var preFinal = (url.charAt(0) === '/' || state.mode === 'mock') ? Promise.resolve(url) : streamUrlWithToken(servers[idx]);
    preFinal.then(function (finalUrl) {
      if (!window.Hls || !Hls.isSupported()) { attachNative(finalUrl, seekTo); return; }
      var hls = new Hls({ maxBufferLength: 30, capLevelToPlayerSize: false });
      state.hls = hls;
      hls.loadSource(finalUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        state.retryCount = 0;
        buildQualityPanel();
        applyAudioForItem();
        onStreamReady(seekTo);
      });
      hls.on(Hls.Events.ERROR, function (ev, d) {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details === 'manifestLoadError') {
          tryNextServer('Server ' + (idx + 1) + ' is unreachable');
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          tryNextServer('Server ' + (idx + 1) + ' failed: ' + d.details);
        }
      });
    }).catch(function (e) { tryNextServer(String(e && e.message || e)); });
  }
  function attachNative(url, seekTo) {
    video.src = url;
    onStreamReady(seekTo);
  }
  /* "Fully ready" gate: while the stream is loading the control bar is
     replaced by the Loading... Elapsed bar; it returns (and playback
     starts) only once the media can actually play. Seeks wait for
     metadata - setting currentTime at readyState 0 is dropped silently. */
  function onStreamReady(seekTo) {
    var token = ++state.readyToken;
    var go = function () {
      if (token !== state.readyToken) return;
      stopLoadStatus();
      autoStart();
      var target = seekTo;
      if (!target && state.idleResumePos) { target = state.idleResumePos; state.idleResumePos = null; }
      if (target) {
        var tries = 0;
        (function trySeek() {
          if (video.readyState >= 1) { try { video.currentTime = target; } catch (e) {} }
          else if (tries++ < 200) setTimeout(trySeek, 100);
        })();
      }
    };
    if (video.readyState >= 3) return go();
    video.addEventListener('canplay', function once() {
      video.removeEventListener('canplay', once);
      go();
    });
  }
  function tryNextServer(reason) {
    var servers = state.data.servers || [];
    var next = state.serverIdx + 1;
    if (next < servers.length) {
      toast(reason + ', switching to Server ' + (next + 1));
      var pos = video.currentTime || 0;
      playServer(next, pos > 5 ? pos : 0);
    } else {
      toast(reason + ', reconnecting...');
      reconnectAfterFailure();
    }
  }
  function setLoadState() { /* silent - overlays removed by request */ }
  function reconnectAfterFailure() {
    state.retryCount = (state.retryCount || 0) + 1;
    if (state.retryCount > 5) {
      /* give up instead of hammering the rate-limited upstream forever */
      stopLoadStatus();
      showError('All servers failed after ' + state.retryCount + ' attempts');
      return;
    }
    var delay = Math.min(3000 * state.retryCount, 15000);
    var pos = video.currentTime || 0;
    setLoadState(state.retryCount > 1 ? 'Reconnecting (attempt ' + state.retryCount + ')...' : 'Reconnecting...');
    setTimeout(function () {
      if (state.mode === 'live') {
        fetchResolveJson().then(function (data) {
          if (!data || !data.ok || !data.servers || !data.servers.length) throw new Error('empty');
          state.data = data;
          wireSubs(data);
          playServer(0, pos > 5 ? pos : 0);
        }).catch(function () { reconnectAfterFailure(); });
      } else {
        playServer(0, pos > 5 ? pos : 0);
      }
    }, delay);
  }

  /* ---------- panels ---------- */
  var openPanel = null;
  function bindPanelToggle(btnId, panelId, build) {
    var btn = $(btnId), panel = $(panelId);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (openPanel === panel) { closePanels(); return; }
      closePanels();
      build(panel);
      panel.hidden = false;
      openPanel = panel;
    });
  }
  function closePanels() {
    ['panel-servers', 'panel-quality', 'panel-speed', 'panel-subs', 'panel-audio', 'panel-settings', 'panel-episodes'].forEach(function (id) {
      $(id).hidden = true;
    });
    openPanel = null;
  }
  document.addEventListener('click', function (e) {
    if (openPanel && !openPanel.contains(e.target)) closePanels();
  });

  function buildServersPanel(panel) {
    var servers = state.data.servers || [];
    panel.innerHTML = '<h4>Servers</h4>';
    servers.forEach(function (s, i) {
      var b = UIKit.el('<button class="opt' + (i === state.serverIdx ? ' active' : '') + '">' + s.label + '</button>');
      b.addEventListener('click', function () {
        var pos = video.currentTime || 0;
        playServer(i, pos > 5 ? pos : 0);
        toast('Switched to ' + s.label);
        closePanels();
      });
      panel.appendChild(b);
    });
    var note = UIKit.el('<p class="hint">Auto-failover moves to the next server when one dies.</p>');
    panel.appendChild(note);
  }
  function buildQualityPanel() {
    var p = $('panel-quality');
    p.innerHTML = '<h4>Quality</h4>';
    var hls = state.hls;
    if (!hls || !hls.levels || !hls.levels.length) {
      p.appendChild(UIKit.el('<p class="hint">Single quality stream.</p>'));
      return;
    }
    var mk = function (label, idx) {
      var b = UIKit.el('<button class="opt">' + label + '</button>');
      if ((hls.currentLevel === -1 && idx === -1) || hls.levels[hls.currentLevel] === hls.levels[idx]) b.classList.add('active');
      b.addEventListener('click', function () {
        hls.currentLevel = idx;
        $('quality-chip').textContent = label;
        closePanels();
      });
      return b;
    };
    var wrap = UIKit.el('<div class="opts"></div>');
    wrap.appendChild(mk('Auto', -1));
    hls.levels.forEach(function (l, i) { wrap.appendChild(mk((l.height || '?') + 'p', i)); });
    p.appendChild(wrap);
  }
  function buildSpeedPanel(panel) {
    panel.innerHTML = '<h4>Speed</h4>';
    var wrap = UIKit.el('<div class="opts"></div>');
    [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].forEach(function (sp) {
      var b = UIKit.el('<button class="opt' + (video.playbackRate === sp ? ' active' : '') + '">' + sp + 'x</button>');
      b.addEventListener('click', function () {
        video.playbackRate = sp;
        $('speed-chip').textContent = sp === 1 ? '1x' : sp + 'x';
        closePanels();
      });
      wrap.appendChild(b);
    });
    panel.appendChild(wrap);
  }
  function buildSubsPanel(panel) {
    function sliderRow(label, min, max, step, val, fmt, oninput) {
      var row = UIKit.el('<div class="row"><label>' + label + '</label><span class="val"></span></div>');
      var inp = UIKit.el('<input type="range">');
      inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      var valEl = row.querySelector('.val');
      valEl.textContent = fmt(val);
      inp.addEventListener('input', function () { valEl.textContent = fmt(parseFloat(inp.value)); oninput(parseFloat(inp.value)); });
      row.insertBefore(inp, valEl);
      return row;
    }
    panel.innerHTML = '<h4>Subtitles</h4>';
    var subs = state.data.subs || [];
    var wrap = UIKit.el('<div class="opts"></div>');
    var off = UIKit.el('<button class="opt' + (state.subLang === null ? ' active' : '') + '">Off</button>');
    off.addEventListener('click', function () { setSubLang(null); closePanels(); });
    wrap.appendChild(off);
    subs.forEach(function (s, i) {
      var b = UIKit.el('<button class="opt' + (state.subLang === i ? ' active' : '') + '">' + s.lang + '</button>');
      b.addEventListener('click', function () { setSubLang(i); closePanels(); });
      wrap.appendChild(b);
    });
    panel.appendChild(wrap);
    panel.appendChild(UIKit.el('<div class="divider"></div>'));
    var sizeRow = UIKit.el('<div class="row"><label>Size</label><span class="val" id="sub-size-val">' + state.subStyle.fontSize.toFixed(2) + 'x</span></div>');
    var sizeIn = UIKit.el('<input type="range" min="0.7" max="1.8" step="0.05">');
    sizeIn.value = state.subStyle.fontSize;
    sizeIn.addEventListener('input', function () {
      state.subStyle.fontSize = parseFloat(sizeIn.value);
      $('sub-size-val').textContent = state.subStyle.fontSize.toFixed(2) + 'x';
      saveSubStyle();
      renderSubs();
    });
    sizeRow.insertBefore(sizeIn, sizeRow.lastChild);
    panel.appendChild(sizeRow);
    function updStyle(key, parse) {
      return function (v) {
        state.subStyle[key] = parse ? parse(v) : v;
        saveSubStyle();
        renderSubs();
      };
    }
    var posRow = UIKit.el('<div class="row"><label>Position</label><span class="val" id="sub-pos-val">' + state.subStyle.bottomOffset + 'px</span></div>');
    var posIn = UIKit.el('<input type="range" min="20" max="280" step="4">');
    posIn.value = state.subStyle.bottomOffset;
    posIn.addEventListener('input', function () { $('sub-pos-val').textContent = posIn.value + 'px'; updStyle('bottomOffset', parseInt)(posIn.value); });
    posRow.insertBefore(posIn, posRow.lastChild);
    panel.appendChild(posRow);
    panel.appendChild(sliderRow('Sync offset', -10, 10, 0.1, state.subOff || 0,
      function (v) { return v.toFixed(1) + 's'; },
      function (v) {
        state.subOff = v;
        Object.keys(state.subManagers).forEach(function (k) { state.subManagers[k].setOffset(state.subOff); });
        renderSubs();
      }));
    panel.appendChild(sliderRow('Bg opacity', 0, 1, 0.05, state.subStyle.bgOpacity,
      function (v) { return Math.round(v * 100) + '%'; }, updStyle('bgOpacity')));
    panel.appendChild(sliderRow('Letter spacing', 0, 3, 0.25, state.subStyle.letterSpacing || 0,
      function (v) { return v.toFixed(2) + 'px'; }, updStyle('letterSpacing')));
    panel.appendChild(UIKit.el('<div class="divider"></div>'));
    var colRow = UIKit.el('<div class="row"><label>Text color</label></div>');
    var colWrap = UIKit.el('<div class="opts" style="gap:8px"></div>');
    ['#ffffff', '#ffe14d', '#4dd8ff', '#ff9ecd', '#7dff8e'].forEach(function (col) {
      var sw = UIKit.el('<button class="sub-swatch' + (state.subStyle.color === col ? ' active' : '') + '" style="background:' + col + '" title="' + col + '"></button>');
      sw.addEventListener('click', function () {
        updStyle('color')(col);
        colWrap.querySelectorAll('.sub-swatch').forEach(function (b) { b.classList.remove('active'); });
        sw.classList.add('active');
      });
      colWrap.appendChild(sw);
    });
    colRow.appendChild(colWrap);
    panel.appendChild(colRow);
    var edgeRow = UIKit.el('<div class="row"><label>Edge style</label></div>');
    var edgeWrap = UIKit.el('<div class="opts"></div>');
    [['outline', 'Outline'], ['shadow', 'Soft shadow'], ['none', 'None']].forEach(function (pair) {
      var b = UIKit.el('<button class="opt' + (state.subStyle.edge === pair[0] ? ' active' : '') + '">' + pair[1] + '</button>');
      b.addEventListener('click', function () {
        updStyle('edge')(pair[0]);
        edgeWrap.querySelectorAll('.opt').forEach(function (o) { o.classList.remove('active'); });
        b.classList.add('active');
      });
      edgeWrap.appendChild(b);
    });
    edgeRow.appendChild(edgeWrap);
    panel.appendChild(edgeRow);
    var wtRow = UIKit.el('<div class="row"><label>Weight</label></div>');
    var wtWrap = UIKit.el('<div class="opts"></div>');
    [['400', 'Normal'], ['700', 'Bold'], ['900', 'Black']].forEach(function (pair) {
      var b = UIKit.el('<button class="opt' + (String(state.subStyle.fontWeight) === pair[0] ? ' active' : '') + '">' + pair[1] + '</button>');
      b.addEventListener('click', function () {
        updStyle('fontWeight', String)(pair[0]);
        wtWrap.querySelectorAll('.opt').forEach(function (o) { o.classList.remove('active'); });
        b.classList.add('active');
      });
      wtWrap.appendChild(b);
    });
    wtRow.appendChild(wtWrap);
    panel.appendChild(wtRow);
    panel.appendChild(UIKit.el('<p class="hint">Sync re-times cues for files whose audio is out of sync. Style settings are saved.</p>'));
  }
  function saveSubStyle() { try { localStorage.setItem('cinebyte_sub_style', JSON.stringify(state.subStyle)); } catch (e) {} }
  function setSubLang(i) {
    state.subLang = i;
    if (i === null) { $('subtitle-box').style.display = 'none'; $('btn-subs').classList.remove('active'); return; }
    $('btn-subs').classList.add('active');
    $('subtitle-box').style.display = '';
    renderSubs();
  }
  function renderSubs() {
    var box = $('subtitle-box');
    if (state.subLang === null) return;
    var subs = state.data.subs || [];
    var s = subs[state.subLang];
    if (!s) return;
    ensureSubManager(state.subLang).then(function (m) {
      if (!m || state.subLang === null) return;
      m.setStyle(state.subStyle);
      m.renderAt(video.currentTime, box);
    });
  }
  function buildAudioPanel(panel) {
    panel.innerHTML = '<h4>Audio Fix</h4><p class="hint" style="margin-top:-4px">Mono is the default: it fixes the broken 5.1 downmix. Boost can go up to 10x (limiter keeps it clean).</p>';
    var modes = UIKit.el('<div class="opts"></div>');
    var cur = state.audioMode || 'mono';
    [['stereo', 'Stereo'], ['mono', 'Mono'], ['swap', 'Swap L/R']].forEach(function (pair) {
      var b = UIKit.el('<button class="opt' + (cur === pair[0] ? ' active' : '') + '">' + pair[1] + '</button>');
      b.addEventListener('click', function () {
        ensureAudioFix();
        state.audioMode = pair[0];
        audioPrefSet(audioFixKey(), pair[0]);
        if (state.audioFix) state.audioFix.setMode(pair[0]);
        modes.querySelectorAll('.opt').forEach(function (o) { o.classList.remove('active'); });
        b.classList.add('active');
        toast('Audio: ' + pair[1]);
      });
      modes.appendChild(b);
    });
    panel.appendChild(modes);
    panel.appendChild(UIKit.el('<div class="divider"></div>'));
    function sliderRow(label, min, max, step, val, fmt, oninput) {
      var row = UIKit.el('<div class="row"><label>' + label + '</label><span class="val"></span></div>');
      var inp = UIKit.el('<input type="range">');
      inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      var valEl = row.querySelector('.val');
      valEl.textContent = fmt(val);
      inp.addEventListener('input', function () { valEl.textContent = fmt(parseFloat(inp.value)); oninput(parseFloat(inp.value)); });
      row.insertBefore(inp, valEl);
      return row;
    }
    panel.appendChild(sliderRow('Balance', -1, 1, 0.05, state.audioBal || 0,
      function (v) { return v.toFixed(2); },
      function (v) { state.audioBal = v; ensureAudioFix(); if (state.audioFix) state.audioFix.setBalance(v); }));
    panel.appendChild(sliderRow('Boost', 0, 10, 0.1, state.audioBoost || 4,
      function (v) { return v.toFixed(1) + 'x'; },
      function (v) { state.audioBoost = v; ensureAudioFix(); if (state.audioFix) state.audioFix.setBoost(v); }));
    panel.appendChild(sliderRow('Sync offset', -1000, 1000, 25, state.audioDelay || 0,
      function (v) { return Math.round(v) + 'ms'; },
      function (v) { state.audioDelay = v; ensureAudioFix(); if (state.audioFix) state.audioFix.setDelayMs(v); }));
  }
  /* ---------- persistent per-item audio prefs ---------- */
  function audioFixKey() {
    return state.route.type + '|' + state.route.tmdbId + '|' + (state.route.season || 0) + '|' + (state.route.episode || 0);
  }
  function audioPrefs() {
    try { return JSON.parse(localStorage.getItem('cinebyte_audio_fix') || '{}'); } catch (e) { return {}; }
  }
  function audioPrefGet(k) { return audioPrefs()[k] || null; }
  function audioPrefSet(k, v) {
    try { var d = audioPrefs(); d[k] = v; localStorage.setItem('cinebyte_audio_fix', JSON.stringify(d)); } catch (e) {}
  }

  /* apply saved mode for the current item (or reset to stereo + restart analyzer) */
  function applyAudioForItem() {
    var key = audioFixKey();
    if (key === state.audioKey) return;
    state.audioKey = key;
    var pref = audioPrefGet(key);
    state.audioMode = pref || 'mono';
    if (!state.audioFix) return;
    try {
      state.audioFix.setMode(pref || 'mono');
      state.autoWatch = null; /* fresh analyzer per item */
      startAutoStereoWatch(!!pref); /* explicit user choice beats auto-repair */
    } catch (e) {}
  }

  function ensureAudioFix() {
    if (state.audioFix || !video) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.actx) state.actx = new AC();
      var ctx = state.actx;
      var engage = function () {
        if (state.audioFix) return;
        try {
          var src = ctx.createMediaElementSource(video);
          state.audioFix = AudioFix.createAudioFix(ctx, src);
          state.audioFix.bindGesture(window);
          state.audioFix.setBoost(state.audioBoost || 4);
          if (state.audioBal) state.audioFix.setBalance(state.audioBal);
          if (state.audioDelay) state.audioFix.setDelayMs(state.audioDelay);
          /* the default/saved mode (mono) was recorded BEFORE the graph
             existed - re-apply it for real now that the nodes are live,
             instead of sitting in the graph's stereo default until the
             user clicks the mode button */
          state.audioKey = null;
          applyAudioForItem();
        } catch (e) { toast('Audio engine unavailable in this browser'); }
      };
      var tryEngage = function () {
        ctx.resume().then(function () { if (ctx.state === 'running') engage(); }).catch(function () {});
      };
      if (ctx.state === 'running') { engage(); return; }
      /* sticky activation already on the page? resume immediately */
      var ua = navigator.userActivation;
      if (ua && ua.hasBeenActive) { tryEngage(); return; }
      /* otherwise wait quietly for the first gesture - one attempt only */
      if (!state.gestureBound) {
        state.gestureBound = true;
        tryEngage();
        ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
          window.addEventListener(ev, function h() { window.removeEventListener(ev, h); tryEngage(); });
        });
      }
    } catch (e) { toast('Audio engine unavailable in this browser'); }
  }

  /* ---------- auto split-stereo / dead-channel repair ---------- */
  function startAutoStereoWatch(explicit) {
    /* the old gate keyed on state.audioMode, which applyAudioForItem always
       sets (default 'mono'), so the analyzer could never engage - gate on an
       explicit user preference and the auto_repair conf instead */
    if (state.autoWatch || !state.audioFix) return;
    if (explicit) return;
    if (state.conf && state.conf.audio && state.conf.audio.auto_repair === false) return;
    var ctx = state.actx, nodes = state.audioFix.nodes;
    if (!ctx.createScriptProcessor) return;
    var sp, mute, merger;
    try {
      sp = ctx.createScriptProcessor(4096, 2, 1);
      mute = ctx.createGain(); mute.gain.value = 0;
      merger = ctx.createChannelMerger(2);
      nodes.splitter.connect(merger, 0, 0);
      nodes.splitter.connect(merger, 1, 1);
      merger.connect(sp, 0, 0);
      sp.connect(mute); mute.connect(ctx.destination);
    } catch (e) { return; }
    var sl = 0, sr = 0, slr = 0, n = 0, wins = 0, done = false;
    var CHUNK = 88200, MAXW = 150; /* 2s chunks, ~5 min of watching */
    function cleanup() {
      done = true;
      try { sp.disconnect(); mute.disconnect(); } catch (e) {}
    }
    function finish() {
      var wasMono = state.audioMode === 'mono';
      cleanup();
      state.audioMode = 'mono';
      if (state.audioFix) state.audioFix.setMode('mono');
      audioPrefSet(audioFixKey(), 'mono');
      if (!wasMono) toast('Audio auto-repair: mono mix engaged (broken stereo detected)');
    }
    sp.onaudioprocess = function (ev) {
      if (done) return;
      var L = ev.inputBuffer.getChannelData(0), R = ev.inputBuffer.getChannelData(1);
      for (var i = 0; i < L.length; i++) {
        var l = L[i], r = R[i];
        sl += l * l; sr += r * r; slr += l * r;
      }
      n += L.length;
      if (n >= CHUNK) {
        var eL = Math.sqrt(sl / n), eR = Math.sqrt(sr / n);
        var denom = Math.sqrt(sl * sr), corr = denom > 1e-9 ? slr / denom : 1;
        var hi = Math.max(eL, eR), lo = Math.min(eL, eR);
        var splitStereo = (corr < 0.3 && lo > 0.002 && hi > 0.004);
        var deadChan = (lo < hi * 0.12 && hi > 0.01);
        sl = 0; sr = 0; slr = 0; n = 0; wins++;
        if (splitStereo || deadChan) { finish(); return; }
        if (wins >= MAXW) cleanup();
      }
    };
    state.autoWatch = sp;
  }
  function buildSettingsPanel(panel) {
    panel.innerHTML = '<h4>Settings</h4>';
    var row = UIKit.el('<div class="row"><label>Skip intro jump</label><span class="val" id="si-val"></span></div>');
    var inp = UIKit.el('<input type="range" min="10" max="180" step="5">');
    var cfg = state.skip.getConfig();
    inp.value = cfg.seekTo;
    row.insertBefore(inp, row.lastChild);
    var upd = function () {
      $('si-val').textContent = inp.value + 's';
      /* setIntroEnd keeps hideAfter consistent with the jump point */
      state.skip.setIntroEnd(parseInt(inp.value, 10));
    };
    row.querySelector('.val').textContent = inp.value + 's';
    inp.addEventListener('input', upd);
    panel.appendChild(row);
    panel.appendChild(UIKit.el('<p class="hint">Intro times come from TheIntroDB when available. Your own marker always wins: long-press the video (1s) to set the intro end for this show.</p>'));
    var st = UIKit.el('<div class="row"><label>Resume where you left off</label><span class="val">auto</span></div>');
    panel.appendChild(st);
  }

  /* ---------- episodes panel (TMDB order) ---------- */
  function buildEpisodesPanel(panel) {
    panel.innerHTML = '<h4>Episodes</h4>';
    var eps = (state.meta && state.meta.episodes) || [];
    if (!eps.length) { panel.appendChild(UIKit.el('<p class="hint">No episode list available.</p>')); return; }
    var wrap = UIKit.el('<div class="ep-list"></div>');
    eps.forEach(function (ep) {
      var cur = ep.n === state.route.episode;
      var row = UIKit.el('<button class="ep-item' + (cur ? ' active' : '') + '">' +
        (ep.still ? '<img class="ep-still" src="' + ep.still + '" alt="">' : '<span class="ep-still ep-still-empty"></span>') +
        '<span class="ep-txt"><span class="ep-name">E' + ep.n + ' - ' + escHtml(ep.name || 'Episode ' + ep.n) + '</span>' +
        '<span class="ep-sub">' + (ep.date ? ep.date + (ep.runtime ? ' - ' + ep.runtime + 'm' : '') : (ep.runtime ? ep.runtime + 'm' : '')) + '</span></span>' +
        '</button>');
      row.addEventListener('click', function () {
        if (cur) { closePanels(); return; }
        location.href = Router.tvHref(state.route.tmdbId, state.route.season, ep.n);
      });
      wrap.appendChild(row);
    });
    panel.appendChild(wrap);
    if (state.meta && state.meta.seasons && state.meta.seasons.length) {
      var sels = UIKit.el('<div class="opts" style="margin-top:8px"></div>');
      state.meta.seasons.forEach(function (sn) {
        var b = UIKit.el('<button class="opt' + (sn === state.route.season ? ' active' : '') + '">Season ' + sn + '</button>');
        b.addEventListener('click', function () {
          if (sn !== state.route.season) location.href = Router.tvHref(state.route.tmdbId, sn, 1);
        });
        sels.appendChild(b);
      });
      panel.appendChild(UIKit.el('<div class="divider"></div>'));
      panel.appendChild(sels);
    }
  }

  /* ---------- accent theming: layout.conf accent is the default,
     ?color=hex (or ?theme=hex) overrides it per link ---------- */
  function hexToAccent(col) {
    col = String(col).replace('#', '');
    if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(col)) return null;
    if (col.length === 3) col = col.split('').map(function (ch) { return ch + ch; }).join('');
    return '#' + col.toLowerCase();
  }
  function setAccent(col) {
    var r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
    var root = document.documentElement.style;
    root.setProperty('--accent', col);
    root.setProperty('--accent-rgb', r + ',' + g + ',' + b);
    root.setProperty('--accent-ink', (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.45 ? '#0b1016' : '#ffffff');
  }
  function applyTheme() {
    var urlCol = hexToAccent(qs('color') || qs('theme') || '');
    if (urlCol) return setAccent(urlCol);
    var confCol = state.conf && state.conf.brand && state.conf.brand.accent ? hexToAccent(state.conf.brand.accent) : null;
    if (confCol) setAccent(confCol);
  }
  function applyBrand(conf) {
    var name = conf && conf.brand && conf.brand.name;
    if (name) { document.title = name; }
  }
  function applyConfControls(conf) {
    var c = conf && conf.controls;
    if (!c) return;
    var map = {
      servers: 'server-chip', quality: 'quality-chip', speed: 'speed-chip',
      subtitles: 'btn-subs', audio: 'btn-audio', next: 'btn-next',
      episodes: 'btn-episodes', settings: 'btn-settings', pip: 'btn-pip',
      fullscreen: 'btn-full', volume_slider: 'vol-wrap'
    };
    Object.keys(map).forEach(function (k) {
      if (c[k] === false) { var el = $(map[k]); if (el) el.style.display = 'none'; }
    });
  }

  /* ---------- Viduki-style info overlay (loading + paused) ---------- */
  function hideIdle() {
    $('idle').hidden = true;
    if (state.pauseDimTimer) { clearTimeout(state.pauseDimTimer); state.pauseDimTimer = null; }
    if (state.pauseShowTimer) { clearTimeout(state.pauseShowTimer); state.pauseShowTimer = null; }
    $('idle').classList.remove('paused', 'deep');
  }
  /* [idle_screen] customization: eyebrow text, element toggles, backdrop
     brightness, and the optional zoom/fade motion */
  function applyIdleConf(conf) {
    var ic = (conf && conf.idle_screen) || {};
    var idle = $('idle');
    if (ic.eyebrow_text !== undefined) {
      $('idle-eyebrow').textContent = ic.eyebrow_text;
      $('idle-eyebrow').hidden = !ic.eyebrow_text;
    }
    if (ic.show_description === false) $('idle-desc').hidden = true;
    if (ic.show_meta === false) $('idle-meta').hidden = true;
    if (typeof ic.dim === 'number') {
      $('idle-backdrop').style.filter = 'brightness(' + Math.max(0, Math.min(1, ic.dim)) + ')';
    }
    idle.classList.toggle('no-zoom', ic.backdrop_zoom === false);
    idle.classList.toggle('no-anim', ic.animate === false);
  }
  function idleChip(txt, cls) { return '<span class="idle-chip' + (cls ? ' ' + cls : '') + '">' + escHtml(txt) + '</span>'; }
  var loadTick = null, loadStart = 0, dotsPhase = 0;
  function startLoadStatus() {
    loadStart = Date.now();
    dotsPhase = 0;
    /* the real control bar is replaced by "Loading... Elapsed:" until the
       stream is fully ready to watch */
    $('controls').hidden = true;
    $('loading-bar').hidden = false;
    $('load-dots').textContent = '.';
    $('load-elapsed').textContent = 'Elapsed: 0s';
    clearInterval(loadTick);
    loadTick = setInterval(function () {
      dotsPhase = (dotsPhase + 1) % 3;
      $('load-dots').textContent = '.'.repeat(dotsPhase + 1);
      $('load-elapsed').textContent = 'Elapsed: ' + Math.floor((Date.now() - loadStart) / 1000) + 's';
    }, 1000);
  }
  function stopLoadStatus() {
    clearInterval(loadTick); loadTick = null;
    $('loading-bar').hidden = true;
    $('controls').hidden = false;
  }
  function fillOverlay(m) {
    m = m || {};
    var ep = currentEpisode(m);
    var chips = [];
    if (m.cert) chips.push(idleChip(m.cert, 'cert'));
    if (ep && ep.runtime) chips.push(idleChip(ep.runtime + 'm'));
    else if (m.runtime) chips.push(idleChip(String(m.runtime).replace(' ', '')));
    if (m.rating) chips.push(idleChip('★ ' + m.rating.toFixed(1)));
    if (m.year) chips.push(idleChip(m.year));
    $('idle-title').textContent = m.title || 'Loading';
    $('idle-season').textContent = state.route.type === 'tv'
      ? ('Season ' + state.route.season + ': Ep. ' + state.route.episode) : '';
    $('idle-meta').innerHTML = chips.join('');
    $('idle-ep-name').textContent = ep && ep.name ? ep.name : '';
    var desc = ep && ep.overview ? ep.overview : (m.description || '');
    $('idle-desc').textContent = desc ? (desc.slice(0, 340) + (desc.length > 340 ? '…' : '')) : '';
    var art = (ep && ep.still) || m.backdrop || m.poster || null;
    if (art) $('idle-backdrop').style.backgroundImage = 'url("' + art + '")';
  }
  function showOverlay(loading) {
    applyTheme();
    var idle = $('idle');
    idle.hidden = false;
    if (loading) startLoadStatus();
    var resumeEntry = state.pstore && state.pstore.resume({ type: state.route.type, tmdb: state.route.tmdbId, s: state.route.season, e: state.route.episode });
    var hasResume = resumeEntry && resumeEntry.position > 20 && !(resumeEntry.duration && resumeEntry.position > resumeEntry.duration * 0.95);
    var showBtns = !loading && !state.data;
    $('idle-play').hidden = !showBtns;
    if (hasResume && (loading || showBtns)) {
      $('idle-resume-pos').textContent = fmtTime(resumeEntry.position);
      $('idle-resume').hidden = false;
      $('idle-resume').onclick = function () {
        state.idleResumePos = resumeEntry.position;
        hideIdle(); beginPlayback(0);
      };
    } else {
      $('idle-resume').hidden = true;
    }
    $('idle-play').onclick = function () { hideIdle(); beginPlayback(0); };
    if (window.__CINEBYTE_META__) { fillOverlay(window.__CINEBYTE_META__); return; }
    if (state.meta) { fillOverlay(state.meta); return; }
    if (state.route.tmdbId) {
      fetch('/meta?type=' + state.route.type + '&id=' + state.route.tmdbId +
        (state.route.type === 'tv' ? '&season=' + state.route.season : ''))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { if (m && m.ok) { state.meta = m; applyMeta(m); } fillOverlay(m); })
        .catch(function () { fillOverlay(null); });
    } else fillOverlay(null);
  }
  /* pause -> description overlay over the FROZEN frame (not the artwork
     preload screen). The frame never changes, the info fades in over it,
     and after 15 seconds of pause the scrim eases deeper.
     layout.conf [pause_info]: enabled / delay / show_episode_overview / show_rating */
  function showPauseOverlay() {
    var pi = (state.conf && state.conf.pause_info) || {};
    if (pi.enabled === false) return;
    if ($('idle').hidden) {
      showOverlay(false);
      $('idle').classList.add('paused');
      if (pi.show_episode_overview === false) $('idle-desc').hidden = true;
      if (pi.show_rating === false) {
        var chips = $('idle-meta').children;
        for (var i = 0; i < chips.length; i++) {
          if (chips[i].textContent.indexOf('\u2605') === 0) chips[i].style.display = 'none';
        }
      }
      state.pauseDimTimer = setTimeout(function () {
        state.pauseDimTimer = null;
        if (!$('idle').hidden && $('idle').classList.contains('paused')) $('idle').classList.add('deep');
      }, 15000);
    }
  }
  video.addEventListener('pause', function () {
    if (state.data && !state.endedOnce && video.currentTime > 0.5 && $('error-card').hidden) {
      if ($('idle').hidden) {
        var pi = (state.conf && state.conf.pause_info) || {};
        var delay = typeof pi.delay === 'number' ? pi.delay : 0;
        if (delay > 0) { state.pauseShowTimer = setTimeout(showPauseOverlay, delay); }
        else showPauseOverlay();
      }
    }
  });
  video.addEventListener('play', function () {
    if (state.pauseShowTimer) { clearTimeout(state.pauseShowTimer); state.pauseShowTimer = null; }
    if (!$('idle').hidden) hideIdle();
    stopLoadStatus();
  });

  function beginPlayback(idx, seekTo) {
    /* autoplay straight into the stream - no click needed (conf: idle_screen.autoplay) */
    playServer(typeof idx === 'number' ? idx : 0, seekTo);
  }

  /* ---------- autoplay (muted fallback if browser blocks sound) ---------- */
  function autoStart() {
    ensureAudioFix();
    video.play().catch(function () {
      video.muted = true;
      showUnmuteChip();
      video.play().catch(function () {
        /* browser wants a gesture: surface a Play button on the overlay */
        if ($('idle').hidden) showOverlay(false);
        $('idle-play').hidden = false;
        $('idle-play').textContent = 'Play';
        $('idle-play').onclick = function () { hideIdle(); autoStart(); };
      });
    });
  }
  function showUnmuteChip() {
    var chip = $('unmute-chip');
    if (chip) chip.hidden = false;
  }
  video.addEventListener('volumechange', function () {
    var chip = $('unmute-chip');
    if (chip && !video.muted) chip.hidden = true;
  });
  $('unmute-chip').addEventListener('click', function () {
    video.muted = false;
    if (video.volume < 0.75) video.volume = 0.75;
    this.hidden = true;
  });

  /* ---------- boot ---------- */
  /* ---------- error handling ---------- */
  function showError(msg) {
    $('error-msg').textContent = 'Could not load this stream' + (msg ? ': ' + msg : '') + '. The upstream limits how fast streams resolve - waiting a moment and retrying usually works.';
    $('error-card').hidden = false;
    setNote('Resolve failed' + (msg ? ' (' + msg + ')' : '') + '.');
  }
  $('retry-btn').addEventListener('click', function () {
    $('error-card').hidden = true;
    state.retryCount = 0;
    startLoadStatus();
    startResolve();
  });
  $('retry-mock').addEventListener('click', function () {
    $('error-card').hidden = true;
    playMock('Resolve failed - playing test video instead.');
  });

  function playMock(note) {
    state.data = { servers: MOCK_STREAMS, subs: MOCK_SUBS, meta: { title: state.route.tmdbId ? 'Demo (mock streams)' : 'Vidium Demo', file_name: 'public test HLS' } };
    state.mode = 'mock';
    applyMeta(state.data.meta);
    wireSubs(state.data);
    hideIdle();
    startLoadStatus();
    beginPlayback(0);
    setNote(note || 'Mock mode (public test streams, every feature works).');
  }
  function startResolve() {
    var init = isMockWanted() ? Promise.reject(new Error('mock')) : fetchResolveJson();
    init.then(function (data) {
      if (!data || !data.ok || !data.servers || !data.servers.length) throw new Error('resolve empty');
      state.data = data;
      state.mode = (window.__CINEBYTE_DATA__ || qs('data')) ? 'injected' : 'live';
      applyMeta(data.meta);
      wireSubs(data);
      /* the Loading bar stays up until the media itself can play */
      /* autoplay: on by default (layout.conf [idle_screen] autoplay = true,
         or ?autoplay=1; opt out with ?autoplay=0) */
      var ap = qs('autoplay');
      var wantAuto = ap === null ? (state.conf && state.conf.idle_screen ? state.conf.idle_screen.autoplay !== false : true) : ap !== '0';
      if (wantAuto) {
        var ent = state.pstore && state.pstore.resume({ type: state.route.type, tmdb: state.route.tmdbId, s: state.route.season, e: state.route.episode });
        if (ent && ent.position > 20 && !(ent.duration && ent.position > ent.duration * 0.95)) {
          state.idleResumePos = ent.position;
          toast('Resuming from ' + fmtTime(ent.position));
        }
        beginPlayback(0); /* overlay hides itself on first 'play' */
      }
      else { stopLoadStatus(); $('idle-play').hidden = false; $('idle-play').onclick = function () { hideIdle(); beginPlayback(0); }; }
      setNote(state.mode === 'injected' ? 'Injected demo data.' : 'Resolved from vidsrc chain.');
    }).catch(function (err) {
      if (isMockWanted() || !state.route.tmdbId) { playMock(isMockWanted() ? undefined : 'No TMDB id in URL - playing test video.'); return; }
      stopLoadStatus();
      showError(err && err.message);
    });
  }

  function boot() {
    var pstore = PStore.createPStore({});
    state.pstore = pstore;

    if (!state.route.tmdbId && !isMockWanted() && !window.__CINEBYTE_DATA__) { location.href = '/'; return; }

    /* conf first (brand accent, autoplay, skip intro), then: overlay + resolve in parallel */
    LayoutConf.load().then(function (conf) {
      state.conf = conf;
      applyTheme();                       /* conf accent + ?color= override */
      applyBrand(conf);
      applyConfControls(conf);            /* [controls] toggles hide chips/buttons */
      applyIdleConf(conf);                /* [idle_screen] look + customization */
      /* [skip_intro] from layout.conf - previously hardcoded 3s/85s/115s */
      var si = conf.skip_intro || {};
      state.skip = SkipIntro.createSkipIntroController({
        showAt: si.show_at, seekTo: si.default_seek, hideAfter: si.auto_hide_after,
        enabled: si.enabled !== false, tmdbId: skipKey()
      });
      if (si.button_text) $('skip-intro-btn').textContent = si.button_text;
      state.skip.onShow(function (cfg) { $('skip-intro').hidden = false; });
      state.skip.onHide(function () { $('skip-intro').hidden = true; });
      state.skip.onSkip(function (cfg) {
        /* clamp: never jump past (or within 5s of) the end of the file */
        var d = video.duration || 0;
        var target = (d && cfg.seekTo > d - 5) ? Math.max(cfg.showAt, d - 5) : cfg.seekTo;
        video.currentTime = target;
        state.lastSkip = { at: Date.now(), to: target };
      });
      /* self-correcting jump target: if the user rewinds shortly after a
         skip, the place they pulled back to is the real intro end - learn it
         for this show (the 85s default is only ever a first-visit guess) */
      video.addEventListener('seeked', function () {
        if (!state.lastSkip || !state.skip) return;
        var ls = state.lastSkip;
        state.lastSkip = null;
        if (Date.now() - ls.at > 20000) return;
        var now = video.currentTime;
        if (now >= 15 && now < ls.to - 2) {
          state.skip.setIntroEnd(now);
          toast('Intro end learned: ' + fmtTime(now) + ' (saved for this show)');
        }
      });
      fetchIntroDb();                   /* community intro times (client-side) */
      /* show the info overlay immediately - Checking Server + elapsed */
      showOverlay(true);
      startResolve();
    });
  }
  /* intro markers are per type+show: a movie and a show sharing a tmdb id
     must not share one marker */
  function skipKey() { return state.route.type + ':' + state.route.tmdbId; }
  /* TheIntroDB: community-verified intro timestamps per episode. Called from
     the browser on purpose - the API is for client-side use, is anonymous
     (no key), and blocks datacenter IPs (a server-side proxy would fail).
     Falls back silently to conf defaults + local learning when an episode
     has no entry yet. */
  function fetchIntroDb() {
    var r = state.route;
    if (r.type !== 'tv' || !r.tmdbId) return;
    if (state.conf && state.conf.skip_intro && state.conf.skip_intro.use_introdb === false) return;
    var url = 'https://api.theintrodb.org/v4/media?tmdb_id=' + encodeURIComponent(r.tmdbId) +
      '&season=' + r.season + '&episode=' + r.episode;
    fetch(url).then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
      if (!data || !data.intro || !data.intro.length || !state.skip) return;
      var seg = null, i;
      for (i = 0; i < data.intro.length; i++) { if (data.intro[i].end_ms != null) { seg = data.intro[i]; break; } }
      if (!seg) return;
      state.skip.setRemoteIntro(seg.start_ms != null ? seg.start_ms / 1000 : null, seg.end_ms / 1000);
    }).catch(function () { /* silent */ });
  }
  /* Lazy subtitle loading: the SRT text is fetched from the server only
     when a track is first selected (or English auto-loads after start). */
  function ensureSubManager(i) {
    var subs = (state.data && state.data.subs) || [];
    var s = subs[i];
    if (!s) return Promise.resolve(null);
    var key = s.code + '_' + i;
    if (state.subManagers[key]) return Promise.resolve(state.subManagers[key]);
    if (state.subLoading && state.subLoading[key]) return state.subLoading[key];
    var p = new Promise(function (resolveP) {
      var rawPromise;
      if (s.srtB64) rawPromise = Promise.resolve(b64ToUtf8(s.srtB64));
      else if (s.url) rawPromise = fetch(s.url).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; });
      else rawPromise = Promise.resolve('');
      rawPromise.then(function (txt) {
        var m = Subtitles.createSubtitleManager();
        try { m.parse(txt || ''); } catch (e) {}
        state.subManagers[key] = m;
        if (state.subLoading) delete state.subLoading[key];
        resolveP(m);
      });
    });
    if (!state.subLoading) state.subLoading = {};
    state.subLoading[key] = p;
    return p;
  }
  function wireSubs(data) {
    state.subManagers = {};
    state.subLang = null;
    var subs = data.subs || [];
    var en = subs.findIndex(function (s) { return s.code === 'en'; });
    if (en > -1) setSubLang(en);   /* English on by default, loaded lazily */
  }
  function offerResume() {
    var entry = state.pstore.resume({ type: state.route.type, tmdb: state.route.tmdbId, s: state.route.season, e: state.route.episode });
    if (!entry || entry.position < 20) return;
    if (entry.duration && entry.position > entry.duration * 0.95) return;
    $('resume-pos').textContent = fmtTime(entry.position);
    $('resume-btn').hidden = false;
    $('resume-btn').addEventListener('click', function () {
      $('resume-btn').hidden = true;
      var trySeek = function () { if (video.readyState >= 1) video.currentTime = entry.position; else setTimeout(trySeek, 300); };
      trySeek();
      toast('Resumed from ' + fmtTime(entry.position));
    }, { once: true });
    setTimeout(function () { $('resume-btn').hidden = true; }, 9000);
  }

  /* ---------- video events ---------- */
  video.addEventListener('play', function () { pokeUI(); $('play-icon').setAttribute('d', 'M6 5h4v14H6zm8 0h4v14h-4z'); });
  video.addEventListener('pause', function () { pokeUI(); $('play-icon').setAttribute('d', 'M8 5v14l11-7z'); });
  video.addEventListener('timeupdate', function () {
    if (!state.seeking) updateSeek();
    renderSubs();
    if (state.skip && state.route.type === 'tv') state.skip.updateTime(video.currentTime);
    if (video.currentTime > 5 && isFinite(video.duration)) {
      state.pstore.save({ type: state.route.type, tmdb: state.route.tmdbId, s: state.route.season, e: state.route.episode },
        { position: video.currentTime, duration: video.duration });
    }
  });
  video.addEventListener('ended', function () {
    if (state.route.type === 'tv' && !state.endedOnce) {
      state.endedOnce = true;
      toast('Next episode starting');
      setTimeout(function () { goNext(); }, 1600);
    }
  });
  function updateSeek() {
    var d = video.duration || 0, c = video.currentTime || 0;
    $('seek-played').style.width = (d ? (c / d) * 100 : 0) + '%';
    $('seek-knob').style.left = (d ? (c / d) * 100 : 0) + '%';
    $('time-now').textContent = fmtTime(c);
    $('time-dur').textContent = fmtTime(d);
    if (video.buffered.length) {
      var b = video.buffered.end(video.buffered.length - 1);
      $('seek-buffered').style.width = (d ? (Math.min(b, d) / d) * 100 : 0) + '%';
    }
  }
  (function seekWiring() {
    var wrap = $('seek-wrap'), hit = $('seek-hit');
    function fracFromEvent(e) {
      var r = wrap.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    }
    hit.addEventListener('click', function (e) {
      if (video.duration) video.currentTime = fracFromEvent(e) * video.duration;
    });
    hit.addEventListener('mousemove', function (e) {
      if (!video.duration) return;
      var f = fracFromEvent(e), hov = $('seek-hover');
      hov.hidden = false;
      hov.style.left = (f * 100) + '%';
      $('seek-hover-time').textContent = fmtTime(f * video.duration);
    });
    hit.addEventListener('mouseleave', function () { $('seek-hover').hidden = true; });
  })();

  /* ---------- controls wiring ---------- */
  $('btn-play').addEventListener('click', function () { togglePlay(); });
  $('btn-back').addEventListener('click', function () { seekBy(-10); });
  $('btn-fwd').addEventListener('click', function () { seekBy(10); });
  function togglePlay() {
    if (video.paused) { ensureAudioFix(); video.play().catch(function () {}); }
    else video.pause();
  }
  function seekBy(d) {
    video.currentTime = Math.max(0, Math.min((video.duration || 0), video.currentTime + d));
    flash((d > 0 ? '+' : '') + d + 's');
  }
  $('vol').addEventListener('input', function () { video.volume = parseFloat($('vol').value); video.muted = false; });
  video.volume = 0.75; $('vol').value = 0.75;
  $('btn-mute').addEventListener('click', function () { video.muted = !video.muted; });
  $('btn-full').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else shell.requestFullscreen().catch(function () {});
  });
  $('btn-pip').addEventListener('click', function () {
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else video.requestPictureInPicture().catch(function () { toast('PiP not available'); });
  });
  $('btn-next').addEventListener('click', goNext);
  function goNext() {
    var r = state.route;
    if (state.meta && state.meta.episode_count && r.episode >= state.meta.episode_count) {
      toast('No more episodes in this season');
      return;
    }
    Router.navigate(Router.tvHref(r.tmdbId, r.season, r.episode + 1));
    location.reload();
  }
  $('skip-intro-btn').addEventListener('click', function () {
    if (!state.skip) return;
    state.skip.skip(); /* hides via onHide, seeks (clamped) via onSkip, once per session */
    toast('Intro skipped');
  });
  bindPanelToggle('server-chip', 'panel-servers', buildServersPanel);
  bindPanelToggle('quality-chip', 'panel-quality', function (p) { buildQualityPanel(); });
  bindPanelToggle('speed-chip', 'panel-speed', buildSpeedPanel);
  bindPanelToggle('btn-subs', 'panel-subs', buildSubsPanel);
  bindPanelToggle('btn-audio', 'panel-audio', buildAudioPanel);
  bindPanelToggle('btn-settings', 'panel-settings', buildSettingsPanel);
  bindPanelToggle('btn-episodes', 'panel-episodes', buildEpisodesPanel);
  $('side-pip').addEventListener('click', function () { $('btn-pip').click(); });
  $('side-full').addEventListener('click', function () { $('btn-full').click(); });

  /* keyboard */
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    UIKit.handleKeyDown(e, {
      togglePlay: togglePlay,
      seek: seekBy,
      changeVolume: function (d) { video.volume = Math.max(0, Math.min(1, video.volume + d)); $('vol').value = video.volume; },
      toggleFullscreen: function () { $('btn-full').click(); },
      toggleMute: function () { $('btn-mute').click(); },
      toggleSubtitles: function () { $('btn-subs').click(); },
      toggleAudioPanel: function () { $('btn-audio').click(); }
    });
    pokeUI();
  });

  /* mouse idle hides UI */
  ['mousemove', 'touchstart'].forEach(function (ev) {
    shell.addEventListener(ev, function () { pokeUI(); }, { passive: true });
  });
  shell.addEventListener('click', function () { pokeUI(); });

  /* mobile: double tap sides = ±10s, long press = set intro end */
  var dtap = UIKit.createDoubleTapDetector(function (d) { seekBy(d); });
  shell.addEventListener('touchend', function (e) {
    if (e.touches.length) return;
    var r = shell.getBoundingClientRect();
    dtap(e.changedTouches[0].clientX - r.left, r.width);
  });
  var lp = UIKit.createLongPressDetector(function () {
    if (!state.skip || state.route.type !== 'tv') return;
    var t = Math.max(5, Math.round(video.currentTime));
    state.skip.setIntroEnd(t);
    toast('Intro end set to ' + fmtTime(t));
  });
  shell.addEventListener('touchstart', function () { lp.start(); }, { passive: true });
  shell.addEventListener('touchend', function () { lp.cancel(); }, { passive: true });
  shell.addEventListener('touchmove', function () { lp.cancel(); }, { passive: true });

  window.__CB_DEBUG__ = function () { return state; };

  boot();
})();
