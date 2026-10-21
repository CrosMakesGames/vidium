#!/usr/bin/env node
/**
 * server.js - Cinebyte demo server (zero dependencies, Node 18+)
 *
 * Routes:
 *   /tv/{tmdbId}/{season}/{episode}   -> player page
 *   /movie/{tmdbId}                    -> player page
 *   /vidium                            -> Vidium homepage (readme, downloads, live embed demo)
 *   /                                   -> Vidium homepage, ALWAYS (never Veridium)
 *   /browse/...                         -> Veridium browse UI, ONLY when started
 *                                         with VERIDIUM=1 (local self-hosters who
 *                                         want a frontend; off by default)
 *   /v/{app.js|style.css|layout.conf}  -> Vidium client assets (kept clear of
 *                                         Veridium's root-level files in bundle mode)
 *   /v/modules/*.js                     -> Vidium player modules
 *   /resolve?type=tv|movie&id=&season=&episode=   -> vidsrc resolution JSON
 *   /mp/master/{sid}/{i}               -> proxied HLS master playlist
 *   /mp/child/{sid}?u=                 -> proxied HLS child playlist (URLs rewritten)
 *   /mp/seg/{sid}?u=                   -> proxied media segment (streamed)
 *
 * All upstream media traffic flows through this server: the token is minted
 * ONCE per session (cached for its 4h life, retried with backoff on 429),
 * the correct Origin header is sent on every hop, and the browser never
 * talks to the stream host directly - no CORS, no browser-side rate-limit
 * storms.
 *
 * Run:  node server.js   (optional PORT env, default 3000)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolve, fetchSubSrt } = require('./vidsrc-resolve.js');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json'
};

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}
function sendFile(res, filePath) {
  fs.readFile(filePath, function (err, buf) {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  });
}

/* ---------- media proxy sessions ---------- */

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // resolve data is short-lived anyway
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  sessions.forEach(function (s, sid) {
    if (now - s.created > SESSION_TTL_MS) sessions.delete(sid);
  });
}
setInterval(pruneSessions, 10 * 60 * 1000).unref();

function newSession(servers, shellHost, subs) {
  pruneSessions();
  const sid = crypto.randomBytes(9).toString('base64url');
  sessions.set(sid, {
    created: Date.now(),
    shellHost: shellHost,
    subs: (subs || []).slice(0, 8),
    mirrors: servers.map(function (s) { return s.url; }),
    mirrorOrigins: servers.map(function (s) { return new URL(s.url).origin; }),
    /* stream JWTs are minted per mirror HOST: cache per origin, not per
       session, or server 2 on a different host reuses server 1's token */
    tokens: {},
    tokenExps: {},
    minting: {}
  });
  return sid;
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(
      token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return (payload.exp || 0) * 1000;
  } catch (e) { return 0; }
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/**
 * Mint (or reuse) the 4h stream JWT for a session's mirror host.
 * Retries 429 with growing backoff. Cached until 5 minutes before exp.
 */
function sessionToken(session, mirrorOrigin) {
  const now = Date.now();
  if (!session.tokens) { session.tokens = {}; session.tokenExps = {}; session.minting = {}; }
  if (session.tokens[mirrorOrigin] && now < (session.tokenExps[mirrorOrigin] || 0) - 5 * 60 * 1000) {
    return Promise.resolve(session.tokens[mirrorOrigin]);
  }
  if (session.minting[mirrorOrigin]) return session.minting[mirrorOrigin];
  session.minting[mirrorOrigin] = (async function () {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      try {
        const r = await fetch(mirrorOrigin + '/generate.php', {
          headers: { 'Origin': session.shellHost },
          signal: AbortSignal.timeout(15000)
        });
        const text = (await r.text()).trim();
        if (r.status === 200 && text.indexOf('eyJ') === 0 && text.length > 150) {
          session.tokens[mirrorOrigin] = text;
          session.tokenExps[mirrorOrigin] = jwtExp(text);
          return text;
        }
      } catch (e) { /* network error - retry */ }
    }
    throw new Error('generate.php unavailable (rate-limited)');
  })();
  session.minting[mirrorOrigin].finally(function () { delete session.minting[mirrorOrigin]; });
  return session.minting[mirrorOrigin];
}

/** Append the token query param to a URL that does not have one. */
function withToken(url, token) {
  const u = new URL(url);
  if (!u.searchParams.get('token')) u.searchParams.set('token', token);
  return u.href;
}

