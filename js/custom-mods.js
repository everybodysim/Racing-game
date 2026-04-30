const STORAGE_KEY = 'racing-custom-mods-workspace-v1';
const CUSTOM_MODS_KEY = 'racing-local-custom-mods-v1';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

function setStatus(message, warn = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('warn', warn);
}

function appendOutput(message) {
  outputEl.textContent = `${outputEl.textContent}
${message}`.trim();
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

function withTimeout(promise, label, ms = 12000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function loadScriptSet(set) {
  for (const src of set) {
    await withTimeout(loadScript(src), src);
  }
}

async function loadScratchBlocks() {
  const scriptSets = [
    {
      label: 'scratch-blocks/jsdelivr vertical',
      media: 'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/media/',
      scripts: [
        'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blockly_compressed_vertical.js',
        'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/blocks_compressed_vertical.js',
        'https://cdn.jsdelivr.net/npm/scratch-blocks@1.1.15/msg/messages.js'
      ]
    },
    {
      label: 'scratch-blocks/unpkg vertical',
      media: 'https://unpkg.com/scratch-blocks@1.1.15/media/',
      scripts: [
        'https://unpkg.com/scratch-blocks@1.1.15/blockly_compressed_vertical.js',
        'https://unpkg.com/scratch-blocks@1.1.15/blocks_compressed_vertical.js',
        'https://unpkg.com/scratch-blocks@1.1.15/msg/messages.js'
      ]
    },
    {
      label: 'blockly fallback/unpkg',
      media: 'https://unpkg.com/blockly@10.4.3/media/',
      scripts: ['https://unpkg.com/blockly@10.4.3/blockly.min.js']
    }
  ];

  for (const set of scriptSets) {
    try {
      appendOutput(`Trying loader: ${set.label}`);
      await loadScriptSet(set.scripts);
      const api = window.ScratchBlocks || window.Blockly;
      if (api) return { api, media: set.media, source: set.label };
    } catch (error) {
      appendOutput(`Loader note (${set.label}): ${error.message}`);
    }
  }

  throw new Error('Unable to load scratch-blocks/blockly from all known CDNs.');
}

function buildToolboxDom(mode = 'scratch') {
  const scratchXml = `<xml xmlns="https://developers.google.com/blockly/xml">
    <category name="Events" colour="#FFBF00">
      <block type="event_whenflagclicked"></block>
      <block type="event_whenkeypressed"></block>
    </category>
    <category name="Control" colour="#FFAB19">
      <block type="control_if"></block>
      <block type="control_if_else"></block>
      <block type="control_repeat"></block>
    </category>
    <category name="Operators" colour="#59C059">
      <block type="operator_add"></block>
      <block type="operator_subtract"></block>
      <block type="operator_multiply"></block>
      <block type="operator_divide"></block>
      <block type="operator_equals"></block>
    </category>
  </xml>`;

  const blocklyXml = `<xml xmlns="https://developers.google.com/blockly/xml">
    <category name="Logic" colour="#5C81A6">
      <block type="controls_if"></block>
      <block type="logic_compare"></block>
      <block type="logic_operation"></block>
      <block type="logic_boolean"></block>
    </category>
    <category name="Loops" colour="#5CA65C">
      <block type="controls_repeat_ext"><value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value></block>
      <block type="controls_whileUntil"></block>
    </category>
    <category name="Math" colour="#5C68A6">
      <block type="math_number"></block>
      <block type="math_arithmetic"></block>
      <block type="math_random_int"></block>
    </category>
    <category name="Text" colour="#5CA68D">
      <block type="text"></block>
      <block type="text_print"></block>
    </category>
  </xml>`;
  const xmlText = mode === 'scratch' ? scratchXml : blocklyXml;
  return new DOMParser().parseFromString(xmlText, 'text/xml').documentElement;
}


function buildBlocklyToolbox() {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: 'Logic',
        colour: '#5C81A6',
        contents: [
          { kind: 'block', type: 'controls_if' },
          { kind: 'block', type: 'logic_compare' },
          { kind: 'block', type: 'logic_operation' },
          { kind: 'block', type: 'logic_boolean' }
        ]
      },
      {
        kind: 'category',
        name: 'Loops',
        colour: '#5CA65C',
        contents: [
          { kind: 'block', type: 'controls_repeat_ext' },
          { kind: 'block', type: 'controls_whileUntil' }
        ]
      },
      {
        kind: 'category',
        name: 'Math',
        colour: '#5C68A6',
        contents: [
          { kind: 'block', type: 'math_number' },
          { kind: 'block', type: 'math_arithmetic' },
          { kind: 'block', type: 'math_random_int' }
        ]
      },
      {
        kind: 'category',
        name: 'Text',
        colour: '#5CA68D',
        contents: [
          { kind: 'block', type: 'text' },
          { kind: 'block', type: 'text_print' }
        ]
      }
    ]
  };
}


