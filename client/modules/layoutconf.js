/* Vidium layout.conf parser + defaults
 * INI-style: [section] / key = value, comments with # or ;
 * values: true|false, numbers, #hex, "quoted strings"
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    brand: { name: 'Vidium', accent: '#8B5CF6' },
    controls: {
      servers: true, quality: true, speed: true, subtitles: true, audio: true,
      pip: true, next: true, episodes: true, settings: true, fullscreen: true, volume_slider: true
    },
    idle_screen: { enabled: true, autoplay: true, eyebrow_text: "YOU'RE WATCHING", show_description: true, show_meta: true, dim: 0.55, backdrop_zoom: true, animate: true },
    pause_info: { enabled: true, delay: 0, show_episode_overview: true, show_rating: true, show_genres: true },
    skip_intro: { enabled: true, button_text: 'Skip Intro', show_at: 3, default_seek: 85, auto_hide_after: 115, use_introdb: true },
    next_episode: { enabled: true, show_before_end: 75, button_text: 'Play Now', auto_play: true, countdown: 10, end_delay: 4 },
    episodes_panel: { enabled: true, show_air_dates: true },
    subtitles: { size: 1, color: '#ffffff', bg_opacity: 0, position: 64, edge: 'outline' },
    audio: { default_mode: 'mono', default_boost: 4, auto_repair: true },
    gestures: { double_tap_seek: 10, long_press_marks_intro: true },
    player: { resume: true, title_overlay: true }
  };

  function parseValue(raw) {
    raw = String(raw).trim();
    if (/^".*"$/s.test(raw)) return raw.slice(1, -1);
    if (/^'.*'$/s.test(raw)) return raw.slice(1, -1);
    var low = raw.toLowerCase();
    if (low === 'true') return true;
    if (low === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
    return raw;
  }

  /* strip trailing comment: unquoted ; or # terminates the value */
  function stripComment(v) {
    v = v.trim();
    var q = v.charAt(0);
    if (q === '"' || q === "'") {
      var end = v.indexOf(q, 1);
      return end > -1 ? v.slice(1, end) : v.slice(1);
    }
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v; /* hex color is not a comment */
    var cut = v.length;
    [';', '#'].forEach(function (c) {
      var i = v.indexOf(c);
      if (i > -1 && i < cut) cut = i;
    });
    return v.slice(0, cut).trim();
  }

  function parse(text) {
    var conf = {};
    var section = null;
    String(text).split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) === '#' || line.charAt(0) === ';') return;
      var m = /^\[([^\]]+)\]$/.exec(line);
      if (m) { section = m[1].trim().toLowerCase(); if (!conf[section]) conf[section] = {}; return; }
      var kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (kv && section) {
        conf[section][kv[1].trim().toLowerCase()] = parseValue(stripComment(kv[2]));
      }
    });
    return conf;
  }

  function merge(defaults, overrides) {
    var out = {};
    Object.keys(defaults).forEach(function (sec) {
      out[sec] = {};
      Object.keys(defaults[sec]).forEach(function (k) {
        var ov = overrides && overrides[sec] && overrides[sec][k];
        out[sec][k] = (ov === undefined || ov === null) ? defaults[sec][k] : ov;
      });
    });
    return out;
  }

  function load(url) {
    var base = url || '/v/layout.conf';
    return fetch(base).then(function (r) {
      if (!r.ok) throw new Error('conf HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      return merge(DEFAULTS, parse(text));
    }).catch(function () { return merge(DEFAULTS, {}); });
  }

  root.LayoutConf = { load: load, parse: parse, merge: merge, defaults: function () { return merge(DEFAULTS, {}); } };
})(typeof window !== 'undefined' ? window : this);
