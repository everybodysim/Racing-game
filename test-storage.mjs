// Roundtrip correctness test for js/Storage.js — run with: node test-storage.mjs
import * as StorageNS from './js/Storage.js';
const Storage = StorageNS;

// Minimal TextEncoder/TextDecoder polyfill for Node global (Storage uses them).
if (!globalThis.TextEncoder) {
  const { TextEncoder, TextDecoder } = await import('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

let pass = 0, fail = 0;
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!deepEq(a[k], b[k])) return false; }
    return true;
  }
  return false;
}
function t(name, actual, expected) {
  const aok = deepEq(actual, expected);
  if (aok) { pass++; }
  else { fail++; console.error(`FAIL: ${name}\n  expected: ${JSON.stringify(expected).slice(0,200)}\n  actual:   ${JSON.stringify(actual).slice(0,200)}`); }
}

// 1. Empty string
t('empty', Storage.decompressString(Storage.compressString('')), '');
// 2. ASCII short
t('ascii', Storage.decompressString(Storage.compressString('Hello, World!')), 'Hello, World!');
// 3. Highly repetitive (LZW should crush this)
const rep = 'abc'.repeat(50000);
t('repetitive long', Storage.decompressString(Storage.compressString(rep)), rep);
// 4. Unicode (emoji, accents, CJK, math)
const uni = 'café — résumé ✓ 日本語 🏁 αβγδ 𝕳𝖊𝖑𝖑𝖔\n\ttab\r\n';
t('unicode', Storage.decompressString(Storage.compressString(uni)), uni);
// 5. Long unicode mix
const uniMix = ('café 日本 🏁 alphaβ ').repeat(2000);
t('unicode mix long', Storage.decompressString(Storage.compressString(uniMix)), uniMix);
// 6. Binary-ish bytes (all 0..255 via binary string from base64-ish content)
let bin = '';
for (let i = 0; i < 256; i++) bin += String.fromCharCode(i);
t('all byte values', Storage.decompressString(Storage.compressString(bin)), bin);
// 7. Realistic JS source (similar to generated mod template)
const js = `// My Mod\nconst SPEC = ${JSON.stringify({onStart:[{type:'set_speed',value:5}],onTick:[{type:'set_gravity',value:9.8}],onKey:{'KeyR':[{type:'respawn'}]}}, null, 2)};\nexport default { id:'custom-x', init(){}, applyFrame(){return null;}, dispose(){} };\n`.repeat(30);
t('js source', Storage.decompressString(Storage.compressString(js)), js);
// 8. JSON roundtrip
const obj = { a: 1, b: 'café', c: [1,2,3,{d:'🏁'}], nested: { deep: { x: 'a'.repeat(1000) } } };
t('json', Storage.decompressJson(Storage.compressJson(obj)), obj);
// 9. Legacy passthrough (uncompressed JSON)
t('legacy passthrough', Storage.decompressString(JSON.stringify({a:1})), JSON.stringify({a:1}));
// 10. Legacy passthrough -> decompressJson still parses plain JSON
t('legacy json', Storage.decompressJson(JSON.stringify({a:1})), {a:1});
// 11. decompressJson fallback on garbage
t('json fallback', Storage.decompressJson('not json', {fallback:true}), {fallback:true});
// 12. Never throws on garbage compressed input
const garbage = 'ZC1:!!!notvalidbase64!!!';
const gout = Storage.decompressString(garbage);
t('garbage no throw returns input', typeof gout === 'string', true);
// 13. compressString never returns LARGER than input (falls back to raw)
const tiny = 'a';
t('tiny not bigger', Storage.compressString(tiny).length <= tiny.length, true);
// 14. Big string actually compresses (savings)
const big = 'const x = 1;\n'.repeat(100000);
const comp = Storage.compressString(big);
t('big compresses', comp.length < big.length, true);
const ratio = (comp.length / big.length * 100).toFixed(1);
console.log(`big-source compression ratio: ${ratio}% of original (${big.length} -> ${comp.length})`);
// 15. Real generated-template-like content (large SPEC) roundtrip + savings
const bigSpec = { onStart: [], onTick: [], onKey: {}, onKeyHold: {}, onKeyRelease: {}, onSpeedThreshold: [], onLowSpeed: [], onHighSpeed: [], onLowSpeedHeld: [], onAir: [], onGround: [], onDrift: [], onCheckpoint: [], onCrash: [], onRespawn: [], onLapFinish: [], onTimerDone: {} };
for (let i=0;i<500;i++){ bigSpec.onTick.push({type:'set_speed', value: Math.random()}); bigSpec.onKey['Key'+i] = [{type:'set_gravity', value: i}]; }
const bigTpl = `// Big Mod\nconst SPEC = ${JSON.stringify(bigSpec, null, 2)};\nexport default { id:'custom-big', init(){}, applyFrame(){return null;}, dispose(){} };\n`;
const bigComp = Storage.compressString(bigTpl);
t('big tpl roundtrip', Storage.decompressString(bigComp), bigTpl);
console.log(`big-template compression ratio: ${(bigComp.length/bigTpl.length*100).toFixed(1)}% (${bigTpl.length} -> ${bigComp.length})`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
