const INSTALLED_MODS_KEY = 'racing-installed-mods-v1';
let currentCatalog = [];

async function loadCatalog() {
  const response = await fetch('./mods/mods.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Failed to load mod catalog');
  const parsed = await response.json();
  return Array.isArray(parsed?.mods) ? parsed.mods : [];
}

function readInstalled() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInstalled(mods) {
  localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(mods));
}

function renderInstalled(mods) {
  const list = document.getElementById('installed-list');
  list.innerHTML = '';
  if (!mods.length) {
    const li = document.createElement('li');
    li.textContent = 'No mods installed yet.';
    list.appendChild(li);
    return;
  }
  for (const mod of mods) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = mod.status === 'under-construction' ? `${mod.name} (Under construction)` : mod.name;
    li.appendChild(label);
    if (mod.viewerPage && mod.id !== 'hacks') {
      const open = document.createElement('a');
      open.href = mod.viewerPage;
      open.textContent = ' Open';
      open.style.marginLeft = '8px';
      li.appendChild(open);
    } else if (mod.id === 'hacks') {
      const hint = document.createElement('small');
      hint.textContent = ' (toggle from in-game Menu ▾ > Hacks)';
      hint.style.marginLeft = '8px';
      li.appendChild(hint);
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.style.marginLeft = '8px';
    removeBtn.addEventListener('click', () => {
      const next = readInstalled().filter((entry) => entry.id !== mod.id);
      saveInstalled(next);
      renderInstalled(next);
      renderCatalog(currentCatalog, next);
      document.getElementById('install-status').textContent = `${mod.name} removed.`;
    });
    li.appendChild(removeBtn);
    list.appendChild(li);
  }
}

function renderCatalog(catalog, installed) {
  const list = document.getElementById('catalog-list');
  if (!list) return;
  list.innerHTML = '';
  for (const mod of catalog) {
    const li = document.createElement('li');
    const isInstalled = installed.some((entry) => entry.id === mod.id);
    li.textContent = `${mod.name}${mod.status === 'under-construction' ? ' (Under construction)' : ''}${isInstalled ? ' — Installed' : ''}`;
    list.appendChild(li);
  }
}

function findModByName(catalog, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return catalog.find((entry) =>
    [entry.name, entry.id, entry.folder].filter(Boolean).some((value) => String(value).toLowerCase() === q)
  ) || null;
}

(async function init() {
  const installBtn = document.getElementById('install-btn');
  const nameInput = document.getElementById('mod-name');
  const status = document.getElementById('install-status');

  let catalog = [];
  try {
    catalog = await loadCatalog();
    currentCatalog = catalog;
  } catch (error) {
    status.textContent = error.message;
  }

  let installed = readInstalled();
  renderInstalled(installed);
  renderCatalog(catalog, installed);

  installBtn?.addEventListener('click', () => {
    const mod = findModByName(catalog, nameInput?.value);
    if (!mod) {
      status.textContent = 'Mod not found. Try TAS.';
      return;
    }
    if (installed.some((entry) => entry.id === mod.id)) {
      status.textContent = `${mod.name} is already installed.`;
      return;
    }
    installed = [...installed, mod];
    saveInstalled(installed);
    renderInstalled(installed);
    renderCatalog(catalog, installed);
    status.textContent = `${mod.name} installed.`;
  });
})();
