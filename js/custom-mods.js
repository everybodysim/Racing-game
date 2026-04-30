const DRAFT_KEY = 'racing-custom-mods-workspace-v2';

function setStatus(message) {
  const el = document.getElementById('status');
  if (el) el.textContent = message;
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
}

// Custom event + action blocks
Blockly.Blocks.event_on_start = {
  init() {
    this.appendDummyInput().appendField('when race starts');
    this.appendStatementInput('DO').setCheck(null).appendField('do');
    this.setColour('#f59e0b');
    this.setNextStatement(false);
    this.setPreviousStatement(false);
  }
};

Blockly.Blocks.event_on_tick = {
  init() {
    this.appendDummyInput().appendField('every tick');
    this.appendStatementInput('DO').setCheck(null).appendField('do');
    this.setColour('#f59e0b');
  }
};

Blockly.Blocks.event_on_key = {
  init() {
    this.appendDummyInput()
      .appendField('when key')
      .appendField(new Blockly.FieldDropdown([['W', 'KeyW'], ['A', 'KeyA'], ['S', 'KeyS'], ['D', 'KeyD'], ['Space', 'Space']]), 'KEY')
      .appendField('pressed');
    this.appendStatementInput('DO').setCheck(null).appendField('do');
    this.setColour('#f59e0b');
  }
};

Blockly.Blocks.action_set_speed = {
  init() {
    this.appendValueInput('SPEED').setCheck('Number').appendField('set car speed to');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour('#06b6d4');
  }
};

Blockly.Blocks.action_boost = {
  init() {
    this.appendValueInput('AMOUNT').setCheck('Number').appendField('boost by');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour('#06b6d4');
  }
};

Blockly.Blocks.action_show_message = {
  init() {
    this.appendValueInput('TEXT').setCheck('String').appendField('show message');
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour('#06b6d4');
  }
};

const workspace = Blockly.inject('blocklyDiv', {
  toolbox: document.getElementById('toolbox'),
  trashcan: true,
  zoom: { controls: true, wheel: true, startScale: 0.95 }
});

function exportXmlPretty() {
  const xml = Blockly.Xml.workspaceToDom(workspace);
  return Blockly.Xml.domToPrettyText(xml);
}

function loadXmlText(text) {
  const xml = Blockly.Xml.textToDom(text);
  Blockly.Xml.clearWorkspaceAndLoadFromXml(xml, workspace);
}

function generateTemplate(xmlText) {
  const id = safeId(document.getElementById('mod-id')?.value) || `custom-${Date.now()}`;
  const name = (document.getElementById('mod-name')?.value || 'Custom Mod').trim();
  return `// ${name}\n// Generated from Custom Mods Lab\n\nexport function applyCustomMod({ game, bus }) {\n  const workspaceXml = ${JSON.stringify(xmlText, null, 2)};\n\n  function onStart() {\n    console.log('[${id}] onStart');\n  }\n\n  function onTick() {\n    // TODO: convert Blockly XML to runtime actions\n  }\n\n  bus?.on?.('race:start', onStart);\n  bus?.on?.('tick', onTick);\n\n  return () => {\n    bus?.off?.('race:start', onStart);\n    bus?.off?.('tick', onTick);\n  };\n}\n`;
}

document.getElementById('export-xml')?.addEventListener('click', () => {
  document.getElementById('xmlBox').value = exportXmlPretty();
  setStatus('XML exported');
});

document.getElementById('import-xml')?.addEventListener('click', () => {
  const text = document.getElementById('xmlBox').value;
  try {
    loadXmlText(text);
    setStatus('XML imported');
  } catch {
    setStatus('Invalid XML');
  }
});

document.getElementById('export-template')?.addEventListener('click', () => {
  const xml = exportXmlPretty();
  document.getElementById('xmlBox').value = generateTemplate(xml);
  setStatus('JS template generated');
});

document.getElementById('save-draft')?.addEventListener('click', () => {
  const payload = {
    modId: document.getElementById('mod-id')?.value || '',
    modName: document.getElementById('mod-name')?.value || '',
    xml: exportXmlPretty()
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  setStatus('Draft saved');
});

document.getElementById('load-draft')?.addEventListener('click', () => {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) {
    setStatus('No draft found');
    return;
  }
  const payload = JSON.parse(raw);
  document.getElementById('mod-id').value = payload.modId || '';
  document.getElementById('mod-name').value = payload.modName || '';
  document.getElementById('xmlBox').value = payload.xml || '';
  if (payload.xml) loadXmlText(payload.xml);
  setStatus('Draft loaded');
});

setStatus('Workspace loaded');
