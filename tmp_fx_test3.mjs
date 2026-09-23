import { chromium } from 'playwright';
const browser = await chromium.launch();
function mkUrl({cells, e=[], u=[]}) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64');
  return `index.html?map=v2.${Buffer.from(JSON.stringify({v:2,cells})).toString('base64')}&mods=${enc({e,u})}`;
}
async function boot(url, drive=false, ms=5000, sampleEvery=50) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0,150)));
  await page.goto('http://localhost:8902/' + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  if (drive) await page.keyboard.down('ArrowUp');
  const samples = [];
  for (let i = 0; i < ms/sampleEvery; i++) {
    await page.waitForTimeout(sampleEvery);
    samples.push(await page.evaluate(() => window.__velProbe ? window.__velProbe() : null));
  }
  if (drive) await page.keyboard.up('ArrowUp');
  await page.close();
  return { samples, errors };
}

// T1: spawn ON trampoline — must settle (diminishing hops, then REST)
let r = await boot(mkUrl({ cells: [[0,0,"track-start-finish",0],[0,1,"track-straight",0],[0,2,"track-finish",0]], u: [[0,0,"surface-trampoline",0]] }), false, 5000, 60);
let vy = r.samples.map(s => s?.v[1] ?? 0);
const earlySpikes = vy.slice(0, 25).filter(v => v > 1.3).length;
const lateSpikes = vy.slice(40).filter(v => v > 0.8).length;
const lastCalm = vy.slice(-15).every(v => Math.abs(v) < 0.3);
console.log(`T1 settle: earlyBounces=${earlySpikes} lateSpikes=${lateSpikes} settled=${lastCalm} => ${lateSpikes === 0 && lastCalm ? 'PASS: bounces then rests (no ground-bounce)' : 'FAIL'}`);
console.log('T1 vy tail:', vy.slice(-25).map(v => v.toFixed(1)).join(','));

// T2: air control stronger + 55mph cap on drag strip
const strip = [[0, 0, "track-start-finish", 0], [0, 1, "track-straight", 0], [0, 2, "track-straight", 0], [0, 3, "track-straight", 0], [0, 4, "track-straight", 0], [0, 5, "track-straight", 0], [0, 6, "track-straight", 0], [0, 7, "track-straight", 0], [0, 8, "track-straight", 0], [0, 9, "track-straight", 0], [0, 10, "track-straight", 0], [0, 11, "track-straight", 0], [0, 12, "track-straight", 0], [0, 13, "track-straight", 0], [0, 14, "track-straight", 0], [0, 15, "track-straight", 0], [0, 16, "track-straight", 0], [0, 17, "track-straight", 0], [0, 18, "track-finish", 0]];

async function stripRun(u) {
  const r = await boot(mkUrl({ cells: strip, u }), true, 6000, 100);
  const mph = r.samples.map(s => s?.mph ?? 0);
  const vy = r.samples.map(s => s?.v[1] ?? 0);
  const airFrames = r.samples.filter(s => (s?.y ?? 0) > 0.9 || Math.abs(s?.v[1] ?? 0) > 0.35);
  console.log(`  maxMph=${Math.max(...mph).toFixed(1)} endMph=${mph[mph.length-1].toFixed(1)} maxVy=${Math.max(...vy).toFixed(2)} airborneSamples=${airFrames.length} errors=${r.errors.length ? r.errors : 0}`);
  return { maxMph: Math.max(...mph), air: airFrames.length };
}
console.log('T2 WITH pad (expect mph capped ~<=58, strong accel):');
const pad = await stripRun([[0,1,"pad-air-control",0],[0,2,"surface-trampoline",0]]);
console.log('T2 NO pad (baseline):');
const base = await stripRun([[0,2,"surface-trampoline",0]]);
const capped = pad.maxMph < 58.5;
console.log(`T2 => ${capped ? 'PASS' : 'FAIL'}: pad max ${pad.maxMph.toFixed(1)} mph vs baseline ${base.maxMph.toFixed(1)} mph`);
await browser.close();
