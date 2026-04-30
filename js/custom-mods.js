const STORAGE_KEY = 'racing-custom-mods-workspace-v1';
const CUSTOM_MODS_KEY = 'racing-local-custom-mods-v1';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

function setStatus(message, warn = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('warn', warn);
}

function appendOutput(message) {
  outputEl.textContent = `${outputEl.textContent}\n${message}`.trim();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve(src);
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadScratchBlocks() {
  const scriptSets = [
    [
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blockly_compressed_vertical.js',
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blocks_compressed_vertical.js',
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/msg/messages.js'
    ],
    [
      'https://unpkg.com/scratch-blocks@1.1.15/blockly_compressed_vertical.js',
      'https://unpkg.com/scratch-blocks@1.1.15/blocks_compressed_vertical.js',
      'https://unpkg.com/scratch-blocks@1.1.15/msg/messages.js'
    ],
    [
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blockly_compressed.js',
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blocks_compressed.js',
      'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/msg/messages.js'
    ]
  ];

  for (const set of scriptSets) {
    try {
      for (const src of set) {
        await loadScript(src);
      }
      if (window.ScratchBlocks || window.Blockly) return;
    } catch (error) {
      appendOutput(`Loader note: ${error.message}`);
    }
  }

  throw new Error('Unable to load scratch-blocks from all known CDNs.');
}

function getBlocklyApi() {
  return window.ScratchBlocks || window.Blockly || null;
}

function buildToolbox() {
  return `<xml xmlns="https://developers.google.com/blockly/xml" style="display: none">
    <category name="Events" colour="#FFBF00">
      <block type="event_whenflagclicked"></block>
      <block type="event_whenkeypressed"></block>
      <block type="event_whenthisspriteclicked"></block>
    </category>
    <category name="Control" colour="#FFAB19">
      <block type="control_if"></block>
      <block type="control_if_else"></block>
      <block type="control_repeat"></block>
      <block type="control_forever"></block>
    </category>
    <category name="Operators" colour="#59C059">
      <block type="operator_add"></block>
      <block type="operator_subtract"></block>
      <block type="operator_multiply"></block>
      <block type="operator_divide"></block>
      <block type="operator_gt"></block>
      <block type="operator_lt"></block>
      <block type="operator_equals"></block>
    </category>
    <category name="Variables" colour="#FF8C1A" custom="VARIABLE"></category>
  </xml>`;
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
}

function generateTemplate(metadata, workspaceJson) {
  const modId = safeId(metadata.id) || `custom-${Date.now()}`;
  const modName = metadata.name?.trim() || 'Custom Mod';
  const description = metadata.description?.trim() || 'Generated from Custom Mods Lab';
  return `// ${modName}\n// ${description}\n// Generated ${new Date().toISOString()}\n\nexport function applyCustomMod({ game, bus }) {\n  const workspaceModel = ${JSON.stringify(workspaceJson, null, 2)};\n\n  console.log('[custom-mod:${modId}] loaded', workspaceModel);\n  // TODO: translate block model into runtime hooks affecting game systems.\n\n  return () => {\n    console.log('[custom-mod:${modId}] unloaded');\n  };\n}\n`;
}

let workspace = null;
let SB = null;

async function initBlockly() {
  setStatus('Loading Scratch block runtime...');
  try {
    await loadScratchBlocks();
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  SB = getBlocklyApi();
  if (!SB) {
    setStatus('Scratch blocks loaded scripts but API object was missing.', true);
    return;
  }

  workspace = SB.inject('blocklyDiv', {
    toolbox: buildToolbox(),
    zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 2, minScale: 0.35 }
  });

  setStatus('Scratch blocks loaded. Start dragging blocks to prototype your mod logic.');
}

function readMetadata() {
  return {
    id: document.getElementById('mod-id').value,
    name: document.getElementById('mod-name').value,
    description: document.getElementById('mod-description').value
  };
}

function getWorkspaceJson() {
  const xml = SB.Xml.workspaceToDom(workspace);
  return SB.Xml.domToText(xml);
}

function loadWorkspaceFromJson(xmlText) {
  workspace.clear();
  const dom = SB.Xml.textToDom(xmlText);
  SB.Xml.domToWorkspace(dom, workspace);
}

document.getElementById('save-workspace')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  const data = getWorkspaceJson();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ metadata: readMetadata(), data }));
  setStatus('Draft saved to localStorage.');
});

document.getElementById('load-workspace')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    setStatus('No saved draft found.', true);
    return;
  }
  const parsed = JSON.parse(raw);
  loadWorkspaceFromJson(parsed.data);
  document.getElementById('mod-id').value = parsed.metadata?.id || '';
  document.getElementById('mod-name').value = parsed.metadata?.name || '';
  document.getElementById('mod-description').value = parsed.metadata?.description || '';
  setStatus('Draft loaded.');
});

document.getElementById('clear-workspace')?.addEventListener('click', () => {
  if (!workspace) return;
  workspace.clear();
  outputEl.textContent = 'Output cleared.';
  setStatus('Workspace cleared.');
});

document.getElementById('export-json')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  outputEl.textContent = getWorkspaceJson();
  setStatus('Workspace XML exported.');
});

document.getElementById('export-template')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  outputEl.textContent = generateTemplate(readMetadata(), getWorkspaceJson());
  setStatus('Starter JS template generated.');
});

document.getElementById('save-local-mod')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  const metadata = readMetadata();
  const serialized = getWorkspaceJson();
  const id = safeId(metadata.id);
  if (!id) {
    setStatus('Please provide a mod ID before saving local custom mod.', true);
    return;
  }

  const existing = JSON.parse(localStorage.getItem(CUSTOM_MODS_KEY) || '[]');
  const next = existing.filter((entry) => entry.id !== id);
  next.push({ id, ...metadata, workspace: serialized, updatedAt: new Date().toISOString() });
  localStorage.setItem(CUSTOM_MODS_KEY, JSON.stringify(next));
  setStatus(`Saved local custom mod '${id}'. You can inspect it from devtools/localStorage.`);
});

initBlockly();
