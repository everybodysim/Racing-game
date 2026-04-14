const INSTALLED_MODS_KEY = 'racing-installed-mods-v1';

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
    if (mod.viewerPage) {
      li.innerHTML = `${mod.name} — <a href="${mod.viewerPage}">Open</a>`;
    } else {
      li.textContent = mod.name;
    }
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
  } catch (error) {
    status.textContent = error.message;
  }

  let installed = readInstalled();
  renderInstalled(installed);

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
    status.textContent = `${mod.name} installed.`;
  });
})();
