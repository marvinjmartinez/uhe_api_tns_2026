const jwt = require('jsonwebtoken');
const { evaluateNetworkAccess, normalizeNetworkMode } = require('./networkAccessUtil');
const localConfigStore = require('./localConfigStore');

function getSessionIdleMinutes() {
  const value = Number(process.env.SESSION_IDLE_MINUTES || 15);
  if (!Number.isFinite(value) || value <= 0) return 15;
  return value;
}

module.exports = function(req, res, next) {
  const failAuth = (status, message) => {
    const isHtmlView = !String(req.path || '').startsWith('/api/') && String(req.path || '').toLowerCase().endsWith('.html');
    if (isHtmlView) {
      return res.redirect('/login.html');
    }
    return res.status(status).json({ error: message });
  };

  const jwtSecret = String(process.env.TNS_SECRET || process.env.API_KEY_MJ01 || '').trim();

  if (!jwtSecret) {
    return failAuth(500, 'Secreto JWT no configurado (TNS_SECRET/API_KEY_MJ01)');
  }

  const configuredNetworkMode = String(process.env.NETWORK_MODE || 'lan').trim().toLowerCase();
  const effectiveNetworkMode = normalizeNetworkMode(configuredNetworkMode);
  const access = evaluateNetworkAccess(req.ip, configuredNetworkMode);

  if (!access.allowed) {
    console.warn(`IP no autorizada: ${access.clientIp} (modo: ${configuredNetworkMode}, efectivo: ${effectiveNetworkMode})`);
    return failAuth(403, `IP no autorizada: ${access.clientIp}`);
  }

  if (configuredNetworkMode !== effectiveNetworkMode) {
    console.warn(`NETWORK_MODE='${configuredNetworkMode}' se interpreta como '${effectiveNetworkMode}'. Modos vigentes: local|lan|host.`);
  }

  const authHeader = req.headers.authorization;
  const cookieTokenMatch = String(req.headers.cookie || '').match(/(?:^|;\s*)tns_api_token=([^;]+)/);
  const cookieToken = cookieTokenMatch ? decodeURIComponent(cookieTokenMatch[1]) : '';
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token || cookieToken;

  if (!token) {
    return failAuth(401, 'Falta token de autorizacion');
  }

  jwt.verify(token, jwtSecret, (err, user) => {
    if (err) {
      console.warn('Token invalido o expirado:', err.message);
      return failAuth(403, 'Token invalido o expirado');
    }

    if (!localConfigStore.isReady()) {
      return failAuth(503, 'Store local no disponible');
    }

    const session = localConfigStore.getApiSessionByJti(user?.jti);
    if (!session || !session.active) {
      return failAuth(403, 'Sesion no activa o revocada');
    }

    const now = Date.now();
    const absoluteExpiry = Date.parse(session.expiresAt || '');
    if (Number.isFinite(absoluteExpiry) && absoluteExpiry <= now) {
      localConfigStore.revokeApiSession(session.sessionId, 'token-expired', {
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        userName: user?.email || user?.sub || 'api-client'
      });
      return failAuth(403, 'Sesion expirada');
    }

    const userRecord = localConfigStore.getApiUserByEmail(user?.email || user?.sub);
    if (!userRecord || !userRecord.active) {
      localConfigStore.revokeApiSession(session.sessionId, 'user-disabled', {
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        userName: user?.email || user?.sub || 'api-client'
      });
      return failAuth(403, 'Usuario no activo');
    }

    const idleMinutes = getSessionIdleMinutes();
    const idleBase = Date.parse(session.lastSeenAt || session.issuedAt || session.createdAt || '');
    if (Number.isFinite(idleBase) && now - idleBase > (idleMinutes * 60 * 1000)) {
      localConfigStore.revokeApiSession(session.sessionId, 'idle-timeout', {
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        userName: user?.email || user?.sub || 'api-client'
      });
      return failAuth(403, 'Sesion cerrada por inactividad');
    }

    localConfigStore.touchApiSession(user.jti, {
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null
    });

    req.user = {
      ...user,
      email: userRecord.email,
      sub: userRecord.email,
      role: userRecord.role
    };
    req.session = session;
    next();
  });
};
