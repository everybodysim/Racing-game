const DRAFT_KEY = 'racing-custom-mods-workspace-v2';
const SHARED_KEY = 'racing-shared-custom-mods-v1';

function setStatus(message) {
  const el = document.getElementById('status');
  if (el) el.textContent = message;
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
}

Blockly.Blocks.event_on_start = { init() { this.appendDummyInput().appendField('when race starts'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };
Blockly.Blocks.event_on_tick = { init() { this.appendDummyInput().appendField('every tick'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };
Blockly.Blocks.event_on_key = { init() { this.appendDummyInput().appendField('when key').appendField(new Blockly.FieldDropdown([['W','KeyW'],['A','KeyA'],['S','KeyS'],['D','KeyD'],['Space','Space']]),'KEY').appendField('pressed'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };
Blockly.Blocks.event_on_checkpoint = { init() { this.appendDummyInput().appendField('when checkpoint reached'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };
Blockly.Blocks.event_on_crash = { init() { this.appendDummyInput().appendField('when vehicle crashes'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };
Blockly.Blocks.event_on_lap_finish = { init() { this.appendDummyInput().appendField('when lap finishes'); this.appendStatementInput('DO').appendField('do'); this.setColour('#f59e0b'); } };

Blockly.Blocks.action_set_speed = { init() { this.appendValueInput('SPEED').setCheck('Number').appendField('set car speed to'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_boost = { init() { this.appendValueInput('AMOUNT').setCheck('Number').appendField('boost by'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_show_message = { init() { this.appendValueInput('TEXT').appendField('show message'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_set_gravity = { init() { this.appendValueInput('G').setCheck('Number').appendField('set gravity to'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_spawn_particle = { init() { this.appendDummyInput().appendField('spawn smoke particle'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_camera_shake = { init() { this.appendValueInput('INT').setCheck('Number').appendField('camera shake intensity'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_jump = { init() { this.appendValueInput('POWER').setCheck('Number').appendField('jump with power'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_reset_car = { init() { this.appendDummyInput().appendField('reset car to spawn'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_set_time_scale = { init() { this.appendValueInput('SCALE').setCheck('Number').appendField('set game speed scale'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_add_coins = { init() { this.appendValueInput('COINS').setCheck('Number').appendField('add coins'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };

Blockly.Blocks.value_speed = { init() { this.appendDummyInput().appendField('current speed'); this.setOutput(true, 'Number'); this.setColour('#22c55e'); } };
Blockly.Blocks.value_lap_time = { init() { this.appendDummyInput().appendField('current lap time'); this.setOutput(true, 'Number'); this.setColour('#22c55e'); } };
Blockly.Blocks.value_checkpoint_number = { init() { this.appendDummyInput().appendField('checkpoint number'); this.setOutput(true, 'Number'); this.setColour('#22c55e'); } };
Blockly.Blocks.value_crash_force = { init() { this.appendDummyInput().appendField('crash force'); this.setOutput(true, 'Number'); this.setColour('#22c55e'); } };
Blockly.Blocks.value_random = { init() { this.appendDummyInput().appendField('random 0 to 1'); this.setOutput(true, 'Number'); this.setColour('#22c55e'); } };

const workspace = Blockly.inject('blocklyDiv', { toolbox: document.getElementById('toolbox'), trashcan: true, zoom: { controls: true, wheel: true, startScale: 0.95 } });

function exportXmlPretty() { return Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(workspace)); }
function loadXmlText(text) { Blockly.Xml.clearWorkspaceAndLoadFromXml(Blockly.Xml.textToDom(text), workspace); }

function parseValueBlock(block) {
  if (!block) return null;
  if (block.type === 'math_number') {
    const raw = Number(block.getFieldValue('NUM'));
    return Number.isFinite(raw) ? raw : 0;
  }
  if (block.type === 'text') return String(block.getFieldValue('TEXT') || '');
  if (block.type === 'math_arithmetic') {
    const op = block.getFieldValue('OP');
    const a = parseValueBlock(block.getInputTargetBlock('A')) ?? 0;
    const b = parseValueBlock(block.getInputTargetBlock('B')) ?? 0;
    return { kind: 'math', op, a, b };
  }
  if (block.type === 'value_speed') return { kind: 'runtime', name: 'speed' };
  if (block.type === 'value_lap_time') return { kind: 'runtime', name: 'lapTime' };
  if (block.type === 'value_checkpoint_number') return { kind: 'runtime', name: 'checkpointNumber' };
  if (block.type === 'value_crash_force') return { kind: 'runtime', name: 'crashForce' };
  if (block.type === 'value_random') return { kind: 'runtime', name: 'random' };
  return null;
}

function parseActionStatement(block) {
  if (!block) return null;
  if (block.type === 'action_set_speed') return { type: 'set_speed', value: parseValueBlock(block.getInputTargetBlock('SPEED')) ?? 0 };
  if (block.type === 'action_boost') return { type: 'boost', value: parseValueBlock(block.getInputTargetBlock('AMOUNT')) ?? 0 };
  if (block.type === 'action_set_gravity') return { type: 'set_gravity', value: parseValueBlock(block.getInputTargetBlock('G')) ?? 9.81 };
  if (block.type === 'action_show_message') return { type: 'show_message', value: parseValueBlock(block.getInputTargetBlock('TEXT')) ?? '' };
  if (block.type === 'action_spawn_particle') return { type: 'spawn_particle' };
  if (block.type === 'action_camera_shake') return { type: 'camera_shake', value: parseValueBlock(block.getInputTargetBlock('INT')) ?? 1 };
  if (block.type === 'action_jump') return { type: 'jump', value: parseValueBlock(block.getInputTargetBlock('POWER')) ?? 6 };
  if (block.type === 'action_reset_car') return { type: 'reset_car' };
  if (block.type === 'action_set_time_scale') return { type: 'set_time_scale', value: parseValueBlock(block.getInputTargetBlock('SCALE')) ?? 1 };
  if (block.type === 'action_add_coins') return { type: 'add_coins', value: parseValueBlock(block.getInputTargetBlock('COINS')) ?? 0 };
  return null;
}

function parseStatementChain(firstBlock) {
  const actions = [];
  let cursor = firstBlock;
  while (cursor) {
    const parsed = parseActionStatement(cursor);
    if (parsed) actions.push(parsed);
    cursor = cursor.getNextBlock();
  }
  return actions;
}

function buildRuntimeSpec() {
  const spec = { onStart: [], onTick: [], onKey: {}, onCheckpoint: [], onCrash: [], onLapFinish: [] };
  const tops = workspace.getTopBlocks(true);
  for (const block of tops) {
    if (block.type === 'event_on_start') spec.onStart.push(...parseStatementChain(block.getInputTargetBlock('DO')));
    if (block.type === 'event_on_tick') spec.onTick.push(...parseStatementChain(block.getInputTargetBlock('DO')));
    if (block.type === 'event_on_checkpoint') spec.onCheckpoint.push(...parseStatementChain(block.getInputTargetBlock('DO')));
    if (block.type === 'event_on_crash') spec.onCrash.push(...parseStatementChain(block.getInputTargetBlock('DO')));
    if (block.type === 'event_on_lap_finish') spec.onLapFinish.push(...parseStatementChain(block.getInputTargetBlock('DO')));
    if (block.type === 'event_on_key') {
      const key = block.getFieldValue('KEY') || 'KeyW';
      spec.onKey[key] = [ ...(spec.onKey[key] || []), ...parseStatementChain(block.getInputTargetBlock('DO')) ];
    }
  }
  return spec;
}

function renderActionsRuntimeCode() {
  return `
function resolveValue(value, ctx, event = {}) {
  if (value && typeof value === 'object') {
    if (value.kind === 'runtime') {
      if (value.name === 'speed') return Math.abs(Number(ctx?.vehicle?.linearSpeed) || 0);
      if (value.name === 'lapTime') return Number(event.lapTime ?? event.now) || 0;
      if (value.name === 'checkpointNumber') return Number(event.checkpointNumber) || 0;
      if (value.name === 'crashForce') return Number(event.impactVelocity) || 0;
      if (value.name === 'random') return Math.random();
    }
    if (value.kind === 'math') {
      const a = Number(resolveValue(value.a, ctx, event)) || 0;
      const b = Number(resolveValue(value.b, ctx, event)) || 0;
      if (value.op === 'ADD') return a + b;
      if (value.op === 'MINUS') return a - b;
      if (value.op === 'MULTIPLY') return a * b;
      if (value.op === 'DIVIDE') return b === 0 ? 0 : a / b;
    }
  }
  return value;
}
function runActions(actions, ctx, event = {}) {
  const api = ctx?.api || {};
  for (const action of actions || []) {
    if (!action || !action.type) continue;
    const value = resolveValue(action.value, ctx, event);
    if (action.type === 'set_speed') {
      const velocity = Number(value) || 0;
      if (typeof api.setSpeed === 'function') api.setSpeed(velocity, event);
      else if (ctx?.vehicle && Number.isFinite(velocity)) ctx.vehicle.linearSpeed = velocity;
    }
    if (action.type === 'boost' && Number.isFinite(Number(value))) {
      if (typeof api.boost === 'function') api.boost(Number(value), event);
      else if (ctx?.vehicle) ctx.vehicle.linearSpeed += Number(value) * 0.02;
    }
    if (action.type === 'set_gravity') {
      const g = Number(value) || 9.81;
      if (typeof api.setGravity === 'function') api.setGravity(g, event);
    }
    if (action.type === 'show_message') {
      const message = String(value ?? '');
      if (message) {
        if (typeof api.showMessage === 'function') api.showMessage(message, event);
        else console.log('[custom-mod]', message);
      }
    }
    if (action.type === 'spawn_particle' && typeof api.spawnParticle === 'function') api.spawnParticle(event);
    if (action.type === 'camera_shake' && typeof api.cameraShake === 'function') api.cameraShake(Number(value) || 1, event);
    if (action.type === 'jump' && typeof api.jump === 'function') api.jump(Number(value) || 6, event);
    if (action.type === 'reset_car' && typeof api.resetCar === 'function') api.resetCar(event);
    if (action.type === 'set_time_scale' && typeof api.setTimeScale === 'function') api.setTimeScale(Number(value) || 1, event);
    if (action.type === 'add_coins' && typeof api.addCoins === 'function') api.addCoins(Number(value) || 0, event);
  }
}
`;
}

function generateTemplate(xmlText) {
  const id = safeId(document.getElementById('mod-id')?.value) || `custom-${Date.now()}`;
  const name = (document.getElementById('mod-name')?.value || 'Custom Mod').trim();
  const spec = buildRuntimeSpec();
  return `// ${name}\nconst SPEC = ${JSON.stringify(spec, null, 2)};\n${renderActionsRuntimeCode()}\nexport default {\n  id: ${JSON.stringify(id)},\n  init(context) {\n    this.ctx = context;\n    this.keyLatch = Object.create(null);\n    runActions(SPEC.onStart, context, { type: 'start' });\n  },\n  applyFrame({ controls, vehicle, world, dt, now }) {\n    const ctx = this.ctx || { vehicle, world, controls };\n    runActions(SPEC.onTick, ctx, { type: 'tick', dt, now });\n    for (const [key, actions] of Object.entries(SPEC.onKey || {})) {\n      const down = Boolean(controls?.keys?.[key]);\n      if (down && !this.keyLatch[key]) runActions(actions, ctx, { type: 'key', key });\n      this.keyLatch[key] = down;\n    }\n  },\n  onCheckpoint(event) {\n    runActions(SPEC.onCheckpoint, this.ctx, { type: 'checkpoint', ...(event || {}) });\n  },\n  onCrash(event) {\n    runActions(SPEC.onCrash, this.ctx, { type: 'crash', ...(event || {}) });\n  },\n  dispose() {\n    this.ctx = null;\n    this.keyLatch = Object.create(null);\n  }\n};\n`;
}


function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(raw) {
  const norm = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '==='.slice((norm.length + 3) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getSharePayload() {
  const xml = exportXmlPretty();
  const template = generateTemplate(xml);
  return {
    type: 'racing-custom-mod-share-v1',
    modId: safeId(document.getElementById('mod-id')?.value),
    modName: (document.getElementById('mod-name')?.value || '').trim(),
    xml,
    template,
    createdAt: new Date().toISOString()
  };
}

function applySharePayload(payload) {
  if (!payload || payload.type !== 'racing-custom-mod-share-v1') throw new Error('Unsupported share payload');
  document.getElementById('mod-id').value = payload.modId || '';
  document.getElementById('mod-name').value = payload.modName || '';
  document.getElementById('xmlBox').value = payload.xml || '';
  if (payload.xml) loadXmlText(payload.xml);
}

document.getElementById('export-xml')?.addEventListener('click', () => { document.getElementById('xmlBox').value = exportXmlPretty(); setStatus('XML exported'); });
document.getElementById('import-xml')?.addEventListener('click', () => { try { loadXmlText(document.getElementById('xmlBox').value); setStatus('XML imported'); } catch { setStatus('Invalid XML'); } });
document.getElementById('export-template')?.addEventListener('click', () => { document.getElementById('xmlBox').value = generateTemplate(exportXmlPretty()); setStatus('JS template generated'); });


document.getElementById('save-draft')?.addEventListener('click', () => {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ modId: document.getElementById('mod-id').value, modName: document.getElementById('mod-name').value, xml: exportXmlPretty() }));
  setStatus('Draft saved');
});

document.getElementById('load-draft')?.addEventListener('click', () => {
  const raw = localStorage.getItem(DRAFT_KEY); if (!raw) return setStatus('No draft found');
  const p = JSON.parse(raw); document.getElementById('mod-id').value = p.modId || ''; document.getElementById('mod-name').value = p.modName || ''; document.getElementById('xmlBox').value = p.xml || ''; if (p.xml) loadXmlText(p.xml); setStatus('Draft loaded');
});

document.getElementById('export-share')?.addEventListener('click', async () => {
  const packed = toBase64Url(JSON.stringify(getSharePayload()));
  const url = `${location.origin}${location.pathname}?share=${encodeURIComponent(packed)}`;
  document.getElementById('xmlBox').value = url;
  try { await navigator.clipboard.writeText(url); setStatus('Share URL copied'); } catch { setStatus('Share URL generated'); }
});

document.getElementById('save-to-manager')?.addEventListener('click', () => {
  const payload = getSharePayload();
  const arr = JSON.parse(localStorage.getItem(SHARED_KEY) || '[]').filter((x) => x.modId !== payload.modId);
  arr.push(payload);
  localStorage.setItem(SHARED_KEY, JSON.stringify(arr));
  setStatus('Saved to Mod Manager imports');
});

const shareParam = new URLSearchParams(location.search).get('share');
if (shareParam) {
  try { applySharePayload(JSON.parse(fromBase64Url(shareParam))); setStatus('Loaded shared mod from URL'); } catch { setStatus('Invalid shared URL payload'); }
} else {
  setStatus('Workspace loaded');
}