/** Simple per-session concurrency limiter (max 3 in flight) for segments. */
function limiterFor(session) {
  if (!session._limiter) {
    session._limiter = { active: 0, queue: [] };
  }
  const L = session._limiter;
  return new Promise(function (acquire) {
    function tryNext() {
      if (L.active < 3) { L.active++; acquire(function release() { L.active--; if (L.queue.length) L.queue.shift()(); }); }
      else L.queue.push(tryNext);
    }
    tryNext();
  });
}

async function fetchUpstream(url, session, extraHeaders, signal) {
  const headers = Object.assign({ 'Origin': session.shellHost }, extraHeaders || {});
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal && signal.aborted) throw new Error('client disconnected');
    try {
      return await fetch(url, { headers: headers, signal: signal || AbortSignal.timeout(20000) });
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw new Error('client disconnected');
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('upstream fetch failed');
}

/** Rewrite an m3u8 so every URI line points back through the proxy. */
function rewritePlaylist(text, base, sid, kind) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }
    if (t[0] === '#') {
      // rewrite URI="..." attributes inside tags (e.g. #EXT-X-MEDIA)
      out.push(line.replace(/URI="([^"]+)"/g, function (m, uri) {
        const abs = new URL(uri, base).href;
        return 'URI="/mp/child/' + sid + '?u=' + encodeURIComponent(abs) + '"';
      }));
      continue;
    }
    const abs = new URL(t, base).href;
    if (kind === 'master') {
      out.push('/mp/child/' + sid + '?u=' + encodeURIComponent(abs));
    } else {
      out.push('/mp/seg/' + sid + '?u=' + encodeURIComponent(abs));
    }
  }
  return out.join('\n');
}

