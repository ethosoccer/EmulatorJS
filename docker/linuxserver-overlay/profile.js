// NPM modules
var crypto = require('crypto');
var home = require('os').homedir();
var express = require('express');
var app = express();
var fs = require('fs');
var fsw = require('fs').promises;
var path = require('path');
var JSZip = require('jszip');
var http = require('http');
var https = require('https');
var { spawnSync } = require('child_process');
var net = require('net');

// Default vars
var error = {status: 'error'};
var settingsFile = home + '/profile/settings.json';
var authAttempts = new Map();
var forgotPasswordAttempts = new Map();
var RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
var AUTH_ATTEMPT_LIMIT = 20;
var FORGOT_PASSWORD_LIMIT = 5;
var USERNAME_REGEX = /^[A-Za-z0-9._-]{3,32}$/;
var geoLookupCache = new Map();
var GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
app.use(express.json({ limit: '150MB' }));

function roleFor(profileRecord) {
  return profileRecord && profileRecord.role === 'admin' ? 'admin' : 'user';
}

function normalizeBooleanOverride(value) {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return null;
}

function normalizeSelectorStyleOverride(value) {
  if (value === 'popup') {
    return 'popup';
  }
  if (value === 'menu') {
    return 'menu';
  }
  return null;
}

function normalizeUserOverrides(overrides) {
  let value = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    selectorStyle: normalizeSelectorStyleOverride(value.selectorStyle),
    launchErrorDebug: normalizeBooleanOverride(value.launchErrorDebug)
  };
}

function effectiveSettingsForProfile(profileRecord, settings) {
  let defaults = Object.assign(defaultSettings(), settings || {});
  let overrides = normalizeUserOverrides(profileRecord && profileRecord.settingsOverrides);
  return {
    requireLogin: defaults.requireLogin === true,
    selectorStyle: overrides.selectorStyle === null ? (defaults.selectorStyle === 'popup' ? 'popup' : 'menu') : overrides.selectorStyle,
    launchErrorDebug: overrides.launchErrorDebug === null ? defaults.launchErrorDebug === true : overrides.launchErrorDebug === true
  };
}

function defaultSettings() {
  return {
    requireLogin: false,
    selectorStyle: 'menu',
    launchErrorDebug: false,
    passwordResetWebhook: '',
    localLogsEnabled: true,
    localLogRetentionDays: 90,
    influxEnabled: false,
    influxUrl: '',
    influxOrg: '',
    influxBucket: '',
    influxToken: ''
  };
}

async function readProfiles() {
  let profiles = await readProfileRecords();
  let changed = false;
  let hasAdmin = Object.keys(profiles).some(function(userHash) {
    return profiles[userHash] && profiles[userHash].role === 'admin';
  });
  if (!hasAdmin) {
    let fallbackAdminUser = String(process.env.EMULATORJS_ADMIN_FALLBACK_USER || '').trim();
    let fallbackHash = Object.keys(profiles).find(function(userHash) {
      return fallbackAdminUser && profiles[userHash] && profiles[userHash].username === fallbackAdminUser;
    }) || Object.keys(profiles)[0];
    if (fallbackHash && profiles[fallbackHash]) {
      profiles[fallbackHash].role = 'admin';
      changed = true;
    }
  }
  for (let userHash of Object.keys(profiles)) {
    if (!profiles[userHash] || !profiles[userHash].username) {
      delete profiles[userHash];
      changed = true;
      continue;
    }
    if (profiles[userHash].role !== 'admin' && profiles[userHash].role !== 'user') {
      profiles[userHash].role = 'user';
      changed = true;
    }
    let normalizedOverrides = normalizeUserOverrides(profiles[userHash].settingsOverrides);
    let currentOverrides = profiles[userHash].settingsOverrides || {};
    if (
      currentOverrides.selectorStyle !== normalizedOverrides.selectorStyle ||
      currentOverrides.launchErrorDebug !== normalizedOverrides.launchErrorDebug
    ) {
      profiles[userHash].settingsOverrides = normalizedOverrides;
      changed = true;
    }
  }
  if (changed) {
    await writeProfiles(profiles);
  }
  return profiles;
}

async function readProfileRecords() {
  try {
    let profileJson = await fsw.readFile(home + '/profile/profile.json', 'utf8');
    return JSON.parse(profileJson);
  } catch(e) {
    if (e && e.code === 'ENOENT') {
      return {};
    }
    throw e;
  }
}

async function writeProfiles(profile) {
  await fsw.mkdir(home + '/profile', {recursive: true});
  await fsw.writeFile(home + '/profile/profile.json', JSON.stringify(profile, null, 2));
}

async function readSettings() {
  try {
    return Object.assign(defaultSettings(), JSON.parse(await fsw.readFile(settingsFile, 'utf8')));
  } catch(e) {
    return defaultSettings();
  }
}

async function writeSettings(settings) {
  await fsw.writeFile(settingsFile, JSON.stringify(Object.assign(defaultSettings(), settings), null, 2));
}

function hashProfile(user, pass) {
  return crypto.createHash('sha256').update(user + pass).digest('hex');
}

function isValidUsername(username) {
  let value = String(username || '');
  if (!USERNAME_REGEX.test(value)) {
    return false;
  }
  let lower = value.toLowerCase();
  return lower !== 'default' && lower !== '.history' && lower !== 'history';
}

function isStrongPassword(password) {
  let value = String(password || '');
  return value.length >= 10;
}

function findUserHash(profile, username) {
  for (let userHash of Object.keys(profile)) {
    if (profile[userHash].username == username) {
      return userHash;
    }
  }
  return null;
}

async function bootstrapRequired() {
  let profile = await readProfileRecords();
  return Object.keys(profile).length === 0;
}

