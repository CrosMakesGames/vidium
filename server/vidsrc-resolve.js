/**
 * vidsrc-resolve.js
 * Zero-dependency Node module (Node 18+ global fetch + built-in WebAssembly)
 * Ports a verified vidsrc stream-resolution chain.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Robust fetch wrapper with timeout and exponential backoff retry.
 */
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 15000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = Object.assign({ 'User-Agent': UA }, options.headers || {});
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? new Error(`Timeout after ${timeoutMs}ms`) : err;
    }
  }
  throw lastError;
}

/**
 * Fetch JWT token from mirror /generate.php with initial delay and exponential backoff to prevent 429 rate limits.
 */
async function fetchGenerateJwt(genUrl, originHost) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(genUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Origin': originHost
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status === 200) {
        const text = (await res.text()).trim();
        // validate by JWT shape (base64url segments, header "eyJ...") instead
        // of substring checks - a legit base64 token can contain "429"
        if (text && text.startsWith('eyJ') && text.length > 150 && !text.includes('<')) {
          return text;
        }
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Execute a single resolution attempt.
 */
async function resolveSingleChain({ type = 'tv', tmdbId, season = 1, episode = 1 }) {
  if (!tmdbId) throw new Error('tmdbId is required');
  const isTv = type === 'tv';

  // Hop 1: vs_src.php
  const embedRef = isTv
    ? `https://tvserver-1.crosmakesgames.com/embed/${tmdbId}/${season}/${episode}`
    : `https://tvserver-1.crosmakesgames.com/embed/${tmdbId}`;

  const step1Url = isTv
    ? `https://tvserver-1.crosmakesgames.com/vs_src.php?type=tv&id=${tmdbId}&season=${season}&episode=${episode}`
    : `https://tvserver-1.crosmakesgames.com/vs_src.php?type=movie&id=${tmdbId}`;

  let res1;
  try {
    res1 = await fetchWithRetry(step1Url, { headers: { Referer: embedRef } });
  } catch (err) {
    return { ok: false, step: 'step1_vs_src', error: err.message };
  }

  let data1;
  try {
    data1 = await res1.json();
    if (!data1 || !data1.src) throw new Error('Invalid step 1 response JSON: missing src');
  } catch (err) {
    return { ok: false, step: 'step1_vs_src_parse', error: err.message };
  }

  const srcUrl = data1.src;
  const shellHost = new URL(srcUrl).origin;

  // Hop 2: Shell page HTML
  let res2;
  try {
    res2 = await fetchWithRetry(srcUrl, { headers: { Referer: embedRef } });
  } catch (err) {
    return { ok: false, step: 'step2_shell_page', error: err.message };
  }

  const html2 = await res2.text();
  const cfgMatch = html2.match(/window\.CFG\s*=\s*(\{[\s\S]*?\});/);
  if (!cfgMatch) {
    return { ok: false, step: 'step2_extract_cfg', error: 'window.CFG not found in shell page' };
  }

  let cfg;
  try {
    cfg = JSON.parse(cfgMatch[1]);
  } catch (err) {
    return { ok: false, step: 'step2_parse_cfg', error: err.message };
  }

  if (!cfg.playerUrl) {
    return { ok: false, step: 'step2_player_url', error: 'playerUrl missing in window.CFG' };
  }

  const playerFullUrl = new URL(cfg.playerUrl, shellHost).href;

  // Hop 3: Player page HTML
  let res3;
  try {
    res3 = await fetchWithRetry(playerFullUrl, { headers: { Referer: srcUrl } });
  } catch (err) {
    return { ok: false, step: 'step3_player_page', error: err.message };
  }

  const html3 = await res3.text();
  const configMatch = html3.match(/CONFIG\s*=\s*(\{[\s\S]*?\});/);
  if (!configMatch) {
    return { ok: false, step: 'step3_extract_config', error: 'CONFIG object not found in player page' };
  }

  let playerConfig;
  try {
    playerConfig = JSON.parse(configMatch[1]);
  } catch (err) {
    return { ok: false, step: 'step3_parse_config', error: err.message };
  }

  const apiToken = playerConfig.apiToken;
  if (!apiToken) {
    return { ok: false, step: 'step3_api_token', error: 'apiToken missing in player CONFIG' };
  }

  // Hop 4: data.vidsrc.sh api.php
  const step4Url = isTv
    ? `https://data.vidsrc.sh/api.php?type=tv&tmdb=${tmdbId}&season=${season}&episode=${episode}&stream_urls&api_token=${apiToken}`
    : `https://data.vidsrc.sh/api.php?type=movie&tmdb=${tmdbId}&stream_urls&api_token=${apiToken}`;

  let res4;
  try {
    res4 = await fetchWithRetry(step4Url, { headers: { Referer: `${shellHost}/` } });
  } catch (err) {
    return { ok: false, step: 'step4_api_php', error: err.message };
  }

  let data4;
  try {
    data4 = await res4.json();
  } catch (err) {
    return { ok: false, step: 'step4_parse_api', error: err.message };
  }

  if (!data4.vs || !data4.vs.wasm_url) {
    return { ok: false, step: 'step4_wasm_url', error: 'wasm_url missing in api.php response' };
  }
  if (!data4.data || !data4.data.stream_urls) {
    return { ok: false, step: 'step4_stream_urls', error: 'stream_urls missing in api.php response' };
  }

  // Hop 5: WASM download & decrypt
  const wasmUrl = data4.vs.wasm_url;
  let wasmRes;
  try {
    wasmRes = await fetchWithRetry(wasmUrl, { headers: { Referer: `${shellHost}/` } });
  } catch (err) {
    return { ok: false, step: 'step5_wasm_fetch', error: err.message };
  }

  let playlistUrls = [];
  try {
    const wasmBuffer = await wasmRes.arrayBuffer();
    const wasmModule = await WebAssembly.instantiate(wasmBuffer, {});
    const { alloc, decrypt, memory } = wasmModule.instance.exports;

    const encryptedBytes = Buffer.from(data4.data.stream_urls, 'base64');
    const ptr = alloc(encryptedBytes.length);
    new Uint8Array(memory.buffer).set(encryptedBytes, ptr);

    const outLen = decrypt(ptr, encryptedBytes.length);
    const decryptedBytes = new Uint8Array(memory.buffer).slice(ptr + 12, ptr + 12 + outLen);
    const decryptedText = new TextDecoder('utf-8').decode(decryptedBytes);

    playlistUrls = decryptedText
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.startsWith('http'));
  } catch (err) {
    return { ok: false, step: 'step5_wasm_decrypt', error: err.message };
  }

  if (playlistUrls.length === 0) {
    return { ok: false, step: 'step5_empty_playlists', error: 'Decrypted playlist URLs array is empty' };
  }

  // Hop 6: Generate JWT per mirror
  const servers = [];
  const mintedOrigins = new Map(); // one generate.php mint per mirror HOST, not per mirror
  for (let i = 0; i < playlistUrls.length; i++) {
    const pUrl = playlistUrls[i];
    const mirrorHost = new URL(pUrl).origin;

    let jwt;
    if (mintedOrigins.has(mirrorHost)) {
      jwt = await mintedOrigins.get(mirrorHost);
    } else {
      const mint = fetchGenerateJwt(`${mirrorHost}/generate.php`, shellHost);
      mintedOrigins.set(mirrorHost, mint);
      jwt = await mint;
    }
    servers.push({
      label: `Server ${i + 1}`,
      url: pUrl,
      token: jwt,
      kind: 'hls'
    });
  }

  // Hop 7: final hop test - try each mirror in order; one passing is enough
  // (previously only Server 1 was tested, so a dead mirror 1 forced a full
  // chain re-run even when mirrors 2/3 were healthy)
  let finalHopPassed = false;
  for (const srv of servers) {
    if (!srv.token) continue;
    try {
      const testUrl = `${srv.url}?token=${srv.token}`;
      const fRes = await fetchWithRetry(testUrl, { headers: { Referer: `${shellHost}/` } }, 0, 10000);
      if (fRes.status === 200) {
        finalHopPassed = true;
        break;
      }
    } catch (e) { /* try next mirror */ }
  }

  // Hop 8: pick subtitle tracks only - the SRT files are fetched lazily by
  // the client (via /mp/sub) AFTER playback starts, so subtitle downloads
  // never delay the stream.
  const defaultSubs = data4.default_subs || data4.data?.default_subs || [];
  const subs = pickSubs(defaultSubs);

  const meta = {
    title: data4.data?.title || '',
    file_name: data4.data?.file_name || '',
    imdb_id: data4.data?.imdb_id || '',
    backdrop: data4.data?.backdrop || ''
  };

  return {
    ok: true,
    finalHopPassed,
    servers,
    meta,
    subs,
    shellHost,
    resolvedAt: new Date().toISOString(),
    notes: `Resolved ${servers.length} servers via ${shellHost}. Final hop status: ${finalHopPassed ? '200 OK' : 'non-200/failed'}`
  };
}

