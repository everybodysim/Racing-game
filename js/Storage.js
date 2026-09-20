/**
 * Storage.js — lossless, synchronous JSON/string compressor for localStorage.
 *
 * Why: custom mods and Blockly drafts are large (generated JS source + XML),
 * stored as `data:text/javascript;base64,...` and pretty-printed JSON, which
 * blow past the ~5 MB localStorage quota even for tiny mods. This module
 * stores a compressed, URI-safe representation and reads BOTH the new
 * compressed form AND legacy uncompressed values, so nothing can break:
 *   - If a value starts with the marker `ZC1:`, it's decoded (decompressed).
 *   - Otherwise the raw string is returned unchanged (legacy/JSON passthrough).
 *
 * The compressor is a self-contained, deterministic LZW variant packed with a
 * 16-bit index stream into a base64url string. It is purely synchronous (no
 * async, no Web APIs beyond TextEncoder/TextDecoder already used for `data:`
 * URLs elsewhere). Works both as an ES module (named exports) and as a classic
 * script (sets window.Storage).
 *
 * Public API:
 *   compressString(str)   -> compressed string ("ZC1:" + base64url), or raw if not smaller
 *   decompressString(str) -> original string (or raw input if not ours)
 *   compressJson(value)   -> compressed string of JSON.stringify(value)
 *   decompressJson(str, fallback) -> parsed value (or fallback on any error)
 *
 * Safety guarantees:
 *   - decompressString(compressString(x)) === x for every string x (roundtrip-tested).
 *   - Reading never throws: any decode failure returns the raw input / fallback.
 *   - Compress never throws: on any failure it returns the string unchanged.
 */
'use strict';

var MARKER = 'ZC1:';

function utf8ToBinary(str) {
  var bytes = new TextEncoder().encode(String(str == null ? '' : str));
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return bin;
}
function binaryToUtf8(bin) {
  var len = bin.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}