async function createBootstrapAdmin(user, pass) {
  if (!await bootstrapRequired()) {
    return false;
  }
  if (!isValidUsername(user) || !isStrongPassword(pass)) {
    return false;
  }
  let profile = {};
  let hash = hashProfile(user, pass);
  profile[hash] = {
    username: user,
    role: 'admin',
    settingsOverrides: normalizeUserOverrides()
  };
  await writeProfiles(profile);
  let profilePath = path.join(home, 'profile', user);
  if (!fs.existsSync(profilePath)) {
    await fsw.mkdir(profilePath, {recursive: true});
    await fsw.writeFile(path.join(profilePath, 'retroarch.cfg'), '');
  }
  return true;
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) {
    return '';
  }
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}

function forwardedIps(req) {
  return String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
}

function isPrivateIp(value) {
  let ip = normalizeIp(value);
  let version = net.isIP(ip);
  if (!version) {
    return false;
  }
  if (version === 4) {
    return /^10\./.test(ip) ||
      /^127\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^169\.254\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
  }
  let lower = ip.toLowerCase();
  return lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:');
}

function publicRequestIps(req) {
  let candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['cf-connecting-ipv6'],
    req.headers['true-client-ip']
  ]
    .concat(forwardedIps(req))
    .map(normalizeIp)
    .filter(Boolean);
  let seen = new Set();
  return candidates.filter(function(ip) {
    if (seen.has(ip) || isPrivateIp(ip)) {
      return false;
    }
    seen.add(ip);
    return true;
  });
}

function cloudflareGeo(req) {
  let geo = {
    source: 'cloudflare',
    country: String(req.headers['cf-ipcountry'] || '').trim(),
    countryCode: String(req.headers['cf-ipcountry'] || '').trim(),
    region: String(req.headers['cf-region'] || '').trim(),
    regionCode: String(req.headers['cf-region-code'] || '').trim(),
    city: String(req.headers['cf-ipcity'] || req.headers['cf-city'] || '').trim(),
    postalCode: String(req.headers['cf-postal-code'] || '').trim(),
    timezone: String(req.headers['cf-timezone'] || '').trim(),
    latitude: String(req.headers['cf-iplatitude'] || '').trim(),
    longitude: String(req.headers['cf-iplongitude'] || '').trim(),
    metroCode: String(req.headers['cf-metro-code'] || '').trim(),
    isp: '',
    org: '',
    asn: ''
  };
  let hasData = Object.keys(geo).some(function(key) {
    return key !== 'source' && geo[key];
  });
  if (!hasData || geo.countryCode === 'XX') {
    return null;
  }
  return geo;
}

function buildGeoSummary(geo) {
  if (!geo) {
    return '';
  }
  let parts = [];
  if (geo.city) {
    parts.push(geo.city);
  }
  if (geo.region) {
    parts.push(geo.region);
  } else if (geo.regionCode) {
    parts.push(geo.regionCode);
  }
  if (geo.country) {
    parts.push(geo.country);
  } else if (geo.countryCode) {
    parts.push(geo.countryCode);
  }
  let summary = parts.join(', ');
  if (!summary && geo.timezone) {
    summary = geo.timezone;
  }
  return summary;
}

function cacheGeoLookup(ip, geo) {
  if (!ip || !geo) {
    return geo;
  }
  geoLookupCache.set(ip, {
    expires: Date.now() + GEO_CACHE_TTL_MS,
    value: geo
  });
  return geo;
}

function cachedGeoLookup(ip) {
  let cached = geoLookupCache.get(ip);
  if (!cached) {
    return null;
  }
  if (cached.expires < Date.now()) {
    geoLookupCache.delete(ip);
    return null;
  }
  return cached.value;
}

function fetchGeoLookup(ip) {
  return new Promise(function(resolve) {
    if (!ip || isPrivateIp(ip)) {
      resolve(null);
      return;
    }
    let request = https.get('https://ipwho.is/' + encodeURIComponent(ip), { timeout: 5000 }, function(response) {
      let body = '';
      response.on('data', function(chunk) {
        body += chunk.toString();
      });
      response.on('end', function() {
        try {
          let json = JSON.parse(body || '{}');
          if (json && json.success !== false) {
            resolve({
              source: 'ipwhois',
              country: String(json.country || '').trim(),
              countryCode: String(json.country_code || '').trim(),
              region: String(json.region || '').trim(),
              regionCode: String(json.region_code || '').trim(),
              city: String(json.city || '').trim(),
              postalCode: String(json.postal || '').trim(),
              timezone: json.timezone && json.timezone.id ? String(json.timezone.id).trim() : '',
              latitude: json.latitude || '',
              longitude: json.longitude || '',
              metroCode: '',
              isp: String(json.connection && json.connection.isp || '').trim(),
              org: String(json.connection && json.connection.org || '').trim(),
              asn: String(json.connection && json.connection.asn || '').trim()
            });
            return;
          }
        } catch (e) {}
        resolve(null);
      });
    });
    request.on('timeout', function() {
      request.destroy();
      resolve(null);
    });
    request.on('error', function() {
      resolve(null);
    });
  });
}

async function requestGeo(req) {
  let publicIps = publicRequestIps(req);
  let publicIp = publicIps[0] || '';
  if (!publicIp) {
    return null;
  }
  let cached = cachedGeoLookup(publicIp);
  if (cached) {
    return cached;
  }
  let fromHeaders = cloudflareGeo(req);
  if (fromHeaders) {
    return cacheGeoLookup(publicIp, fromHeaders);
  }
  let lookedUp = await fetchGeoLookup(publicIp);
  if (lookedUp) {
    return cacheGeoLookup(publicIp, lookedUp);
  }
  return null;
}

function requestIp(req) {
  let publicIps = publicRequestIps(req);
  if (publicIps.length) {
    return publicIps[0];
  }
  let forwardedFor = forwardedIps(req)[0];
  return forwardedFor || normalizeIp(req.headers['x-real-ip']) || normalizeIp(req.socket.remoteAddress) || '';
}

function consumeRateLimit(map, key, limit, windowMs) {
  let now = Date.now();
  let history = (map.get(key) || []).filter(function(timestamp) {
    return now - timestamp < windowMs;
  });
  if (history.length >= limit) {
    map.set(key, history);
    return false;
  }
  history.push(now);
  map.set(key, history);
  return true;
}