/* ---------- HTTP server ---------- */

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const parts = u.pathname.split('/').filter(Boolean);

  /* --- media proxy --- */
  if (parts[0] === 'mp') return handleProxy(parts, u, req, res);

  /* /health: wake probe + keep-alive ping target. Deliberately the cheapest
     possible response (no side effects, no upstream calls) and CORS-open so
     the static wake page on another origin can poll it. */
  if (u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  if (u.pathname === '/meta') {
    const type = (u.searchParams.get('type') || 'movie').toLowerCase() === 'movie' ? 'movie' : 'tv';
    const id = u.searchParams.get('id') || '';
    if (!/^\d+$/.test(id)) return sendJSON(res, 400, { ok: false, error: 'bad id' });
    const season = parseInt(u.searchParams.get('season') || '0', 10) || 0;
    tmdbMeta(type, id, season)
      .then(function (m) { sendJSON(res, m ? 200 : 404, m || { ok: false, error: 'not found' }); })
      .catch(function (e) { sendJSON(res, 502, { ok: false, error: String(e.message || e) }); });
    return;
  }

  if (u.pathname === '/resolve') {
    if (!resolveAllowed(req.socket ? (req.socket.remoteAddress || '?') : '?')) {
      return sendJSON(res, 429, { ok: false, error: 'Too many resolve requests - wait a moment and retry' });
    }
    const type = (u.searchParams.get('type') || 'movie').toLowerCase() === 'movie' ? 'movie' : 'tv';
    const id = u.searchParams.get('id') || u.searchParams.get('tmdbId');
    if (!id || !/^\d+$/.test(id)) return sendJSON(res, 400, { ok: false, error: 'id must be a tmdb id' });
    const season = parseInt(u.searchParams.get('season') || '1', 10) || 1;
    const episode = parseInt(u.searchParams.get('episode') || '1', 10) || 1;
    // 5-minute resolve cache: repeat visitors (and friends watching the
    // same episode) skip the whole upstream chain - near-instant start.
    const rkey = type + ':' + id + ':' + season + ':' + episode;
    const hit = resolveCache.get(rkey);
    const chain = (hit && Date.now() - hit.at < RESOLVE_TTL)
      ? Promise.resolve(hit.raw)
      : resolve({ type: type, tmdbId: id, season: season, episode: episode }).then(function (raw) {
          if (raw && raw.ok) {
            resolveCache.set(rkey, { at: Date.now(), raw: {
              ok: true,
              servers: raw.servers.map(function (s) { return { label: s.label, url: s.url, token: s.token }; }),
              shellHost: raw.shellHost,
              meta: raw.meta,
              subs: raw.subs
            } });
          }
          return raw;
        });
    chain.then(function (out) {
        if (out.ok) {
          const sid = newSession(out.servers, out.shellHost, out.subs);
          out.servers = out.servers.map(function (s, i) {
            return { label: s.label, url: '/mp/master/' + sid + '/' + i, kind: 'hls', token: null };
          });
          out.subs = (out.subs || []).map(function (s, i) {
            return { lang: s.lang, code: s.code, url: '/mp/sub/' + sid + '?i=' + i };
          });
          out.sid = sid;
          out.servers.forEach(function (s) { delete s.token; });
        }
        sendJSON(res, out.ok ? 200 : 502, out);
      })
      .catch(function (e) {
        sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) });
      });
    return;
  }

  // Vidium client assets under /v/ (root /app.js etc. belong to Veridium
  // in bundle mode)
  if (req.method === 'GET' && parts.length && parts[0] === 'v') {
    const rest = parts.slice(1);
    if (rest.length === 1 && ['app.js', 'style.css', 'layout.conf'].indexOf(rest[0]) > -1)
      return sendFile(res, path.join(CLIENT_DIR, rest[0]));
    if (rest.length && rest[0] === 'modules') {
      const safe = rest.slice(1).join('/').replace(/\.\./g, '');
      return sendFile(res, path.join(CLIENT_DIR, 'modules', safe));
    }
  }

  // Veridium is for LOCAL self-hosters who want a browse frontend - it is
  // opt-in (start with VERIDIUM=1) and lives under /browse/ so it can never
  // take over "/" of a published instance
  const veridiumRoot = path.join(__dirname, '..', 'veridium');
  const VERIDIUM_FILES = ['index.html', 'player.html', 'app.js', 'style.css', 'servers.js', 'instance-host-data.js', 'layout.conf'];
  if (process.env.VERIDIUM === '1' && req.method === 'GET' && parts.length && parts[0] === 'browse') {
    const name = (parts.length === 1 || parts[1] === '') ? 'index.html' : parts[1];
    if (VERIDIUM_FILES.indexOf(name) > -1)
      return sendFile(res, path.join(veridiumRoot, name));
    send(res, 404, 'Not found');
    return;
  }

  // legacy asset paths (back-compat with the old player-only layout)
  if (req.method === 'GET' && parts.length && parts[0] === 'modules') {
    const safe = parts.slice(1).join('/').replace(/\.\./g, '');
    return sendFile(res, path.join(CLIENT_DIR, 'modules', safe));
  }
  if (req.method === 'GET' && parts.length === 1 && ['app.js', 'style.css', 'layout.conf'].indexOf(parts[0]) > -1) {
    return sendFile(res, path.join(CLIENT_DIR, parts[0]));
  }

  // player routes: /tv/{id}/{s}/{e}, /movie/{id}
  const isTv = parts[0] === 'tv';
  const isMovie = parts[0] === 'movie';
  if ((isTv && parts[1] && /^\d+$/.test(parts[1])) || (isMovie && parts[1] && /^\d+$/.test(parts[1]))) {
    return sendFile(res, path.join(CLIENT_DIR, 'index.html'));
  }

  // homepages: "/" is always the Vidium homepage (never Veridium)
  if (req.method === 'GET' && parts.length <= 1 && (parts.length === 0 || parts[0] === 'vidium' || parts[0] === 'home')) {
    return sendFile(res, path.join(CLIENT_DIR, 'home.html'));
  }

  send(res, 404, 'Not found. Try / or /tv/105248/1/1 or /movie/155');
});

const META_TTL = 30 * 60 * 1000;
const metaCache = new Map();
const RESOLVE_TTL = 5 * 60 * 1000;
const resolveCache = new Map();

/* simple per-IP sliding window for /resolve (the chain hits upstream
   vs_src.php hard, so an open /resolve is an abuse vector) */
