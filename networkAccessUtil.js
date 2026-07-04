const net = require('node:net');

const LOCALHOST_SET = new Set(['127.0.0.1', 'localhost']);

function cleanIp(ip) {
  return String(ip || '')
    .trim()
    .replace('::ffff:', '')
    .replace('::1', '127.0.0.1');
}

function parseList(envVar) {
  return String(process.env[envVar] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeNetworkMode(inputMode) {
  const mode = String(inputMode || 'lan').trim().toLowerCase();
  if (mode === 'local' || mode === 'lan' || mode === 'host') return mode;
  if (mode === 'vpn' || mode === 'mixed') return 'lan';
  return 'lan';
}

function isLocalhostIp(ip) {
  return LOCALHOST_SET.has(ip);
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;
  return false;
}

function isLanOrVpnLikeIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function buildExplicitAllowSet() {
  return new Set([
    '127.0.0.1',
    'localhost',
    ...parseList('TNS_ALLOWED_IPS'),
    ...parseList('TNS_LAN_IPS'),
    ...parseList('TNS_VPN_IPS')
  ]);
}

function evaluateNetworkAccess(rawClientIp, rawNetworkMode) {
  const clientIp = cleanIp(rawClientIp);
  const networkMode = normalizeNetworkMode(rawNetworkMode);

  if (networkMode === 'host') {
    return { allowed: true, clientIp, networkMode, reason: 'host-open' };
  }

  if (networkMode === 'local') {
    const allowed = isLocalhostIp(clientIp);
    return { allowed, clientIp, networkMode, reason: allowed ? 'localhost' : 'local-only' };
  }

  const explicitAllowSet = buildExplicitAllowSet();
  const allowed =
    isLocalhostIp(clientIp) ||
    isLanOrVpnLikeIp(clientIp) ||
    explicitAllowSet.has(clientIp);

  return {
    allowed,
    clientIp,
    networkMode,
    reason: allowed ? 'lan-or-allowlist' : 'lan-policy-denied'
  };
}

module.exports = {
  cleanIp,
  normalizeNetworkMode,
  evaluateNetworkAccess
};
