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

Blockly.Blocks.action_set_speed = { init() { this.appendValueInput('SPEED').setCheck('Number').appendField('set car speed to'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_boost = { init() { this.appendValueInput('AMOUNT').setCheck('Number').appendField('boost by'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_show_message = { init() { this.appendValueInput('TEXT').appendField('show message'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_set_gravity = { init() { this.appendValueInput('G').setCheck('Number').appendField('set gravity to'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_spawn_particle = { init() { this.appendDummyInput().appendField('spawn smoke particle'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };
Blockly.Blocks.action_camera_shake = { init() { this.appendValueInput('INT').setCheck('Number').appendField('camera shake intensity'); this.setPreviousStatement(true); this.setNextStatement(true); this.setColour('#06b6d4'); } };

const workspace = Blockly.inject('blocklyDiv', { toolbox: document.getElementById('toolbox'), trashcan: true, zoom: { controls: true, wheel: true, startScale: 0.95 } });

function exportXmlPretty() { return Blockly.Xml.domToPrettyText(Blockly.Xml.workspaceToDom(workspace)); }
function loadXmlText(text) { Blockly.Xml.clearWorkspaceAndLoadFromXml(Blockly.Xml.textToDom(text), workspace); }

function generateTemplate(xmlText) {
  const id = safeId(document.getElementById('mod-id')?.value) || `custom-${Date.now()}`;
  const name = (document.getElementById('mod-name')?.value || 'Custom Mod').trim();
  return `// ${name}\nexport function applyCustomMod({ game, bus }) {\n  const workspaceXml = ${JSON.stringify(xmlText, null, 2)};\n  console.log('[${id}] loaded', workspaceXml);\n  // TODO: parse xml + map actions/events to game hooks\n  return () => console.log('[${id}] unloaded');\n}\n`;
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