function originFromValue(value) {
  if (!value) {
    return null;
  }
  try {
    let parsed = new URL(value);
    return parsed.origin;
  } catch (e) {
    return null;
  }
}

function requestOrigin(req) {
  return originFromValue(req.headers.origin) || originFromValue(req.headers.referer);
}

function expectedOrigin(req) {
  let protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let proto = protoHeader || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + req.headers.host;
}

function isTrustedOrigin(req) {
  let origin = requestOrigin(req);
  if (!origin) {
    return true;
  }
  let expected = expectedOrigin(req);
  let originUrl = new URL(origin);
  let expectedUrl = new URL(expected);
  if (originUrl.host !== expectedUrl.host) {
    return false;
  }
  let hasForwardedProto = String(req.headers['x-forwarded-proto'] || '').trim().length > 0 || !!req.socket.encrypted;
  return !hasForwardedProto || originUrl.protocol === expectedUrl.protocol;
}

function sendWebhook(url, payload) {
  return new Promise(function(resolve, reject) {
    try {
      let parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        reject(new Error('Unsupported webhook protocol'));
        return;
      }
      let body = JSON.stringify(payload);
      let client = parsed.protocol === 'https:' ? https : http;
      let request = client.request({
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      }, function(response) {
        response.resume();
        response.on('end', function() {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      });
      request.on('timeout', function() {
        request.destroy(new Error('Webhook timed out'));
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    } catch(e) {
      reject(e);
    }
  });
}

function runLogDb(command, payload) {
  try {
    let result = spawnSync('python3', [path.join(__dirname, 'logdb.py'), command, path.join(home, 'profile', 'activity.db')], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      console.log('logdb error', result.stderr || result.stdout);
      return {status: 'error'};
    }
    return JSON.parse(result.stdout || '{}');
  } catch (e) {
    console.log('logdb invoke failed', e);
    return {status: 'error'};
  }
}

function escapeInfluxTag(value) {
  return String(value || '').replace(/([ ,=])/g, '\\$1');
}

function escapeInfluxField(value) {
  return '"' + String(value || '').replace(/(["\\])/g, '\\$1') + '"';
}

function buildInfluxLine(payload) {
  let tags = [
    'event=' + escapeInfluxTag(payload.event || ''),
    'action=' + escapeInfluxTag(payload.action || ''),
    'status=' + escapeInfluxTag(payload.status || ''),
    'source=' + escapeInfluxTag(payload.source || 'unknown')
  ].join(',');
  let game = payload.game || {};
  let fields = [
    'count=1i',
    'title=' + escapeInfluxField(payload.title || ''),
    'username=' + escapeInfluxField(payload.username || ''),
    'role=' + escapeInfluxField(payload.role || ''),
    'ip=' + escapeInfluxField(payload.ip || ''),
    'host=' + escapeInfluxField(payload.host || ''),
    'user_agent=' + escapeInfluxField(payload.userAgent || ''),
    'origin=' + escapeInfluxField(payload.origin || ''),
    'referer=' + escapeInfluxField(payload.referer || ''),
    'request_path=' + escapeInfluxField(payload.requestPath || ''),
    'game_name=' + escapeInfluxField(game.name || ''),
    'game_file=' + escapeInfluxField(game.file || ''),
    'console=' + escapeInfluxField(game.console || ''),
    'console_title=' + escapeInfluxField(game.consoleTitle || ''),
    'emulator=' + escapeInfluxField(game.emulator || ''),
    'details_json=' + escapeInfluxField(JSON.stringify(payload))
  ].join(',');
  return 'emulatorjs_events,' + tags + ' ' + fields;
}

function sendInflux(settings, payload, detailed) {
  return new Promise(function(resolve, reject) {
    try {
      if (!settings.influxEnabled || !settings.influxUrl || !settings.influxOrg || !settings.influxBucket || !settings.influxToken) {
        resolve(detailed ? {
          ok: false,
          message: 'Missing one or more required Influx settings.',
          statusCode: 0,
          responseBody: ''
        } : false);
        return;
      }
      let parsed = new URL(settings.influxUrl);
      let client = parsed.protocol === 'https:' ? https : http;
      let body = buildInfluxLine(payload);
      let request = client.request({
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: (parsed.pathname.replace(/\/$/, '') || '') + '/api/v2/write?org=' + encodeURIComponent(settings.influxOrg) + '&bucket=' + encodeURIComponent(settings.influxBucket) + '&precision=ns',
        headers: {
          'Authorization': 'Token ' + settings.influxToken,
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      }, function(response) {
        let responseBody = '';
        response.on('data', function(chunk) {
          responseBody += chunk.toString();
        });
        response.on('end', function() {
          let ok = response.statusCode >= 200 && response.statusCode < 300;
          resolve(detailed ? {
            ok: ok,
            message: ok ? 'Influx accepted the event.' : 'Influx rejected the event.',
            statusCode: response.statusCode || 0,
            responseBody: responseBody.trim(),
            requestPath: (parsed.pathname.replace(/\/$/, '') || '') + '/api/v2/write?org=' + encodeURIComponent(settings.influxOrg) + '&bucket=' + encodeURIComponent(settings.influxBucket) + '&precision=ns'
          } : ok);
        });
      });
      request.on('timeout', function() {
        request.destroy(new Error('Influx request timed out'));
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    } catch (e) {
      if (detailed) {
        resolve({
          ok: false,
          message: e.message || 'Unable to build Influx request.',
          statusCode: 0,
          responseBody: ''
        });
        return;
      }
      reject(e);
    }
  });
}

function requestMetadata(req) {
  let publicIps = publicRequestIps(req);
  let localIp = forwardedIps(req)[0] || normalizeIp(req.headers['x-real-ip']) || normalizeIp(req.socket.remoteAddress) || '';
  let publicIpv4 = publicIps.find(function(ip) { return net.isIP(ip) === 4; }) || '';
  let publicIpv6 = publicIps.find(function(ip) { return net.isIP(ip) === 6; }) || '';
  return {
    time: new Date().toISOString(),
    ip: requestIp(req),
    localIp: localIp,
    publicIp: publicIps[0] || '',
    publicIpv4: publicIpv4,
    publicIpv6: publicIpv6,
    publicIps: publicIps,
    cfConnectingIp: normalizeIp(req.headers['cf-connecting-ip']),
    cfConnectingIpv6: normalizeIp(req.headers['cf-connecting-ipv6']),
    trueClientIp: normalizeIp(req.headers['true-client-ip']),
    forwardedFor: req.headers['x-forwarded-for'] || '',
    userAgent: req.headers['user-agent'] || '',
    host: req.headers.host || '',
    origin: req.headers.origin || '',
    referer: req.headers.referer || '',
    requestPath: req.originalUrl || req.url || '',
    remoteAddress: normalizeIp(req.socket.remoteAddress)
  };
}

async function emitConfiguredWebhook(settings, payload) {
  if (!settings || !settings.passwordResetWebhook) {
    return false;
  }
  try {
    return await sendWebhook(settings.passwordResetWebhook, payload);
  } catch (e) {
    console.log('Webhook send failed', e);
    return false;
  }
}

async function emitActivityWebhook(settings, req, payload) {
  let geo = await requestGeo(req);
  let basePayload = Object.assign({
    app: 'EmulatorJS'
  }, requestMetadata(req), payload || {});
  basePayload.geo = geo || null;
  basePayload.geoSummary = geo ? buildGeoSummary(geo) : (isPrivateIp(basePayload.localIp || basePayload.ip) ? 'Local network' : '');
  basePayload.geoCountry = geo && geo.country || '';
  basePayload.geoCountryCode = geo && geo.countryCode || '';
  basePayload.geoRegion = geo && (geo.region || geo.regionCode) || '';
  basePayload.geoCity = geo && geo.city || '';
  basePayload.geoPostalCode = geo && geo.postalCode || '';
  basePayload.geoTimezone = geo && geo.timezone || '';
  basePayload.geoLatitude = geo && geo.latitude || '';
  basePayload.geoLongitude = geo && geo.longitude || '';
  basePayload.geoIsp = geo && geo.isp || '';
  basePayload.geoOrg = geo && geo.org || '';
  basePayload.geoAsn = geo && geo.asn || '';
  if (settings.localLogsEnabled !== false) {
    runLogDb('write', {
      retentionDays: settings.localLogRetentionDays || 90,
      entry: basePayload
    });
  }
  await emitConfiguredWebhook(settings, basePayload);
  if (settings.influxEnabled) {
    try {
      await sendInflux(settings, basePayload);
    } catch (e) {
      console.log('Influx send failed', e);
    }
  }
  return true;
}

function profilePathForUser(username) {
  return path.join(home, 'profile', username);
}

function safeProfilePath(basePath, relativePath) {
  let cleaned = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  let resolved = path.resolve(basePath, cleaned);
  let root = path.resolve(basePath) + path.sep;
  if (resolved !== path.resolve(basePath) && !resolved.startsWith(root)) {
    throw new Error('Unsafe profile path');
  }
  return resolved;
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isSaveFile(relativePath) {
  return /^states\/.+\/.+/i.test(relativePath) || /^saves\/.+\/.+/i.test(relativePath);
}

function saveTypeForPath(relativePath) {
  if (/^states\//i.test(relativePath)) {
    return /\.auto$/i.test(relativePath) ? 'Auto Save State' : 'Save State';
  }
  return 'In-game Save';
}

const SAVE_VERSION_ROOT = '.save-versions';

function normalizeSaveRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function saveVersionStorageKey(relativePath) {
  return Buffer.from(normalizeSaveRelativePath(relativePath), 'utf8').toString('hex');
}

function saveVersionDirRelative(relativePath) {
  return path.posix.join(SAVE_VERSION_ROOT, saveVersionStorageKey(relativePath));
}

function saveVersionManifestRelative(relativePath) {
  return path.posix.join(saveVersionDirRelative(relativePath), 'manifest.json');
}

function saveVersionBlobRelative(relativePath, versionId) {
  return path.posix.join(saveVersionDirRelative(relativePath), 'versions', versionId + '.bin');
}

function saveContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function saveManifestDefaults(relativePath) {
  let normalizedPath = normalizeSaveRelativePath(relativePath);
  let parts = normalizedPath.split('/');
  let fileName = parts[parts.length - 1] || '';
  let scope = parts[0] || '';
  let core = parts[1] || '';
  return {
    saveKey: normalizedPath,
    fileName: fileName,
    displayName: safeDecodeName(fileName),
    scope: scope,
    core: core,
    saveType: saveTypeForPath(normalizedPath),
    createdAt: '',
    updatedAt: '',
    currentVersionId: '',
    currentHash: '',
    versions: []
  };
}

async function readSaveManifest(profilePath, relativePath) {
  let manifestPath = safeProfilePath(profilePath, saveVersionManifestRelative(relativePath));
  try {
    let raw = await fsw.readFile(manifestPath, 'utf8');
    let parsed = JSON.parse(raw);
    return Object.assign(saveManifestDefaults(relativePath), parsed || {}, {
      versions: Array.isArray(parsed && parsed.versions) ? parsed.versions : []
    });
  } catch (e) {
    return saveManifestDefaults(relativePath);
  }
}

async function writeSaveManifest(profilePath, relativePath, manifest) {
  let manifestPath = safeProfilePath(profilePath, saveVersionManifestRelative(relativePath));
  await ensureDir(manifestPath);
  await fsw.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function sortSaveVersionsNewestFirst(versions) {
  return (versions || []).slice().sort(function(a, b) {
    return Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0);
  });
}

async function ensureSaveVersioned(profilePath, relativePath, content, options) {
  let normalizedPath = normalizeSaveRelativePath(relativePath);
  if (!isSaveFile(normalizedPath)) {
    return null;
  }
  let buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let manifest = await readSaveManifest(profilePath, normalizedPath);
  let now = new Date();
  let nowIso = now.toISOString();
  let nowMs = now.getTime();
  let hash = saveContentHash(buffer);
  let size = buffer.length;
  let existingVersion = (manifest.versions || []).find(function(version) {
    return version.hash === hash && Number(version.size || 0) === size;
  });
  let created = false;
  if (!manifest.createdAt) {
    manifest.createdAt = nowIso;
  }
  if (!existingVersion) {
    created = true;
    let versionId = timestampLabel() + '--' + hash.slice(0, 12);
    let versionPath = safeProfilePath(profilePath, saveVersionBlobRelative(normalizedPath, versionId));
    await ensureDir(versionPath);
    await fsw.writeFile(versionPath, buffer);
    existingVersion = {
      id: versionId,
      createdAt: nowIso,
      createdAtMs: nowMs,
      hash: hash,
      size: size,
      saveType: manifest.saveType,
      scope: manifest.scope,
      core: manifest.core,
      fileName: manifest.fileName,
      displayName: manifest.displayName,
      source: options && options.source || 'Profile sync',
      notes: options && options.notes || '',
      pathKey: saveVersionBlobRelative(normalizedPath, versionId)
    };
    manifest.versions.push(existingVersion);
  }
  manifest.currentVersionId = existingVersion.id;
  manifest.currentHash = hash;
  manifest.updatedAt = nowIso;
  manifest.versions = sortSaveVersionsNewestFirst(manifest.versions);
  await writeSaveManifest(profilePath, normalizedPath, manifest);
  return {
    manifest: manifest,
    version: existingVersion,
    created: created,
    hash: hash,
    size: size
  };
}

async function listSaveVersionRecords(profilePath) {
  let records = [];
  let manifestRoot = path.join(profilePath, SAVE_VERSION_ROOT);
  if (!fs.existsSync(manifestRoot)) {
    return records;
  }
  let manifestFiles = await collectFiles(manifestRoot, SAVE_VERSION_ROOT, []);
  for await (let file of manifestFiles) {
    if (!/manifest\.json$/i.test(file.relPath)) {
      continue;
    }
    let manifestPath = safeProfilePath(profilePath, file.relPath);
    let parsed;
    try {
      parsed = JSON.parse(await fsw.readFile(manifestPath, 'utf8'));
    } catch (e) {
      continue;
    }
    let manifest = Object.assign(saveManifestDefaults(parsed && parsed.saveKey || ''), parsed || {});
    let versions = sortSaveVersionsNewestFirst(Array.isArray(manifest.versions) ? manifest.versions : []);
    let currentVersionId = manifest.currentVersionId || '';
    let currentVersion = versions.find(function(version) {
      return version.id === currentVersionId;
    }) || versions[0] || null;
    if (currentVersion) {
      records.push({
        id: 'profile::current::' + manifest.saveKey,
        pathKey: manifest.saveKey,
        name: manifest.displayName || safeDecodeName(manifest.fileName || path.basename(manifest.saveKey || '')),
        type: manifest.saveType || saveTypeForPath(manifest.saveKey),
        source: 'Profile current',
        versionLabel: 'Current',
        versionSort: Number(currentVersion.createdAtMs || 0),
        createdAt: currentVersion.createdAt || manifest.updatedAt || '',
        size: Number(currentVersion.size || 0),
        current: true,
        currentVersionId: currentVersion.id,
        hash: currentVersion.hash || '',
        saveKey: manifest.saveKey,
        manifestKey: saveVersionManifestRelative(manifest.saveKey),
        notes: currentVersion.notes || ''
      });
    }
    for (let version of versions) {
      if (version.id === currentVersionId) {
        continue;
      }
      records.push({
        id: 'profile::version::' + manifest.saveKey + '::' + version.id,
        pathKey: version.pathKey,
        name: manifest.displayName || safeDecodeName(manifest.fileName || path.basename(manifest.saveKey || '')),
        type: manifest.saveType || saveTypeForPath(manifest.saveKey),
        source: version.source || 'Profile history',
        versionLabel: version.createdAt || version.id,
        versionSort: Number(version.createdAtMs || 0),
        createdAt: version.createdAt || '',
        size: Number(version.size || 0),
        current: false,
        versionId: version.id,
        currentVersionId: currentVersionId,
        hash: version.hash || '',
        saveKey: manifest.saveKey,
        manifestKey: saveVersionManifestRelative(manifest.saveKey),
        notes: version.notes || ''
      });
    }
  }
  return records;
}

async function ensureDir(filePath) {
  await fsw.mkdir(path.dirname(filePath), {recursive: true});
}

async function collectFiles(rootPath, relativeRoot, into) {
  if (!fs.existsSync(rootPath)) {
    return into;
  }
  let items = await fsw.readdir(rootPath);
  for await (let item of items) {
    let fullPath = path.join(rootPath, item);
    let relPath = relativeRoot ? path.posix.join(relativeRoot, item) : item;
    let stat = await fsw.stat(fullPath);
    if (stat.isDirectory()) {
      await collectFiles(fullPath, relPath, into);
    } else {
      into.push({fullPath: fullPath, relPath: relPath, stat: stat});
    }
  }
  return into;
}

function safeDecodeName(value) {
  try {
    return decodeURIComponent(value);
  } catch(e) {
    return value;
  }
}

// Catch all to detect endpoint
app.get('/*', function(req, res) {
  res.send('pong');
});

// Catch all for any post
app.post('/*', async function(req, res) {
  try {
      let type = req.body.type;
      if (!isTrustedOrigin(req)) {
        res.status(403).json(error);
        return;
      }
      // Send default profile unauthenticated
      if (type == 'publicsettings') {
        let settings = await readSettings();
        let resolved = {
          requireLogin: settings.requireLogin === true,
          selectorStyle: settings.selectorStyle === 'popup' ? 'popup' : 'menu',
          launchErrorDebug: settings.launchErrorDebug === true
        };
        if (req.body.user && req.body.pass) {
          let publicProfile = await readProfiles();
          let publicHash = hashProfile(req.body.user, req.body.pass);
          if (publicProfile.hasOwnProperty(publicHash)) {
            resolved = effectiveSettingsForProfile(publicProfile[publicHash], settings);
          }
        }
        res.json({
          status: 'success',
          setupRequired: await bootstrapRequired(),
          requireLogin: resolved.requireLogin === true,
          selectorStyle: resolved.selectorStyle === 'popup' ? 'popup' : 'menu',
          launchErrorDebug: resolved.launchErrorDebug === true
        });
      } else if (type == 'bootstrapadmin') {
        if (!consumeRateLimit(authAttempts, requestIp(req), AUTH_ATTEMPT_LIMIT, RATE_LIMIT_WINDOW_MS)) {
          res.status(429).json(error);
          return;
        }
        let created = await createBootstrapAdmin(req.body.user, req.body.pass);
        if (!created) {
          res.json(error);
          return;
        }
        res.json({status: 'success', user: req.body.user, role: 'admin'});
      } else if (type == 'default') {
      try {
        let profilePath = home + '/profile/default/';
        let zip = new JSZip();
        let items = await fs.readdirSync(profilePath);
        async function addToZip(item) {
          if (fs.lstatSync(item).isDirectory()) {
            let items = await fs.readdirSync(item);
            if (items.length > 0) {
              for await (let subPath of items) {
                await addToZip(item + '/' + subPath);
              }
            }
          } else {
            let data = fs.readFileSync(item);
            let zipPath = item.replace(profilePath,'');
            zip.file(zipPath, data);
          }
          return;
        }
        for await (let item of items) {
          await addToZip(profilePath + item);
        }
        zip.generateAsync({type:"base64"}).then(function callback(base64) {
          res.json({status: 'success',data: base64});
        });
      } catch (e) {
        console.log(e);
        res.json(error);
      }
      } else {
        if (type == 'forgotpassword') {
          if (!consumeRateLimit(forgotPasswordAttempts, requestIp(req), FORGOT_PASSWORD_LIMIT, RATE_LIMIT_WINDOW_MS)) {
            res.status(429).json(error);
            return;
          }
          if (!req.body.user) {
            res.json(error);
            return;
          }
        let settings = await readSettings();
        if (!settings.passwordResetWebhook) {
          res.json(error);
          return;
        }
        let payload = {
          title: 'EmulatorJS password reset requested',
          event: 'password_reset_requested',
          requestedUser: req.body.user || '',
          source: req.body.source || 'unknown',
        };
        let sent = await emitActivityWebhook(settings, req, payload);
        res.json(sent ? {status: 'success'} : error);
        return;
        }
        if (type == 'login' && !consumeRateLimit(authAttempts, requestIp(req), AUTH_ATTEMPT_LIMIT, RATE_LIMIT_WINDOW_MS)) {
          if (req.body.silent !== true) {
            let settings = await readSettings();
            await emitActivityWebhook(settings, req, {
              title: 'EmulatorJS login throttled',
              event: 'login_throttled',
              action: 'login',
              status: 'blocked',
              username: req.body.user || '',
              source: req.body.source || 'unknown',
              reason: 'rate_limited'
            });
          }
          res.status(429).json(error);
          return;
        }
        let auth = req.body.user + req.body.pass;
        // Simple hash auth
        let hash = crypto.createHash('sha256').update(auth).digest('hex');
      let profile = await readProfiles();
      if (profile.hasOwnProperty(hash)) {
        let currentRole = roleFor(profile[hash]);
        let settings = await readSettings();
        let resolvedSettings = effectiveSettingsForProfile(profile[hash], settings);
        // Return username if found
        if (type == 'login') {
          if (req.body.silent !== true) {
            await emitActivityWebhook(settings, req, {
              title: 'EmulatorJS login succeeded',
              event: 'login_success',
              action: 'login',
              status: 'success',
              username: profile[hash].username,
              role: currentRole,
              source: req.body.source || 'unknown'
            });
          }
          res.json({
            status: 'success',
            user: profile[hash].username,
            role: currentRole,
            settingsOverrides: normalizeUserOverrides(profile[hash].settingsOverrides),
            settings: {
              requireLogin: resolvedSettings.requireLogin === true,
              selectorStyle: resolvedSettings.selectorStyle === 'popup' ? 'popup' : 'menu',
              launchErrorDebug: resolvedSettings.launchErrorDebug === true
            }
          });
        } else if (type == 'notifygameevent') {
          let settings = await readSettings();
          await emitActivityWebhook(settings, req, {
            title: 'EmulatorJS game started',
            event: 'game_started',
            action: 'game_start',
            status: 'success',
            username: profile[hash].username,
            role: currentRole,
            source: req.body.source || 'frontend',
            game: {
              name: req.body.gameName || '',
              file: req.body.gameFile || '',
              console: req.body.console || '',
              consoleTitle: req.body.consoleTitle || '',
              path: req.body.path || '',
              emulator: req.body.emulator || '',
              romExtension: req.body.romExtension || '',
              url: req.body.gameUrl || ''
            }
          });
          res.json({status: 'success'});
        } else if (type == 'notifygamelaunchfailure') {
          let settings = await readSettings();
          await emitActivityWebhook(settings, req, {
            title: 'EmulatorJS game launch failed',
            event: 'game_launch_failed',
            action: 'game_launch',
            status: 'failed',
            username: profile[hash].username,
            role: currentRole,
            source: req.body.source || 'frontend',
            failure: {
              type: req.body.failureType || '',
              stage: req.body.failureStage || 'launch',
              reason: req.body.failureReason || '',
              details: req.body.failureDetails || ''
            },
            game: {
              name: req.body.gameName || '',
              file: req.body.gameFile || '',
              console: req.body.console || '',
              consoleTitle: req.body.consoleTitle || '',
              path: req.body.path || '',
              emulator: req.body.emulator || '',
              romExtension: req.body.romExtension || '',
              url: req.body.gameUrl || ''
            }
          });
          res.json({status: 'success'});
        } else if (type == 'listusers') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let users = [];
          for await (let userHash of Object.keys(profile)) {
            let overrides = normalizeUserOverrides(profile[userHash].settingsOverrides);
            let effective = effectiveSettingsForProfile(profile[userHash], settings);
            users.push({
              username: profile[userHash].username,
              role: roleFor(profile[userHash]),
              settingsOverrides: overrides,
              effectiveSettings: effective
            });
          }
          res.json({status: 'success', users: users});
        } else if (type == 'setrole') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let target = req.body.target;
          let role = req.body.role == 'admin' ? 'admin' : 'user';
          let adminCount = Object.keys(profile).filter(function(userHash) {
            return roleFor(profile[userHash]) === 'admin';
          }).length;
          for await (let userHash of Object.keys(profile)) {
            if (profile[userHash].username == target) {
              if (role !== 'admin' && roleFor(profile[userHash]) === 'admin' && adminCount <= 1) {
                res.json(error);
                return;
              }
              profile[userHash].role = role;
            }
          }
          await writeProfiles(profile);
          res.json({status: 'success'});
        } else if (type == 'setuseroverrides') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let targetHash = findUserHash(profile, req.body.target);
          if (!targetHash) {
            res.json(error);
            return;
          }
          profile[targetHash].settingsOverrides = normalizeUserOverrides(req.body.settingsOverrides);
          await writeProfiles(profile);
          res.json({status: 'success'});
        } else if (type == 'setmysettings') {
          profile[hash].settingsOverrides = normalizeUserOverrides(req.body.settingsOverrides);
          await writeProfiles(profile);
          let updatedResolvedSettings = effectiveSettingsForProfile(profile[hash], settings);
          res.json({
            status: 'success',
            settingsOverrides: normalizeUserOverrides(profile[hash].settingsOverrides),
            settings: {
              requireLogin: updatedResolvedSettings.requireLogin === true,
              selectorStyle: updatedResolvedSettings.selectorStyle === 'popup' ? 'popup' : 'menu',
              launchErrorDebug: updatedResolvedSettings.launchErrorDebug === true
            }
          });
        } else if (type == 'changepassword') {
          let newPass = req.body.newPass;
          if (!isStrongPassword(newPass)) {
            res.json(error);
            return;
          }
          if (currentRole !== 'admin' && hashProfile(profile[hash].username, req.body.oldPass || '') !== hash) {
            res.json(error);
            return;
          }
          let record = profile[hash];
          let newHash = hashProfile(record.username, newPass);
          delete profile[hash];
          profile[newHash] = record;
          await writeProfiles(profile);
          res.json({status: 'success'});
        } else if (type == 'adminchangepassword') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let targetHash = findUserHash(profile, req.body.target);
          let newPass = req.body.newPass;
          if (!targetHash || !isStrongPassword(newPass)) {
            res.json(error);
            return;
          }
          let record = profile[targetHash];
          let newHash = hashProfile(record.username, newPass);
          delete profile[targetHash];
          profile[newHash] = record;
          await writeProfiles(profile);
          res.json({status: 'success'});
        } else if (type == 'createsimpleuser') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let newUser = req.body.newUser;
          let newPass = req.body.newPass;
          let newRole = req.body.role == 'admin' ? 'admin' : 'user';
          if (!isValidUsername(newUser) || !isStrongPassword(newPass) || findUserHash(profile, newUser)) {
            res.json(error);
            return;
          }
          let newHash = hashProfile(newUser, newPass);
          profile[newHash] = {
            username: newUser,
            role: newRole,
            settingsOverrides: normalizeUserOverrides()
          };
          await writeProfiles(profile);
          if (!fs.existsSync(home + '/profile/' + newUser)) {
            await fsw.mkdir(home + '/profile/' + newUser);
            await fsw.writeFile(home + '/profile/' + newUser + '/retroarch.cfg', '');
          }
          res.json({status: 'success'});
        } else if (type == 'getsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          res.json({
            status: 'success',
            requireLogin: settings.requireLogin === true,
            selectorStyle: settings.selectorStyle === 'popup' ? 'popup' : 'menu',
            launchErrorDebug: settings.launchErrorDebug === true,
            passwordResetWebhook: settings.passwordResetWebhook || ''
          });
        } else if (type == 'setsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          settings.requireLogin = req.body.requireLogin === true;
          settings.selectorStyle = req.body.selectorStyle === 'popup' ? 'popup' : 'menu';
          settings.launchErrorDebug = req.body.launchErrorDebug === true;
          settings.passwordResetWebhook = req.body.passwordResetWebhook || '';
          await writeSettings(settings);
          res.json({status: 'success'});
        } else if (type == 'testpasswordresetwebhook') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          if (!settings.passwordResetWebhook) {
            res.json(error);
            return;
          }
          let sent = await sendWebhook(settings.passwordResetWebhook, {
            title: 'EmulatorJS password reset webhook test',
            event: 'password_reset_webhook_test',
            requestedBy: profile[hash].username,
          });
          res.json(sent ? {status: 'success'} : error);
        } else if (type == 'listprofilesaves') {
          let profilePath = profilePathForUser(profile[hash].username);
          let records = await listSaveVersionRecords(profilePath);
          let seenSaveKeys = new Set(records.map(function(record) {
            return record.saveKey || record.pathKey;
          }));
          let currentFiles = await collectFiles(profilePath, '', []);
          for await (let file of currentFiles) {
            if (!isSaveFile(file.relPath) || file.relPath.startsWith('.history/') || file.relPath.startsWith(SAVE_VERSION_ROOT + '/')) {
              continue;
            }
            if (seenSaveKeys.has(file.relPath)) {
              continue;
            }
            records.push({
              id: 'profile::current::' + file.relPath,
              pathKey: file.relPath,
              name: safeDecodeName(path.basename(file.relPath)),
              type: saveTypeForPath(file.relPath),
              source: 'Profile current',
              versionLabel: 'Current',
              versionSort: file.stat.mtimeMs || 0,
              createdAt: file.stat.mtime ? new Date(file.stat.mtime).toISOString() : '',
              size: file.stat.size || 0,
              current: true,
              saveKey: file.relPath
            });
          }
          let historyRoot = path.join(profilePath, '.history');
          if (fs.existsSync(historyRoot)) {
            let snapshots = await fsw.readdir(historyRoot);
            for await (let snapshot of snapshots) {
              let snapshotRoot = path.join(historyRoot, snapshot);
              let snapshotFiles = await collectFiles(snapshotRoot, '', []);
              for await (let file of snapshotFiles) {
                if (!isSaveFile(file.relPath) || seenSaveKeys.has(file.relPath)) {
                  continue;
                }
                records.push({
                  id: 'profile::history::' + snapshot + '::' + file.relPath,
                  pathKey: '.history/' + snapshot + '/' + file.relPath,
                  name: safeDecodeName(path.basename(file.relPath)),
                  type: saveTypeForPath(file.relPath),
                  source: 'Legacy backup: ' + snapshot,
                  versionLabel: snapshot,
                  versionSort: file.stat.mtimeMs || 0,
                  createdAt: file.stat.mtime ? new Date(file.stat.mtime).toISOString() : '',
                  size: file.stat.size || 0,
                  current: false,
                  saveKey: file.relPath
                });
              }
            }
          }
          records.sort(function(a, b) {
            if ((a.name || '') !== (b.name || '')) {
              return String(a.name || '').localeCompare(String(b.name || ''));
            }
            return Number(b.versionSort || 0) - Number(a.versionSort || 0);
          });
          res.json({status: 'success', saves: records});
        } else if (type == 'downloadprofilesave') {
          let profilePath = profilePathForUser(profile[hash].username);
          let relativePath = String(req.body.pathKey || '');
          if (!relativePath) {
            res.json(error);
            return;
          }
          let downloadPath = safeProfilePath(profilePath, relativePath);
          if (!fs.existsSync(downloadPath) || fs.statSync(downloadPath).isDirectory()) {
            res.json(error);
            return;
          }
          let contents = await fsw.readFile(downloadPath);
          res.json({status: 'success', data: contents.toString('base64')});
        // Take client data and write it to profile
        } else if (type == 'push') {
          let profilePath = profilePathForUser(profile[hash].username);
          let baseData = req.body.data;
          await fsw.mkdir(profilePath, {recursive: true});
          let zip = await JSZip.loadAsync(baseData, {base64: true});
          let backupStamp = timestampLabel();
          let saveSummary = { versioned: 0, created: 0, deduped: 0 };
          for await (let fileName of Object.keys(zip.files)) {
            let zipEntry = zip.files[fileName];
            if (zipEntry.dir) {
              await fsw.mkdir(safeProfilePath(profilePath, fileName), {recursive: true});
              continue;
            }
            let normalizedFileName = normalizeSaveRelativePath(fileName);
            let targetPath = safeProfilePath(profilePath, normalizedFileName);
            let content = Buffer.from(await zipEntry.async('arraybuffer'));
            await ensureDir(targetPath);
            let changed = true;
            if (fs.existsSync(targetPath)) {
              let existing = await fsw.readFile(targetPath);
              changed = !existing.equals(content);
              if (changed) {
                let backupPath = safeProfilePath(profilePath, '.history/' + backupStamp + '/' + normalizedFileName);
                await ensureDir(backupPath);
                await fsw.copyFile(targetPath, backupPath);
              }
            }
            if (isSaveFile(normalizedFileName)) {
              let versioned = await ensureSaveVersioned(profilePath, normalizedFileName, content, {
                source: 'Profile sync push',
                notes: changed ? 'Updated current save from client sync.' : 'Client sync matched existing current save.'
              });
              if (versioned) {
                saveSummary.versioned += 1;
                if (versioned.created) {
                  saveSummary.created += 1;
                } else {
                  saveSummary.deduped += 1;
                }
              }
            }
            await fsw.writeFile(targetPath, content);
          }
          res.json({status: 'success', user: profile[hash].username, saveSummary: saveSummary});
        // Send client data to write to indexedDB
        } else if (type == 'pull') {
          try {
            let profilePath = home + '/profile/' + profile[hash].username + '/';
            let zip = new JSZip();
            let items = await fs.readdirSync(profilePath);
            async function addToZip(item) {
              if (fs.lstatSync(item).isDirectory()) {
                if (path.basename(item) === '.history' || path.basename(item) === SAVE_VERSION_ROOT) {
                  return;
                }
                let items = await fs.readdirSync(item);
                if (items.length > 0) {
                  for await (let subPath of items) {
                    await addToZip(item + '/' + subPath);
                  }
                }
              } else {
                let data = fs.readFileSync(item);
                let zipPath = item.replace(profilePath,'');
                zip.file(zipPath, data);
              }
              return;
            }
            for await (let item of items) {
              await addToZip(profilePath + item);
            }
            zip.generateAsync({type:"base64"}).then(function callback(base64) {
              res.json({status: 'success',data: base64});
            });
          } catch (e) {
            console.log(e);
            res.json(error);
          }
        } else {
          res.json(error);
        }
      } else {
        if (type == 'login' && req.body.silent !== true) {
          let settings = await readSettings();
          await emitActivityWebhook(settings, req, {
            title: 'EmulatorJS login failed',
            event: 'login_failed',
            action: 'login',
            status: 'failed',
            username: req.body.user || '',
            source: req.body.source || 'unknown'
          });
        }
        res.json(error);
      }
    }
  } catch (e) {
    console.log(e)
    res.json(error);
  }
});

app.listen(3001);
