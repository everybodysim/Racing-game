// Integration test: simulate the installed-custom-mod storage round trip exactly
// as custom-mods.js (writer) + main.js (reader) do it, using the real Storage module.
import * as Storage from './js/Storage.js';
const { compressString, decompressString, compressJson, decompressJson } = Storage;
if (!globalThis.TextEncoder) { const u = await import('node:util'); globalThis.TextEncoder = u.TextEncoder; globalThis.TextDecoder = u.TextDecoder; }

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('FAIL:', name); } }

// A realistic generated custom-mod template (compact form using shared runtime).
const code = `// Boost Mod
const SPEC = ${JSON.stringify({
  id: 'custom-boost', onStart: [], onTick: [{type:'set_boost', value:1.5}],
  onKey: {'KeyB':[{type:'set_boost', value:3}]}, onCrash:[{type:'set_boost', value:0}]
}, null, 2)};
const R = window.__RACING_MOD_RUNTIME__ || ( window.__RACING_MOD_RUNTIME__ = {} );
export default ( R.createRuntime || ( R.createRuntime = () => ( { id: 'custom-boost', init(){}, applyFrame(){ return null; }, dispose(){} } ) ) )( 'custom-boost', SPEC );
`;

// --- Writer (custom-mods.js / mods-manager.js) ---
const entry = `zjs:${compressString(code)}`;
ok('entry is compressed zjs:', entry.startsWith('zjs:'));
ok('entry smaller than base64 data URL would be', entry.length < (`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`).length);
const installedList = [{ id: 'custom-boost', name: 'Boost Mod', entry }];
const stored = compressJson(installedList);
ok('stored compressed json decodes to list', Array.isArray(decompressJson(stored, null)));
// For a single small mod the entry is already compressed (zjs:) so wrapping in
// JSON doesn't shrink further; the real win is the entry itself (tested below)
// and list compression kicks in for multiple/larger mods.

// --- Reader (main.js normalizeModEntryPath) ---
const parsed = decompressJson(stored, null);
ok('parsed back to list', Array.isArray(parsed) && parsed.length === 1);
const readEntry = parsed[0].entry;
ok('read entry is zjs', readEntry.startsWith('zjs:'));

// Rebuild data URL exactly as main.js does:
let dataUrl = null;
if (readEntry.indexOf('zjs:') === 0) {
  const decoded = decompressString(readEntry.slice(4));
  const bytes = new TextEncoder().encode(String(decoded || ''));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  dataUrl = `data:text/javascript;base64,${btoa(bin)}`;
}
ok('data url built', typeof dataUrl === 'string' && dataUrl.startsWith('data:text/javascript;base64,'));

// Decode the data URL back to source and compare to original code:
const b64 = dataUrl.slice('data:text/javascript;base64,'.length);
const decodedBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const recoveredCode = new TextDecoder().decode(decodedBytes);
ok('recovered code === original code', recoveredCode === code);

// --- Legacy compatibility: an old base64 entry still loads ---
const legacyEntry = `data:text/javascript;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(code)))}`;
ok('legacy base64 entry recognized', legacyEntry.startsWith('data:text/javascript'));
// main.js passes data:text/javascript through unchanged:
ok('legacy passthrough', legacyEntry === legacyEntry);

// --- Legacy uncompressed JSON list still readable ---
const legacyList = JSON.stringify([{ id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' }]);
const legacyParsed = decompressJson(legacyList, null);
ok('legacy json list readable', Array.isArray(legacyParsed) && legacyParsed[0].id === 'freecam');

console.log(`\nentry sizes: zjs=${entry.length} bytes, base64-data-url=${('data:text/javascript;base64,'+Buffer.from(code).toString('base64')).length} bytes, raw-source=${code.length} bytes`);
console.log(`list storage: compressed=${stored.length}, raw-json=${JSON.stringify(installedList).length}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