function btoaUrl(bin) {
  var b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function atobUrl(b64url) {
  var b64 = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  var pad = (4 - (b64.length % 4)) % 4;
  if (pad) b64 += '===='.slice(0, pad);
  return atob(b64);
}

var DICT_RESET = 0xFFFF;
var DICT_MAX = 0xFFFF;

function lzwCompressBin(data) {
  var out = [];
  var dict = {};
  var size = 256;
  for (var i = 0; i < 256; i++) dict[String.fromCharCode(i)] = i;

  var w = '';
  for (var k = 0; k < data.length; k++) {
    var c = data.charAt(k);
    var wc = w + c;
    if (dict[wc] !== undefined) {
      w = wc;
    } else {
      out.push(dict[w]);
      if (size >= DICT_MAX) {
        out.push(DICT_RESET);
        dict = {};
        for (var j = 0; j < 256; j++) dict[String.fromCharCode(j)] = j;
        size = 256;
      } else {
        dict[wc] = size++;
      }
      w = c;
    }
  }
  if (w.length) out.push(dict[w]);

  var bin = '';
  for (var p = 0; p < out.length; p++) {
    var code = out[p] & 0xffff;
    bin += String.fromCharCode((code >> 8) & 0xff, code & 0xff);
  }
  return bin;
}

function lzwDecompressBin(bin) {
  if (!bin.length) return '';
  if (bin.length % 2 !== 0) throw new Error('badLZW');

  var dict = [];
  var size = 256;
  for (var d = 0; d < 256; d++) dict[d] = String.fromCharCode(d);

  var n = bin.length;
  var codes = [];
  for (var q = 0; q + 1 < n; q += 2) {
    codes.push(((bin.charCodeAt(q) & 0xff) << 8) | (bin.charCodeAt(q + 1) & 0xff));
  }

  var out = [];
  var w = '';
  var first = true;
  for (var idx = 0; idx < codes.length; idx++) {
    var code = codes[idx];
    if (code === DICT_RESET) {
      dict = [];
      size = 256;
      for (var e = 0; e < 256; e++) dict[e] = String.fromCharCode(e);
      first = true;
      w = '';
      continue;
    }
    var entry;
    if (first) {
      entry = dict[code] != null ? dict[code] : '';
      if (entry === '' && dict[code] == null) throw new Error('badLZW');
      out.push(entry);
      w = entry;
      first = false;
      continue;
    }
    if (dict[code] != null) {
      entry = dict[code];
    } else if (code === size) {
      entry = w + w.charAt(0);
    } else {
      throw new Error('badLZW');
    }
    out.push(entry);
    if (size < DICT_MAX) dict[size++] = w + entry.charAt(0);
    w = entry;
  }
  return out.join('');
}

function compressString(str) {
  try {
    var s = String(str == null ? '' : str);
    if (!s.length) return MARKER + btoaUrl('');
    var bin = utf8ToBinary(s);
    var packed = lzwCompressBin(bin);
    var enc = btoaUrl(packed);
    var out = MARKER + enc;
    return out.length < s.length ? out : s;
  } catch (e) {
    return String(str == null ? '' : str);
  }
}

function decompressString(str) {
  var s = String(str == null ? '' : str);
  if (s.indexOf(MARKER) !== 0) return s;
  try {
    var enc = s.slice(MARKER.length);
    var packed = atobUrl(enc);
    var bin = lzwDecompressBin(packed);
    return binaryToUtf8(bin);
  } catch (e) {
    return s;
  }
}

function compressJson(value) {
  try {
    return compressString(JSON.stringify(value));
  } catch (e) {
    try { return JSON.stringify(value); } catch { return ''; }
  }
}

function decompressJson(str, fallback) {
  try {
    var raw = decompressString(str);
    return JSON.parse(raw);
  } catch (e) {
    return arguments.length > 1 ? fallback : null;
  }
}

// Personal-best ghost samples are huge compared with the PB time. Keep the
// personal-best time, but never persist the local replay payload that recreates
// the PB ghost. This is intentionally scoped to racing-lap-stats:* only, so
// every other localStorage feature keeps its existing behavior.
function installLapGhostStorageGuard() {
  if (typeof window === 'undefined' || !window.Storage || window.__racingLapGhostStorageGuard) return;
  var proto = window.Storage.prototype;
  if (!proto || typeof proto.setItem !== 'function' || typeof proto.getItem !== 'function') return;

  var originalSetItem = proto.setItem;
  var originalGetItem = proto.getItem;
  var LAP_PREFIX = 'racing-lap-stats:';
  var GHOST_FIELDS = [
    'bestGhostDuration',
    'bestGhostCarKey',
    'bestGhostCosmetics',
    'bestLapGhostSamples',
    'bestLapInputFrames',
  ];

  function stripGhostFields(raw) {
    if (typeof raw !== 'string' || !raw) return raw;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
      var changed = false;
      for (var i = 0; i < GHOST_FIELDS.length; i++) {
        if (Object.prototype.hasOwnProperty.call(parsed, GHOST_FIELDS[i])) {
          delete parsed[GHOST_FIELDS[i]];
          changed = true;
        }
      }
      return changed ? JSON.stringify(parsed) : raw;
    } catch (e) {
      return raw;
    }
  }

  try {
    proto.setItem = function(key, value) {
      var k = String(key);
      var v = k.indexOf(LAP_PREFIX) === 0 ? stripGhostFields(String(value)) : value;
      return originalSetItem.call(this, key, v);
    };
    proto.getItem = function(key) {
      var raw = originalGetItem.call(this, key);
      var k = String(key);
      if (k.indexOf(LAP_PREFIX) !== 0 || raw == null) return raw;
      var cleaned = stripGhostFields(raw);
      if (cleaned !== raw) originalSetItem.call(this, key, cleaned);
      return cleaned;
    };
    window.__racingLapGhostStorageGuard = true;
  } catch (e) {
    // Never interfere with game startup if a browser disallows patching Storage.
  }
}

// Storage.js is imported by main.js before lap persistence is used, so this
// also cleans old oversized PB ghost entries the first time they are read.
installLapGhostStorageGuard();

var StorageApi = {
  MARKER: MARKER,
  compressString: compressString,
  decompressString: decompressString,
  compressJson: compressJson,
  decompressJson: decompressJson,
};

if (typeof window !== 'undefined') {
  window.Storage = StorageApi;
}

export { compressString, decompressString, compressJson, decompressJson, MARKER, StorageApi as Storage };
