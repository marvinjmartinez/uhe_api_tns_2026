const CONFIG_SECTION_ITEMS = [
  { href: 'config.html', label: 'Resumen' },
  { href: 'config-connections.html', label: 'Conexiones' },
  { href: 'config-modules.html', label: 'Modulos' },
  { href: 'config-settings.html', label: 'Claves' },
  { href: 'activity.html', label: 'Actividad API' }
];

const NAV_ITEMS = [
  { type: 'link', href: 'login.html', label: 'Login' },
  { type: 'link', href: 'index.html', label: 'API Query' },
  { type: 'group', label: 'Configuracion', items: CONFIG_SECTION_ITEMS },
  { type: 'link', href: 'users.html', label: 'Usuarios' },
  { type: 'link', href: 'health.html', label: 'Conectividad' },
  { type: 'link', href: 'docs.html', label: 'Docs API' },
  { type: 'link', href: 'openapi.api.json', label: 'OpenAPI' }
];

function getCurrentViewName() {
  const currentPath = globalThis.location?.pathname || '';
  return currentPath.split('/').pop() || 'index.html';
}

function resolveApiBase() {
  const origin = globalThis.location?.origin;
  return origin && origin !== 'null' ? origin : 'http://127.0.0.1:8086';
}

function getStoredToken() {
  return localStorage.getItem('tns_api_token') || getCookieValue('tns_api_token') || '';
}

function saveStoredToken(token) {
  const normalized = String(token || '').trim();
  localStorage.setItem('tns_api_token', normalized);
  if (normalized) {
    document.cookie = `tns_api_token=${encodeURIComponent(normalized)}; Path=/; SameSite=Lax`;
  } else {
    document.cookie = 'tns_api_token=; Path=/; Max-Age=0; SameSite=Lax';
  }
  return normalized;
}

function clearStoredToken() {
  localStorage.removeItem('tns_api_token');
  document.cookie = 'tns_api_token=; Path=/; Max-Age=0; SameSite=Lax';
}

function getCookieValue(name) {
  const prefix = `${name}=`;
  const parts = String(document.cookie || '').split(';').map(item => item.trim());
  const match = parts.find(item => item.startsWith(prefix));
  if (!match) return '';
  return decodeURIComponent(match.slice(prefix.length));
}

function buildAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeJs(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function formatDateTime(value) {
  if (!value) return '--';
  try {
    return new Date(value).toLocaleString('es-CO');
  } catch {
    return String(value);
  }
}

function renderBadge(value) {
  const text = String(value || '--').toUpperCase();
  const map = {
    OK: 'ok',
    INFO: 'info',
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    ONLINE: 'ok',
    WARNING: 'warning',
    ERROR: 'failed',
    FAILED: 'failed'
  };
  const klass = map[text] || 'info';
  return `<span class="badge ${klass}">${escapeHtml(text)}</span>`;
}

function setTokenStatus(message, isError = false) {
  const el = document.getElementById('tokenStatus');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? 'var(--critical)' : 'var(--text2)';
}

async function fetchJsonOrThrow(url, options = {}) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || response.statusText || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data || {};
}

function handleAuthFailure(error, target = 'login.html') {
  const status = Number(error?.status || 0);
  if (status !== 401 && status !== 403) return false;
  clearStoredToken();
  const current = getCurrentViewName();
  if (current !== target) {
    globalThis.location.href = target;
  }
  return true;
}

async function autoLoadToken() {
  let token = getStoredToken();
  if (token) {
    setTokenStatus('Token cargado desde navegador.');
    return token;
  }
  try {
    const data = await fetchJsonOrThrow(resolveApiBase() + '/api/token');
    if (data.token) {
      token = saveStoredToken(data.token);
      setTokenStatus('Token cargado automaticamente.');
    }
  } catch {
    setTokenStatus('Pegue un token manualmente.', true);
  }
  return token;
}

function initSharedNav() {
  const nav = document.querySelector('nav');
  if (!nav) return;
  const currentView = getCurrentViewName();
  const isLoginView = currentView === 'login.html';
  const navMarkup = NAV_ITEMS.map((item) => {
    if (item.type === 'group') {
      const groupActive = item.items.some(entry => entry.href === currentView);
      return `
        <details class="nav-group${groupActive ? ' active' : ''}">
          <summary>${item.label}</summary>
          <div class="nav-group-menu">
            ${item.items.map(entry => `<a class="nav-link${entry.href === currentView ? ' active' : ''}" href="${entry.href}">${entry.label}</a>`).join('')}
          </div>
        </details>
      `;
    }
    return `<a class="nav-link${item.href === currentView ? ' active' : ''}" href="${item.href}">${item.label}</a>`;
  }).join('');
  nav.classList.add('shared-nav');
  nav.innerHTML = `
    <a href="${isLoginView ? 'login.html' : 'index.html'}" class="brand">TNS Local API</a>
    <div class="nav-primary">
      ${navMarkup}
    </div>
    <span class="spacer"></span>
    <span class="refresh-info">Puerto 8086</span>
  `;
}

function renderConfigSectionTabs(containerId = 'configSectionTabs') {
  const host = document.getElementById(containerId);
  if (!host) return;
  const currentView = getCurrentViewName();
  host.className = 'section-tabs';
  host.innerHTML = CONFIG_SECTION_ITEMS
    .map(item => `<a class="section-tab${item.href === currentView ? ' active' : ''}" href="${item.href}">${item.label}</a>`)
    .join('');
}

document.addEventListener('DOMContentLoaded', () => {
  initSharedNav();
  renderConfigSectionTabs();
});