const RESOLVE_PER_MIN = 30;
const resolveHits = new Map();
function resolveAllowed(ip) {
  const now = Date.now();
  let arr = resolveHits.get(ip);
  if (!arr) { arr = []; resolveHits.set(ip, arr); }
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (arr.length >= RESOLVE_PER_MIN) return false;
  arr.push(now);
  if (resolveHits.size > 512) {
    resolveHits.forEach(function (a, k) {
      if (!a.length || now - a[a.length - 1] > 60000) resolveHits.delete(k);
    });
  }
  return true;
}
const TMDB_UAS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'curl/8.5.0'];
function tmdbFetch(url) {
  const attempt = function (i) {
    if (i >= TMDB_UAS.length) throw new Error('tmdb unavailable');
    return fetch(url, { headers: { 'user-agent': TMDB_UAS[i], 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow' })
      .then(function (r) {
        if (r.status === 403 || r.status === 429) return attempt(i + 1);
        if (r.status !== 200) throw new Error('tmdb ' + r.status);
        return r.text();
      });
  };
  return attempt(0);
}

/* Parse a TMDB season page into a correctly ordered episode list */
function tmdbSeasonEpisodes(html) {
  const eps = [];
  const seen = {};
  const titleRe = /title="[^"]*?: Episode (\d+) - ([^"]*)"/g;
  const marks = [];
  let mm;
  while ((mm = titleRe.exec(html)) !== null) marks.push({ n: parseInt(mm[1], 10), name: mm[2].trim(), i: mm.index });
  marks.forEach(function (mark, mi) {
    if (seen[mark.n]) return;
    seen[mark.n] = true;
    /* Region = this episode's first mark up to the first mark of the NEXT
       episode (each episode produces several title marks; cutting at the
       very next mark truncated the region before the overview/date). */
    let regionEnd = mark.i + 20000;
    for (let j = mi + 1; j < marks.length; j++) {
      if (marks[j].n !== mark.n) { regionEnd = marks[j].i; break; }
    }
    const region = html.slice(mark.i, regionEnd);
    const ovP = /class="overview"[^>]*>\s*<p>([\s\S]*?)<\/p>/.exec(region) || /<p>([^<][\s\S]*?)<\/p>/.exec(region);
    const overview = ovP ? ovP[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    const still = /media\.themoviedb\.org\/t\/p\/w227_and_h127_face\/([\w.]+jpe?g)/.exec(region);
    const dateM = /([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(region.replace(/<[^>]+>/g, ' '));
    const runM = /(\d+)m/.exec(region.replace(/<[^>]+>/g, ' '));
    eps.push({
      n: mark.n,
      name: mark.name,
      overview: overview,
      still: still ? ('https://media.themoviedb.org/t/p/w500/' + still[1]) : null,
      date: dateM ? dateM[1] : null,
      runtime: runM ? parseInt(runM[1], 10) : null
    });
  });
  eps.sort(function (a, b) { return a.n - b.n; });
  return eps;
}

function tmdbMeta(type, id, season) {
  const key = type + ':' + id + ':' + (season || 0);
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return Promise.resolve(hit.data);
  const page = type === 'tv' ? 'https://www.themoviedb.org/tv/' + id : 'https://www.themoviedb.org/movie/' + id;
  return tmdbFetch(page)
    .then(function (html) {
      const m = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
      if (!m) throw new Error('no ld+json on tmdb page');
      let raw = m[1].trim().replace(/\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\//, '').trim();
      const d = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
      let year = null;
      if (d.releasedEvent && d.releasedEvent[0] && d.releasedEvent[0].startDate) year = parseInt(d.releasedEvent[0].startDate, 10);
      let runtime = null;
      if (d.duration && /^PT/.test(d.duration)) {
        const h = /(\d+)H/.exec(d.duration); const mm = /(\d+)M/.exec(d.duration);
        runtime = (h ? parseInt(h[1], 10) + 'h ' : '') + (mm ? parseInt(mm[1], 10) + 'm' : (h ? '0m' : null));
      }
      const img = d.image ? d.image.replace('/w500/', '/w780/') : null;
      const certM = /class="certification"[^>]*>([^<]{1,40})</.exec(html);
      const out = {
        ok: true, kind: d['@type'], title: d.name || null, description: d.description || null,
        tagline: d.tagline || null, rating: d.aggregateRating ? d.aggregateRating.ratingValue : null,
        votes: d.aggregateRating ? d.aggregateRating.ratingCount : null,
        cert: d.contentRating || (certM ? certM[1].trim() : null), runtime: runtime, year: year || null,
        genres: Array.isArray(d.genre) ? d.genre.slice(0, 3) : (d.genre ? [d.genre] : []),
        poster: img, backdrop: img
      };
      metaCache.set(key, { at: Date.now(), data: out });
      if (type !== 'tv') return out;
      /* tv extras: available seasons + full episode list for the requested season */
      const seasons = [];
      const sRe = new RegExp('/tv/' + id + '(?:-[^/]*)?/season/(\\d+)', 'g');
      let sm;
      while ((sm = sRe.exec(html)) !== null) {
        const sn = parseInt(sm[1], 10);
        if (seasons.indexOf(sn) === -1) seasons.push(sn);
      }
      seasons.sort(function (a, b) { return a - b; });
      out.seasons = seasons;
      if (!season || seasons.indexOf(season) === -1) { metaCache.set(key, { at: Date.now(), data: out }); return out; }
      return tmdbFetch('https://www.themoviedb.org/tv/' + id + '/season/' + season)
        .then(function (sh) {
          const eps = tmdbSeasonEpisodes(sh);
          out.episodes = eps;
          out.episode_count = eps.length;
          out.season = season;
          metaCache.set(key, { at: Date.now(), data: out });
          return out;
        })
        .catch(function () { out.season = season; metaCache.set(key, { at: Date.now(), data: out }); return out; });
    })
    .catch(function () { return null; });
}

function handleProxy(parts, u, req, res) {
  const kind = parts[1];
  const sid = parts[2];
  const session = sessions.get(sid);
  if (!session) return send(res, 404, 'Unknown session. Reload the page.');

  (async function () {
    if (kind === 'master') {
      const i = parseInt(parts[3] || '0', 10) || 0;
      const mirror = session.mirrors[i];
      if (!mirror) return send(res, 404, 'No such mirror');
      const token = await sessionToken(session, new URL(mirror).origin);
      const r = await fetchUpstream(withToken(mirror, token), session);
      if (r.status !== 200) {
        // token may have gone stale upstream - mint fresh and retry once
        const mo = new URL(mirror).origin;
        if (session.tokens) { delete session.tokens[mo]; delete session.tokenExps[mo]; }
        const tok2 = await sessionToken(session, mo);
        const r2 = await fetchUpstream(withToken(mirror, tok2), session);
        if (r2.status !== 200) return send(res, 502, 'Upstream playlist ' + r2.status);
        const body = rewritePlaylist(await r2.text(), mirror, sid, 'master');
        return send(res, 200, body, 'application/vnd.apple.mpegurl');
      }
      const body = rewritePlaylist(await r.text(), mirror, sid, 'master');
      return send(res, 200, body, 'application/vnd.apple.mpegurl');
    }

    if (kind === 'sub') {
      const i = parseInt(u.searchParams.get('i') || '0', 10) || 0;
      const sub = (session.subs || [])[i];
      if (!sub || !sub.url) return send(res, 404, 'No such subtitle');
      try {
        const text = await fetchSubSrt(sub.url, session.shellHost);
        return send(res, 200, text, 'text/plain; charset=utf-8');
      } catch (e) {
        return send(res, 502, 'Subtitle fetch failed');
      }
    }

    const target = u.searchParams.get('u');
    if (!target) return send(res, 400, 'Missing u param');
    let targetUrl;
    try { targetUrl = new URL(target); } catch (e) { return send(res, 400, 'Bad u param'); }
    // only proxy hosts we resolved for this session
    if (session.mirrorOrigins.indexOf(targetUrl.origin) === -1) {
      return send(res, 403, 'Host not part of this session');
    }

    if (kind === 'child') {
      const token = await sessionToken(session, targetUrl.origin);
      const r = await fetchUpstream(withToken(target, token), session);
      if (r.status !== 200) return send(res, 502, 'Upstream playlist ' + r.status);
      const body = rewritePlaylist(await r.text(), target, sid, 'child');
      return send(res, 200, body, 'application/vnd.apple.mpegurl');
    }

    if (kind === 'seg') {
      const release = await limiterFor(session);
      let clientGone = false;
      let drainWaiter = null;
      const abort = new AbortController();
      const onClientGone = function () {
        clientGone = true;
        try { abort.abort(); } catch (e) {}
        if (drainWaiter) { const w = drainWaiter; drainWaiter = null; w(); }
      };
      req.on('close', onClientGone);
      try {
        // segment URLs carry the token already
        const r = await fetchUpstream(target, session, null, abort.signal);
        if (r.status !== 200) return send(res, 502, 'Upstream segment ' + r.status);
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        });
        if (r.body) {
          const reader = r.body.getReader();
          while (!clientGone) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (clientGone) break;
            const ok = res.write(chunk.value);
            if (!ok) {
              // if the browser disconnects mid-segment, stop waiting on drain
              // (previously this awaited forever, leaking a limiter slot)
              await new Promise(function (r2) {
                drainWaiter = r2;
                res.once('drain', function () { drainWaiter = null; r2(); });
              });
            }
          }
          try { if (clientGone) reader.cancel(); } catch (e) {}
        }
      } finally {
        try { req.removeListener('close', onClientGone); } catch (e) {}
        release();
      }
      try { res.end(); } catch (e) {}
      return;
    }

    send(res, 404, 'Unknown proxy route');
  })().catch(function (e) {
    if (!res.headersSent) send(res, 502, 'Proxy error: ' + ((e && e.message) || e));
    else res.end();
  });
}

server.listen(PORT, function () {
  console.log('Cinebyte demo server on http://localhost:' + PORT);
  console.log('Try: http://localhost:' + PORT + '/tv/105248/1/1  (Edgerunners)');
  console.log('Try: http://localhost:' + PORT + '/movie/155  (The Dark Knight)');
});