const FALLBACK_SNIPPETS = [
  'when green flag clicked',
  'repeat (10)',
  'if < > then',
  'set [speed v] to (12)',
  'change [speed v] by (1)',
  'wait (0.1) seconds'
];

function enableSnippetFallback(reason) {
  const panel = document.getElementById('fallback-builder');
  const buttons = document.getElementById('snippet-buttons');
  const script = document.getElementById('snippet-script');
  if (!panel || !buttons || !script) return;
  panel.style.display = 'block';
  buttons.innerHTML = '';
  for (const snippet of FALLBACK_SNIPPETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = snippet;
    btn.addEventListener('click', () => {
      script.value = script.value ? `${script.value}
${snippet}` : snippet;
    });
    buttons.appendChild(btn);
  }
  appendOutput(`Fallback builder enabled: ${reason}`);
}

function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
}

function generateTemplate(metadata, workspaceXml) {
  const modId = safeId(metadata.id) || `custom-${Date.now()}`;
  const modName = metadata.name?.trim() || 'Custom Mod';
  const description = metadata.description?.trim() || 'Generated from Custom Mods Lab';
  return `// ${modName}
// ${description}
// Generated ${new Date().toISOString()}

export function applyCustomMod({ game, bus }) {
  const workspaceModelXml = ${JSON.stringify(workspaceXml, null, 2)};

  console.log('[custom-mod:${modId}] loaded', workspaceModelXml);
  // TODO: translate block model into runtime hooks affecting game systems.

  return () => {
    console.log('[custom-mod:${modId}] unloaded');
  };
}
`;
}

let workspace = null;
let SB = null;

async function initBlockly() {
  setStatus('Loading Scratch block runtime...');
  try {
    const loaded = await loadScratchBlocks();

    const tryInject = (api, mode, source, media) => {
      SB = api;
      workspace = SB.inject('blocklyDiv', {
        toolbox: mode === 'scratch' ? buildToolboxDom('scratch') : buildBlocklyToolbox(),
        media,
        sounds: false,
        trashcan: true,
        zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 2, minScale: 0.35 },
        toolboxPosition: 'start',
        horizontalLayout: false
      });
      const toolbox = typeof workspace.getToolbox === 'function' ? workspace.getToolbox() : null;
      if (!toolbox) {
        throw new Error('Workspace initialized but toolbox is missing.');
      }
      setStatus(`Workspace ready (${source}/${mode}). Drag blocks from the left toolbox.`);
    };

    try {
      tryInject(loaded.api, loaded.source.includes('scratch-blocks') ? 'scratch' : 'blockly', loaded.source, loaded.media);
      return;
    } catch (injectError) {
      appendOutput(`Inject error (${loaded.source}): ${injectError.message}`);
    }

    appendOutput('Trying hard fallback: plain Blockly runtime');
    await loadScript('https://unpkg.com/blockly@10.4.3/blockly.min.js');
    tryInject(window.Blockly, 'blockly', 'blockly-fallback-runtime', 'https://unpkg.com/blockly@10.4.3/media/');
  } catch (error) {
    setStatus(error.message, true);
    enableSnippetFallback(error.message);
  }
}

function readMetadata() {
  return {
    id: document.getElementById('mod-id').value,
    name: document.getElementById('mod-name').value,
    description: document.getElementById('mod-description').value
  };
}

function getWorkspaceXml() {
  const xml = SB.Xml.workspaceToDom(workspace);
  return SB.Xml.domToText(xml);
}

function loadWorkspaceFromXml(xmlText) {
  workspace.clear();
  const dom = SB.Xml.textToDom(xmlText);
  SB.Xml.domToWorkspace(dom, workspace);
}

document.getElementById('save-workspace')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  const data = getWorkspaceXml();
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
  loadWorkspaceFromXml(parsed.data);
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
  if (workspace && SB) {
    outputEl.textContent = getWorkspaceXml();
    setStatus('Workspace XML exported.');
    return;
  }
  const snippetScript = document.getElementById('snippet-script')?.value || '';
  outputEl.textContent = snippetScript;
  setStatus('Fallback script exported as text.');
});

document.getElementById('export-template')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  outputEl.textContent = generateTemplate(readMetadata(), getWorkspaceXml());
  setStatus('Starter JS template generated.');
});

document.getElementById('save-local-mod')?.addEventListener('click', () => {
  if (!workspace || !SB) return;
  const metadata = readMetadata();
  const serialized = getWorkspaceXml();
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
