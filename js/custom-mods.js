const STORAGE_KEY = 'racing-custom-mods-workspace-v1';
const CUSTOM_MODS_KEY = 'racing-local-custom-mods-v1';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

function setStatus(message, warn = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('warn', warn);
}

function buildToolbox() {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: 'Events',
        colour: '#FFBF00',
        contents: [
          { kind: 'block', type: 'event_whenflagclicked' },
          { kind: 'block', type: 'event_whenkeypressed' },
          { kind: 'block', type: 'event_whenthisspriteclicked' }
        ]
      },
      {
        kind: 'category',
        name: 'Logic',
        colour: '#59C059',
        contents: [
          { kind: 'block', type: 'control_if' },
          { kind: 'block', type: 'control_if_else' },
          { kind: 'block', type: 'operator_equals' },
          { kind: 'block', type: 'operator_gt' },
          { kind: 'block', type: 'operator_lt' }
        ]
      },
      {
        kind: 'category',
        name: 'Math',
        colour: '#4C97FF',
        contents: [
          { kind: 'block', type: 'operator_add' },
          { kind: 'block', type: 'operator_subtract' },
          { kind: 'block', type: 'operator_multiply' },
          { kind: 'block', type: 'operator_divide' },
          { kind: 'block', type: 'math_number' }
        ]
      },
      {
        kind: 'category',
        name: 'Variables',
        custom: 'VARIABLE',
        colour: '#FF8C1A'
      }
    ]
  };
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
}

function generateTemplate(metadata, workspaceJson) {
  const modId = safeId(metadata.id) || `custom-${Date.now()}`;
  const modName = metadata.name?.trim() || 'Custom Mod';
  const description = metadata.description?.trim() || 'Generated from Custom Mods Lab';
  return `// ${modName}\n// ${description}\n// Generated ${new Date().toISOString()}\n\nexport function applyCustomMod({ game, bus }) {\n  // TODO: translate workspace JSON into runtime behavior.\n  // Keep this data around for manual conversion/testing.\n  const workspaceModel = ${JSON.stringify(workspaceJson, null, 2)};\n\n  console.log('[custom-mod:${modId}] loaded', workspaceModel);\n\n  return () => {\n    console.log('[custom-mod:${modId}] unloaded');\n  };\n}\n`;
}

function initBlockly() {
  if (!window.Blockly) {
    setStatus('Scratch blocks failed to load. Check internet/CDN access and refresh.', true);
    return null;
  }
  const workspace = window.Blockly.inject('blocklyDiv', {
    toolbox: buildToolbox(),
    renderer: 'zelos',
    grid: { spacing: 24, length: 3, colour: '#334155', snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 2, minScale: 0.35 }
  });
  setStatus('Scratch blocks loaded. Start dragging blocks to prototype your mod logic.');
  return workspace;
}

const workspace = initBlockly();

function readMetadata() {
  return {
    id: document.getElementById('mod-id').value,
    name: document.getElementById('mod-name').value,
    description: document.getElementById('mod-description').value
  };
}

document.getElementById('save-workspace')?.addEventListener('click', () => {
  if (!workspace) return;
  const data = window.Blockly.serialization.workspaces.save(workspace);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ metadata: readMetadata(), data }));
  setStatus('Draft saved to localStorage.');
});

document.getElementById('load-workspace')?.addEventListener('click', () => {
  if (!workspace) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    setStatus('No saved draft found.', true);
    return;
  }
  const parsed = JSON.parse(raw);
  workspace.clear();
  window.Blockly.serialization.workspaces.load(parsed.data, workspace);
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
  if (!workspace) return;
  const serialized = window.Blockly.serialization.workspaces.save(workspace);
  outputEl.textContent = JSON.stringify(serialized, null, 2);
  setStatus('Workspace JSON exported.');
});

document.getElementById('export-template')?.addEventListener('click', () => {
  if (!workspace) return;
  const serialized = window.Blockly.serialization.workspaces.save(workspace);
  outputEl.textContent = generateTemplate(readMetadata(), serialized);
  setStatus('Starter JS template generated.');
});

document.getElementById('save-local-mod')?.addEventListener('click', () => {
  if (!workspace) return;
  const metadata = readMetadata();
  const serialized = window.Blockly.serialization.workspaces.save(workspace);
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