/**
 * Pick up to 4 subtitle tracks ('en' always + up to 3 other languages).
 * URLs only - the text itself is fetched on demand.
 */
function pickSubs(defaultSubs) {
  if (!Array.isArray(defaultSubs) || defaultSubs.length === 0) return [];
  const langMap = new Map();
  const enSub = defaultSubs.find(s => s.code === 'en' || (s.lang && s.lang.toLowerCase().includes('english')));
  if (enSub) langMap.set('en', enSub);
  for (const s of defaultSubs) {
    const code = s.code || 'unknown';
    if (!langMap.has(code) && langMap.size < 4) langMap.set(code, s);
  }
  return Array.from(langMap.values()).map(s => ({ lang: s.lang || s.code, code: s.code, url: s.url }));
}

/**
 * Fetch ONE subtitle SRT on demand (used by /mp/sub).
 */
async function fetchSubSrt(subUrl, shellHost) {
  const res = await fetchWithRetry(subUrl, { headers: { Referer: `${shellHost}/` } }, 1, 10000);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 200 * 1024) throw new Error('subtitle too large');
  return Buffer.from(buf).toString('utf8');
}

/**
 * Public resolve function with retry policy (up to 3 fresh chains total if final hop or chain fails).
 */
async function resolve(params) {
  const maxChains = 3;
  let lastResult;

  for (let attempt = 1; attempt <= maxChains; attempt++) {
    const res = await resolveSingleChain(params);
    lastResult = res;

    // If chain succeeded and final hop passed (or servers resolved with tokens), we return
    if (res.ok && res.finalHopPassed) {
      delete res.finalHopPassed; // Clean internal test flag
      return res;
    }

    if (res.ok) {
      delete res.finalHopPassed;
      if (attempt === maxChains) {
        return res; // Return raw mirror URLs + tokens as required
      }
    }

    // Wait before next fresh chain
    await new Promise(r => setTimeout(r, 1000));
  }

  return lastResult || { ok: false, step: 'unknown', error: 'Chain resolution failed' };
}

module.exports = {
  resolve,
  fetchSubSrt
};
