// NPM modules
var home = require('os').homedir();
var socketIO = require('socket.io');
var fs = require('fs');
var fsw = require('fs').promises;
var util = require('util');
var path = require('path');
var cloudcmd = require('cloudcmd');
var express = require('express');
var app = require('express')();
var httpModule = require('http');
var http = require('http').Server(app);
var baserouter = express.Router();
var { spawn, spawnSync } = require('child_process');
var { create } = require('ipfs-http-client');
var crypto = require('crypto');
var https = require('https');
var net = require('net');
var ipfs = create();
var merge = require('deepmerge');

// Default vars
if (home == '/data') {
  home = '/config'
}
var baseUrl = process.env.SUBFOLDER || '/';
if (fs.existsSync('/data')) { 
  var dataRoot = '/data/';
} else {
  var dataRoot = __dirname + '/frontend/user/'
};
var configPath = dataRoot + 'config/';
var hashPath = dataRoot + 'hashes/';
var metaPath = dataRoot + 'metadata/';
var defaultPeer = '/ip4/65.109.29.184/tcp/4001/p2p/12D3KooWAQZgCmhRo6V6yzGWTtw57xSRBnTn5kGMqzahFKyt5CW3';
var ipfsDownloadTimeout = Number(process.env.IPFS_DOWNLOAD_TIMEOUT || 7000);
var ipfsDownloadAttempts = Number(process.env.IPFS_DOWNLOAD_ATTEMPTS || 2);
var reconnectDefaultPeer = process.env.IPFS_RECONNECT_DEFAULT_PEER === 'true';
var metaVariables = [
  ['vid', 'videos', '.mp4'],
  ['logo', 'logos', '.png'],
  ['back', 'backgrounds', '.png'],
  ['corner', 'corners', '.png']
];
var emus = [
  {'name': '3do', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'arcade', 'video_position': 'left:10.3vw;top:30.5vh;width:36.5vw;height:48vh;'},
  {'name': 'atari2600', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'atari5200', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'atari7800', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'colecovision', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'doom', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'gb', 'video_position': 'left:14.5vw;top:31vh;width:26vw;height:43.5vh;'},
  {'name': 'gba', 'video_position': 'left:13.5vw;top:36vh;width:31.7vw;height:38.3vh;'},
  {'name': 'gbc', 'video_position': 'left:15.5vw;top:31.2vh;width:28vw;height:44.7vh;'},
  {'name': 'jaguar', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'lynx', 'video_position': 'left:11vw;top:31vh;width:36vw;height:44vh;'},
  {'name': 'msx', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'n64', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'nds', 'video_position': 'left:23.8vw;top:25.7vh;width:20vw;height:56vh;'},
  {'name': 'nes', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'ngp', 'video_position': 'left:15vw;top:34vh;width:25vw;height:40vh;'},
  {'name': 'odyssey2', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'pce', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'psx', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'sega32x', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'segaCD', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'segaGG', 'video_position': 'left:12.3vw;top:31.5vh;width:33.4vw;height:43.3vh;'},
  {'name': 'segaMD', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'segaMS', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'segaSaturn', 'video_position': 'left:11.5vw;top:30vh;width:36.3vw;height:45.5vh;'},
  {'name': 'segaSG', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'snes', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'vb', 'video_position': 'left:11.5vw;top:31.5vh;width:36vw;height:43vh;'},
  {'name': 'vectrex', 'video_position': 'left:18vw;top:30vh;width:22vw;height:46vh;'},
  {'name': 'ws', 'video_position': 'left:11.5vw;top:31vh;width:35vw;height:43vh;'}
];
var retroArchCfg = `
input_menu_toggle_gamepad_combo = 3
system_directory = /home/web_user/retroarch/system/`
var adminSessions = new Map();
var adminAuthAttempts = new Map();
var socketAdminAuthAttempts = new Map();
var RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
var ADMIN_AUTH_LIMIT = 15;
var USERNAME_REGEX = /^[A-Za-z0-9._-]{3,32}$/;
var settingsFile = home + '/profile/settings.json';
var geoLookupCache = new Map();
var GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function rescanFlagPath(dir, file) {
  return hashPath + dir + '/rescan/' + encodeURIComponent(file) + '.rescan';
}

async function applyPendingRescans(dir) {
  let rescanDir = hashPath + dir + '/rescan/';
  if (!fs.existsSync(rescanDir)) {
    return 0;
  }
  let flags = await fsw.readdir(rescanDir);
  let count = 0;
  for await (let flag of flags) {
    if (!flag.endsWith('.rescan')) {
      continue;
    }
    let file = decodeURIComponent(flag.replace(/\.rescan$/, ''));
    let shaFile = hashPath + dir + '/roms/' + file + '.sha1';
    if (fs.existsSync(shaFile)) {
      fs.unlinkSync(shaFile);
      count++;
    }
    await fsw.rm(rescanDir + flag, {force: true});
  }
  return count;
}

function normalizeRomName(value) {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function canonicalVariantInfo(fileName) {
  let fileExtension = path.extname(fileName || '');
  let baseName = path.basename(fileName || '', fileExtension).trim();
  let working = baseName;
  let tokens = [];
  function isRegionToken(content) {
    let value = String(content || '').trim().toLowerCase();
    return /^(u|usa|e|europe|j|japan|w|world|g|germany|f|france|s|spain|i|italy|australia|asia|unl|pd)$/i.test(value)
      || /^(usa|europe|japan|world)(,\s*(usa|europe|japan|world))+$/i.test(value);
  }
  function isVersionToken(content) {
    return /^v\d+(\.\d+)?$/i.test(String(content || '').trim()) || /^rev\s*\d+$/i.test(String(content || '').trim());
  }
  function shouldStripParen(content) {
    let value = String(content || '').trim();
    return isRegionToken(value)
      || isVersionToken(value)
      || /^(beta|proto|sample|demo|hack|unl|pd)$/i.test(value);
  }
  while (true) {
    let match = working.match(/\s*(\[[^\]]+\]|\([^()]+\))\s*$/);
    if (!match) {
      break;
    }
    let token = match[1];
    let content = token.slice(1, -1).trim();
    if (token.startsWith('[') || shouldStripParen(content)) {
      tokens.unshift({raw: token, content: content});
      working = working.slice(0, match.index).trim();
      continue;
    }
    break;
  }
  let region = '';
  let version = '';
  let flags = [];
  let clean = false;
  for (let token of tokens) {
    if (!region && isRegionToken(token.content)) {
      region = token.content;
      continue;
    }
    if (!version && isVersionToken(token.content)) {
      version = token.content.toUpperCase();
      continue;
    }
    if (token.raw === '[!]') {
      clean = true;
      continue;
    }
    flags.push(token.raw);
  }
  let title = working || baseName;
  let canonicalKey = normalizeRomName(title);
  let regionKey = normalizeRomName(region || 'default');
  let artGroupKey = canonicalKey + '|' + regionKey;
  return {
    fileName: fileName,
    title: title,
    canonicalKey: canonicalKey,
    artGroupKey: artGroupKey,
    region: region,
    version: version,
    flags: flags,
    clean: clean
  };
}

function artStateDir(dir) {
  return hashPath + dir + '/art-state/';
}

function artFailPath(dir, fileName, assetType) {
  return artStateDir(dir) + encodeURIComponent(fileName) + '--' + assetType + '.failed';
}

async function markArtFailed(dir, fileName, assetType) {
  await fsw.mkdir(artStateDir(dir), {recursive: true});
  await fsw.writeFile(artFailPath(dir, fileName, assetType), new Date().toISOString());
}

function artFailed(dir, fileName, assetType) {
  return fs.existsSync(artFailPath(dir, fileName, assetType));
}

async function clearArtFailed(dir, fileName, assetType) {
  let failPath = artFailPath(dir, fileName, assetType);
  if (fs.existsSync(failPath)) {
    await fsw.rm(failPath, {force: true});
  }
}

async function autoIdentifyPreferredRegion(dir, preferredRegion) {
  if (!preferredRegion) {
    return 0;
  }
  let shaPath = hashPath + dir + '/roms/';
  if (!fs.existsSync(shaPath)) {
    return 0;
  }
  await fsw.mkdir(metaPath, { recursive: true });
  let metaData = JSON.parse(await fsw.readFile('./metadata/' + dir + '.json', 'utf8'));
  let userMetaFile = metaPath + dir + '.json';
  let userMeta = {};
  if (fs.existsSync(userMetaFile)) {
    userMeta = JSON.parse(await fsw.readFile(userMetaFile, 'utf8'));
  }
  metaData = merge(metaData, userMeta);
  let region = String(preferredRegion).toLowerCase();
  let files = await fsw.readdir(shaPath);
  let linked = 0;
  for await (let file of files) {
    let romFile = file.replace('.sha1', '');
    let sha = await fsw.readFile(shaPath + file, 'utf8');
    if (metaData.hasOwnProperty(sha)) {
      continue;
    }
    let targetName = normalizeRomName(romFile);
    let romRegion = (romFile.match(/\(([^)]*)\)/) || [])[1];
    let effectiveRegion = String(romRegion || region).toLowerCase();
    if (!effectiveRegion) {
      continue;
    }
    let matches = Object.keys(metaData).filter(function(metaSha) {
      let record = metaData[metaSha];
      if (!record || !record.name) {
        return false;
      }
      let name = String(record.name);
      return normalizeRomName(name) === targetName && name.toLowerCase().indexOf('(' + effectiveRegion + ')') !== -1;
    });
    if (matches.length === 1) {
      userMeta[sha] = {ref: matches[0]};
      linked++;
    }
  }
  if (linked > 0) {
    await fsw.writeFile(userMetaFile, JSON.stringify(userMeta, null, 2));
  }
  return linked;
}

function roleFor(profileRecord) {
  return profileRecord && profileRecord.role === 'admin' ? 'admin' : 'user';
}

async function readProfiles() {
  let profilesData = await fsw.readFile(home + '/profile/profile.json', 'utf8');
  let profiles = JSON.parse(profilesData);
  let changed = false;
  let hasAdmin = Object.keys(profiles).some(function(userHash) {
    return profiles[userHash] && profiles[userHash].role === 'admin';
  });
  if (!hasAdmin) {
    let fallbackHash = Object.keys(profiles).find(function(userHash) {
      return profiles[userHash] && profiles[userHash].username === 'eugene';
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
  }
  if (changed) {
    await fsw.writeFile(home + '/profile/profile.json', JSON.stringify(profiles, null, 2));
  }
  return profiles;
}

async function authenticateProfile(user, pass) {
  if (!user || !pass) {
    return null;
  }
  let hash = crypto.createHash('sha256').update(user + pass).digest('hex');
  let profilesJson = await readProfiles();
  if (!profilesJson.hasOwnProperty(hash)) {
    return null;
  }
  return {
    username: profilesJson[hash].username,
    role: roleFor(profilesJson[hash])
  };
}

function defaultSettings() {
  return {
    requireLogin: false,
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

function adminTokenFromRequest(req) {
  let cookieHeader = req.headers.cookie || '';
  let cookies = Object.fromEntries(cookieHeader.split(';').map(cookie => {
    let parts = cookie.trim().split('=');
    return [parts.shift(), parts.join('=')];
  }).filter(cookie => cookie[0]));
  return cookies.ejs_admin_session;
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

function expectedOrigin(req) {
  let protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let proto = protoHeader || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + req.headers.host;
}

function isTrustedOrigin(req) {
  let origin = originFromValue(req.headers.origin) || originFromValue(req.headers.referer);
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

function adminCookieFlags(req) {
  let protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let isSecure = protoHeader === 'https' || (originFromValue(req.headers.origin) || '').startsWith('https://') || (originFromValue(req.headers.referer) || '').startsWith('https://');
  return 'Path=' + baseUrl + '; SameSite=Strict; HttpOnly' + (isSecure ? '; Secure' : '');
}

function sendWebhook(url, payload) {
  return new Promise(function(resolve, reject) {
    try {
      let parsed = new URL(url);
      let body = JSON.stringify(payload);
      let client = parsed.protocol === 'https:' ? https : httpModule;
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
      let client = parsed.protocol === 'https:' ? https : httpModule;
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
            message: ok ? 'Influx accepted the test event.' : 'Influx rejected the test event.',
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

async function emitActivityWebhook(req, payload) {
  let settings = await readSettings();
  let geo = await requestGeo(req);
  let publicIps = publicRequestIps(req);
  let localIp = forwardedIps(req)[0] || normalizeIp(req.headers['x-real-ip']) || normalizeIp(req.socket.remoteAddress) || '';
  let publicIpv4 = publicIps.find(function(ip) { return net.isIP(ip) === 4; }) || '';
  let publicIpv6 = publicIps.find(function(ip) { return net.isIP(ip) === 6; }) || '';
  let eventPayload = Object.assign({
    app: 'EmulatorJS',
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
  }, payload || {});
  eventPayload.geo = geo || null;
  eventPayload.geoSummary = geo ? buildGeoSummary(geo) : (isPrivateIp(eventPayload.localIp || eventPayload.ip) ? 'Local network' : '');
  eventPayload.geoCountry = geo && geo.country || '';
  eventPayload.geoCountryCode = geo && geo.countryCode || '';
  eventPayload.geoRegion = geo && (geo.region || geo.regionCode) || '';
  eventPayload.geoCity = geo && geo.city || '';
  eventPayload.geoPostalCode = geo && geo.postalCode || '';
  eventPayload.geoTimezone = geo && geo.timezone || '';
  eventPayload.geoLatitude = geo && geo.latitude || '';
  eventPayload.geoLongitude = geo && geo.longitude || '';
  eventPayload.geoIsp = geo && geo.isp || '';
  eventPayload.geoOrg = geo && geo.org || '';
  eventPayload.geoAsn = geo && geo.asn || '';
  if (settings.localLogsEnabled !== false) {
    runLogDb('write', {
      retentionDays: settings.localLogRetentionDays || 90,
      entry: eventPayload
    });
  }
  try {
    if (settings.passwordResetWebhook) {
      await sendWebhook(settings.passwordResetWebhook, eventPayload);
    }
    if (settings.influxEnabled) {
      await sendInflux(settings, eventPayload);
    }
    return true;
  } catch (e) {
    console.log('Webhook send failed', e);
    return false;
  }
}

function isValidUsername(username) {
  let value = String(username || '');
  if (!USERNAME_REGEX.test(value)) {
    return false;
  }
  let lower = value.toLowerCase();
  return lower !== 'default' && lower !== '.history' && lower !== 'history';
}

function isAdminSession(token) {
  let session = token && adminSessions.get(token);
  if (!session) {
    return false;
  }
  if (Date.now() - session.created > 12 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    return false;
  }
  return session.role === 'admin';
}

function requireAdminHttp(req, res, next) {
  if (isAdminSession(adminTokenFromRequest(req))) {
    next();
    return;
  }
  res.status(403).send('Admin login required');
}

app.use(function(req, res, next) {
  res.header("Cross-Origin-Embedder-Policy", "require-corp");
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: '5mb' }));

//// Http server ////
baserouter.use('/public', express.static(__dirname + '/public'));
baserouter.use('/frontend', express.static(__dirname + '/frontend'));
baserouter.post('/adminauth', async function(req, res) {
  try {
    if (!isTrustedOrigin(req)) {
      res.status(403).json({status: 'error'});
      return;
    }
    if (!consumeRateLimit(adminAuthAttempts, requestIp(req), ADMIN_AUTH_LIMIT, RATE_LIMIT_WINDOW_MS)) {
      await emitActivityWebhook(req, {
        title: 'EmulatorJS admin login throttled',
        event: 'admin_login_throttled',
        action: 'admin_login',
        status: 'blocked',
        username: req.body.user || '',
        source: 'admin-manager',
        reason: 'rate_limited'
      });
      res.status(429).json({status: 'error'});
      return;
    }
    let profile = await authenticateProfile(req.body.user, req.body.pass);
    if (!profile || profile.role !== 'admin') {
      await emitActivityWebhook(req, {
        title: 'EmulatorJS admin login failed',
        event: 'admin_login_failed',
        action: 'admin_login',
        status: 'failed',
        username: req.body.user || '',
        role: profile ? profile.role : '',
        source: 'admin-manager'
      });
      res.status(403).json({status: 'error'});
      return;
    }
    let token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, {user: profile.username, role: profile.role, created: Date.now()});
    res.setHeader('Set-Cookie', 'ejs_admin_session=' + token + '; ' + adminCookieFlags(req));
    await emitActivityWebhook(req, {
      title: 'EmulatorJS admin login succeeded',
      event: 'admin_login_success',
      action: 'admin_login',
      status: 'success',
      username: profile.username,
      role: profile.role,
      source: 'admin-manager'
    });
    res.json({status: 'success', user: profile.username, role: profile.role});
  } catch(e) {
    console.log(e);
    res.status(500).json({status: 'error'});
  }
});
baserouter.post('/adminlogout', function(req, res) {
  if (!isTrustedOrigin(req)) {
    res.status(403).json({status: 'error'});
    return;
  }
  let token = adminTokenFromRequest(req);
  if (token) {
    adminSessions.delete(token);
  }
  res.setHeader('Set-Cookie', 'ejs_admin_session=; ' + adminCookieFlags(req) + '; Max-Age=0');
  res.json({status: 'success'});
});
baserouter.post('/profileapi', function(req, res) {
  if (!isTrustedOrigin(req)) {
    res.status(403).json({status: 'error'});
    return;
  }
  let body = JSON.stringify(req.body || {});
  let proxy = httpModule.request({
    method: 'POST',
    hostname: '127.0.0.1',
    port: 3001,
    path: '/',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
      'User-Agent': req.headers['user-agent'] || '',
      'Referer': req.headers.referer || '',
      'Origin': req.headers.origin || '',
      'Host': req.headers.host || ''
    }
  }, function(proxyRes) {
    res.status(proxyRes.statusCode || 200);
    proxyRes.pipe(res);
  });
  proxy.on('error', function(e) {
    console.log(e);
    res.status(500).json({status: 'error'});
  });
  proxy.write(body);
  proxy.end();
});
baserouter.get("/", function (req, res) {
  res.sendFile(__dirname + '/public/index.html');
});
app.use(baseUrl, baserouter);
http.listen(3000);

//// socketIO comms ////
io = socketIO(http, {path: baseUrl + 'socket.io',maxHttpBufferSize: 100000000});
io.on('connection', async function (socket) {
  let sessionToken = adminTokenFromRequest(socket.request || {headers: {}});
  let existingSession = sessionToken && adminSessions.get(sessionToken);
  socket.adminAuthenticated = isAdminSession(sessionToken);

  async function renderInitialAdminPage() {
    if (fs.existsSync(dataRoot + 'config/main.json')) {
      await renderRoms();
    } else {
      renderLanding();
    };
  }

  function requireAdmin(handler) {
    return async function(data) {
      if (!socket.adminAuthenticated) {
        socket.emit('adminauth', {status: 'error'});
        return;
      }
      return await handler(data);
    };
  }

  //// Functions ////
  // Send config list to client
  async function renderConfigs() {
    var files = await fsw.readdir(configPath);
    socket.emit('renderconfigs', files);
  };

  // Send MetaData list to client
  async function renderMeta() {
    await fsw.mkdir(metaPath, { recursive: true });
    var files = await fsw.readdir(metaPath);
    socket.emit('rendermeta', files);
  };

  // Send rom directories to client
  async function renderRomsDir() {
    let dirData = [];
    if (fs.existsSync(hashPath)) {
      let dirs = await fsw.readdir(hashPath);
      for await (let dir of dirs) {
        if (fs.lstatSync(hashPath + dir).isDirectory()) {
          dirData.push(dir);
        }
      }
      socket.emit('renderromsdir', dirData);
    } else {
      socket.emit('renderromsdir', dirData);
    };
  };

  // Tell client to render rom scanners
  async function renderRoms() {
    var romData = {}
    for await (var emu of emus) {
      var romCount = 0;
      var hashCount = 0;
      var romPath = dataRoot + emu.name + '/roms/';
      if (fs.existsSync(hashPath + emu.name)) {
        var hashes = await fsw.readdir(hashPath + emu.name + '/roms/');
        var hashCount = hashes.length;
      };
      if (fs.existsSync(romPath)) {
        var roms = await fsw.readdir(romPath);
        var romCount = roms.length;
      };
      romData[emu.name] = {'roms': romCount,'hashes': hashCount};
    };
    // Grab default files data
    var defaultFiles = await fsw.readFile('./metadata/default_files.json', 'utf8');
    var defaultFiles = JSON.parse(defaultFiles);
    var defaultCount = defaultFiles.length;
    var defaultDlCount = 0;
    for await (var item of defaultFiles) {
      if (fs.existsSync(item.file.replace('/data/', dataRoot))) {
        defaultDlCount++
      };
    };
    romData['default'] = {'available': defaultCount,'downloaded': defaultDlCount};
    renderRomsDir();
    socket.emit('renderromslanding', romData);
  };

  // Tell client to render landing
  function renderLanding() {
    socket.emit('renderlanding');
  };

  async function renderLogs(filters) {
    let settings = await readSettings();
    let logs = runLogDb('query', {filters: filters || {}});
    socket.emit('renderlogs', {
      events: logs.events || [],
      total: logs.total || 0,
      filters: filters || {},
      settings: {
        localLogsEnabled: settings.localLogsEnabled !== false,
        localLogRetentionDays: settings.localLogRetentionDays || 90,
        influxEnabled: settings.influxEnabled === true,
        influxUrl: settings.influxUrl || '',
        influxOrg: settings.influxOrg || '',
        influxBucket: settings.influxBucket || '',
        influxTokenConfigured: !!settings.influxToken,
        webhookConfigured: !!settings.passwordResetWebhook
      }
    });
  }

  async function saveLogSettings(data) {
    let settings = await readSettings();
    settings.localLogsEnabled = data.localLogsEnabled !== false;
    settings.localLogRetentionDays = Math.max(1, Math.min(parseInt(data.localLogRetentionDays || 90, 10) || 90, 3650));
    settings.influxEnabled = data.influxEnabled === true;
    settings.influxUrl = String(data.influxUrl || '').trim();
    settings.influxOrg = String(data.influxOrg || '').trim();
    settings.influxBucket = String(data.influxBucket || '').trim();
    if (typeof data.influxToken === 'string' && data.influxToken.trim() !== '') {
      settings.influxToken = data.influxToken.trim();
    } else if (data.clearInfluxToken === true) {
      settings.influxToken = '';
    }
    await writeSettings(settings);
    await renderLogs(data.filters || {});
    socket.emit('modaldata', 'Saved log settings.');
  }

  async function testLogInflux(data) {
    let settings = await readSettings();
    let testSettings = Object.assign({}, settings, {
      influxEnabled: data.influxEnabled === true,
      influxUrl: String(data.influxUrl || '').trim(),
      influxOrg: String(data.influxOrg || '').trim(),
      influxBucket: String(data.influxBucket || '').trim()
    });
    if (typeof data.influxToken === 'string' && data.influxToken.trim() !== '') {
      testSettings.influxToken = data.influxToken.trim();
    }
    let result = {
      ok: false,
      message: 'Influx test failed.',
      statusCode: 0,
      responseBody: ''
    };
    try {
      result = await sendInflux(testSettings, {
        app: 'EmulatorJS',
        title: 'EmulatorJS Influx test event',
        event: 'influx_test',
        action: 'settings_test',
        status: 'success',
        source: 'admin-logs',
        username: existingSession ? existingSession.user : '',
        role: existingSession ? existingSession.role : '',
        time: new Date().toISOString(),
        ip: socket.handshake.address || '',
        host: socket.handshake.headers.host || '',
        origin: socket.handshake.headers.origin || '',
        referer: socket.handshake.headers.referer || '',
        requestPath: baseUrl
      }, true);
    } catch (e) {
      console.log('Influx test failed', e);
      result = {
        ok: false,
        message: e.message || 'Influx test failed.',
        statusCode: 0,
        responseBody: ''
      };
    }
    socket.emit('influxtest', {
      status: result.ok ? 'success' : 'error',
      message: result.message || (result.ok ? 'Influx accepted the test event.' : 'Influx test failed.'),
      statusCode: result.statusCode || 0,
      responseBody: result.responseBody || '',
      influxUrl: testSettings.influxUrl || '',
      influxOrg: testSettings.influxOrg || '',
      influxBucket: testSettings.influxBucket || '',
      requestPath: result.requestPath || ''
    });
  }

  // Send file contents to client
  async function getConfig(file) {
    file = file + '.json';
    let fileContents = await fsw.readFile(configPath + file, 'utf8');
    socket.emit('renderconfig', JSON.parse(fileContents));
  };

 // Send meta contents to client
  async function getMetaJSON(file) {
    file = file + '.json';
    let fileContents = await fsw.readFile(metaPath + file, 'utf8');
    socket.emit('rendermetajson', JSON.parse(fileContents));
  };

  // Save sent config file
  async function saveConfig(data) {
    var fileName = data.name + '.json';
    configFile = JSON.stringify(data.config, null, 2);
    await fsw.writeFile(configPath + fileName, configFile);
  };

  // Organize rom data to send to client
  async function getRoms(dir) {
    let metaData = await getMeta(dir);
    let shaPath = hashPath + dir + '/roms/';
    let files = await fsw.readdir(shaPath);
    let identified = {};
    let unidentified = {};
    let metaVars = [];
    metaVars.push(...metaVariables);
    metaVars.push(['video_position', 'videos', '.position']);
    for (var file of files) {
      let fileName = file.replace('.sha1','');
      let fileExtension = path.extname(fileName);
      let name = path.basename(fileName, fileExtension);
      var sha = await fsw.readFile(shaPath + file, 'utf8');
      if (metaData.hasOwnProperty(sha)) {
        if (metaData[sha].hasOwnProperty('ref')) {
          var sha = metaData[sha].ref;
        };
        identified[fileName] = {'has_art': 'none'};
	for await (let variable of metaVars) {
          if (metaData[sha].hasOwnProperty(variable[0])) {
            if (fs.existsSync(dataRoot + dir + '/' + variable[1] + '/' + name + variable[2])) {
              identified[fileName] = {'has_art': true};
            } else {
              identified[fileName] = {'has_art': false};
              break;
            };
          };
        };
      } else {
        unidentified[fileName] = sha;
      };
    };
    socket.emit('renderrom', [identified, unidentified, metaData]);
  }
  // IPFS downloading
  async function ipfsDownload(cid, file, count, options) {
    count++
    options = Object.assign({
      timeout: ipfsDownloadTimeout,
      attempts: ipfsDownloadAttempts
    }, options || {});
    await fsw.mkdir(path.dirname(file), { recursive: true });
    let writeStream = fs.createWriteStream(file);
    socket.emit('modaldata', 'Downloading: ' + file);
    try {
      for await (var fileStream of ipfs.cat(cid, {'timeout': options.timeout})) {
        writeStream.write(fileStream);
      };
      writeStream.end();
      try {
        await ipfs.pin.add(cid);
      } catch (e) {
        console.log(e);
        return '';
      };
    } catch (e) {
      writeStream.end();
      if (count < options.attempts) {
        if (reconnectDefaultPeer) {
          try {
            await ipfsDefaultPeer();
          } catch (peerError) {
            console.log('Default IPFS peer unavailable; continuing retry:', peerError.message || peerError);
          };
        };
        return await ipfsDownload(cid, file, count, options);
      } else {
        socket.emit('modaldata', 'ERROR Downloading: ' + file);
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        return false;
      };
    };
    return true;
  };

  // Set default ipfs peer if DL times out
  async function ipfsDefaultPeer() {
    await ipfs.swarm.connect(defaultPeer);
  };

  // Download default files for user directory
  async function dlDefaultFiles() {
    var metaData = await fsw.readFile('./metadata/default_files.json', 'utf8');
    var metaData = JSON.parse(metaData);
    socket.emit('emptymodal');
    for await (var item of metaData) {
      var file = item.file.replace('/data/', dataRoot);
      var cid = item.cid;
      if (cid == 'directory') {
        await fsw.mkdir(file, { recursive: true });
      } else {
        await ipfsDownload(cid, file, 0);
      }
    };
    for await (var dir of emus) {
      var path = dataRoot + 'hashes/' + dir.name + '/roms/';
      if (fs.existsSync(path)) {
        var roms = await fsw.readdir(path);
        if (roms.length > 0) {
          socket.emit('modaldata', 'Processing Config for ' + dir.name);
          await addToConfig(dir.name, true);
        };
      };
    };
    socket.emit('modaldata', 'Downloaded All Files');
    renderRoms();
  };

  // Scan roms directory using helper script
  async function scanRoms(data) {
    let folder = data[0];
    let fullScan = data[1];
    let preferredRegion = data[2] || '';
    socket.emit('emptymodal');
    let pendingRescans = await applyPendingRescans(folder);
    if (pendingRescans > 0) {
      socket.emit('modaldata', 'Queued rescan for ' + pendingRescans + ' item(s).');
    }
    let scanProcess = spawn('./has_files.sh', ['/' + folder + '/roms/', folder, fullScan]);
    scanProcess.stdout.setEncoding('utf8');
    scanProcess.stderr.setEncoding('utf8');
    scanProcess.stdout.on('data', function(data) {
      socket.emit('modaldata', data);
    });
    scanProcess.stderr.on('data', function(data) {
      socket.emit('modaldata', data);
    });
    scanProcess.on('close', async function(code) {
      socket.emit('modaldata', 'Scan exited with code: ' + code);
      if (preferredRegion) {
        try {
          let linked = await autoIdentifyPreferredRegion(folder, preferredRegion);
          socket.emit('modaldata', 'Preferred region auto-linked ' + linked + ' item(s).');
        } catch(e) {
          console.log(e);
          socket.emit('modaldata', 'Preferred region auto-link failed.');
        }
      }
      if (fullScan) {
        renderRoms();
      } else {
        getRoms(folder);
      }
    });
  };

  // Add roms to config file
  async function addToConfig(dir, render) {
    // For arcade roms we need clone info
    if (dir == 'arcade') { 
      var metaData = await getMeta(dir);
    };
    // Update config file with current rom files
    let configFile = configPath + dir + '.json';
    let shaPath = hashPath + dir + '/roms/';
    let files = await fsw.readdir(shaPath);
    let config = await fsw.readFile(configFile, 'utf8');
    config = JSON.parse(config);
    config.items = {};
    if (files.length < 9) {
      var itemsLength = files.length;
    } else {
      var itemsLength = 9;
    };
    config.display_items = itemsLength;
    for await (let file of files) {
      let fileName = file.replace('.sha1','');
      let fileExtension = path.extname(fileName);
      let name = path.basename(fileName, fileExtension);
      let has_logo = fs.existsSync(dataRoot + dir + '/logos/' + name + '.png');
      let has_back = fs.existsSync(dataRoot + dir + '/backgrounds/' + name + '.png');
      let has_corner = fs.existsSync(dataRoot + dir + '/corners/' + name + '.png');
      let has_video = fs.existsSync(dataRoot + dir + '/videos/' + name + '.mp4');
      let positionFile = dataRoot + dir + '/videos/' + name + '.position';
      config.items[name] = {};
      var multi_disc = 0;
      if (fileExtension == '.disk1') {
        var roms = await fsw.readdir(dataRoot + dir + '/roms/');
        for await (var rom of roms) {
          var romExtension = path.extname(rom);
          var romName = path.basename(rom, romExtension);
          if (romName == name) {
            multi_disc++
          }
        };
      };
      if ((dir == 'arcade') && (metaData.hasOwnProperty(name)) && (metaData[name].hasOwnProperty('cloneof'))) {
        Object.assign(config.items[name], {'cloneof': metaData[name].cloneof});
      };
      if (multi_disc !== config.defaults.multi_disc) {
        Object.assign(config.items[name], {'multi_disc': multi_disc});
      };
      if (fs.existsSync(positionFile)) {
        let video_position = await fsw.readFile(positionFile, 'utf8');
        Object.assign(config.items[name], {'video_position': video_position});
      };
      if (has_logo !== config.defaults.has_logo) {
        Object.assign(config.items[name], {'has_logo': has_logo});
      };
      if (has_back !== config.defaults.has_back) {
        Object.assign(config.items[name], {'has_back': has_back});
      };
      if (has_corner !== config.defaults.has_corner) {
        Object.assign(config.items[name], {'has_corner': has_corner});
      };
      if (has_video !== config.defaults.has_video) {
        Object.assign(config.items[name], {'has_video': has_video});
      };
      if (fileExtension !== config.defaults.rom_extension) {
        Object.assign(config.items[name], {'rom_extension': fileExtension});
      };
    };
    var configContents = JSON.stringify(config, null, 2);
    await fsw.writeFile(configFile, configContents);
    // Update main to include stuff with roms
    var mainFile = configPath + 'main.json';
    var main = await fsw.readFile(mainFile, 'utf8');
    var main = JSON.parse(main);
    main.items = {};
    for await (var emu of emus) {
      var emuPath = dataRoot + 'hashes/' + emu.name + '/roms/';
      if (fs.existsSync(emuPath)) {
        var roms = await fsw.readdir(emuPath);
        if (roms.length > 0) {
          main.items[emu.name] = {'video_position': emu.video_position};
        };
      };
    };
    if (Object.keys(main.items).length < 9) {
      main.display_items = Object.keys(main.items).length;
    } else {
      main.display_items = 9;
    };
    var mainContents = JSON.stringify(main, null, 2);
    await fsw.writeFile(mainFile, mainContents);
    // Render page for user if needed
    if (render) {
      return '';
    } else {
      renderRoms();
    };
  };

  // Remove config items without art
  async function purgeNoArt(dir) {
    var configFile = configPath + dir + '.json';
    var config = await fsw.readFile(configFile, 'utf8');
    var config = JSON.parse(config);
    for await (let item of Object.keys(config.items)) {
      if ((config.items[item].hasOwnProperty('has_logo')) || (config.items[item].hasOwnProperty('has_video'))) {
        if ((config.items[item].has_logo == false) || (config.items[item].has_video == false)) {
          delete config.items[item];
        }
      }
    }
    var configContents = JSON.stringify(config, null, 2);
    await fsw.writeFile(configFile, configContents);
    renderRoms();
  }

  // Download art assets from IPFS
  async function downloadArt(data) {
    let dir = Array.isArray(data) ? data[0] : data;
    let fullScan = Array.isArray(data) ? !!data[1] : true;
    var metaData = await getMeta(dir);
    var shaPath = hashPath + dir + '/roms/';
    var files = await fsw.readdir(shaPath);
    var artCache = {};
    var mode = fullScan ? 'all items' : 'new items only';
    var downloadedCount = 0;
    var skippedCount = 0;
    var failedCount = 0;
    socket.emit('emptymodal');
    socket.emit('modaldata', 'Downloading art for ' + dir + ' (' + mode + ')');
    for await (var file of files) {
      var fileName = file.replace('.sha1','');
      var fileExtension = path.extname(fileName);
      var name = path.basename(fileName, fileExtension);
      var sha = await fsw.readFile(shaPath + file, 'utf8');
      var variantInfo = canonicalVariantInfo(fileName);
      if (metaData.hasOwnProperty(sha)) {
        if (metaData[sha].hasOwnProperty('ref')) {
          var sha = metaData[sha].ref;
        };
        for await (var variable of metaVariables) {
          if (metaData[sha].hasOwnProperty(variable[0])) {
            let targetFile = dataRoot + dir + '/' + variable[1] + '/' + name + variable[2];
            let cacheKey = variantInfo.artGroupKey + '|' + variable[0] + '|' + metaData[sha][variable[0]];
            if (!fullScan && fs.existsSync(targetFile)) {
              skippedCount++;
              continue;
            }
            if (!fullScan && artFailed(dir, fileName, variable[0])) {
              skippedCount++;
              socket.emit('modaldata', 'Skipping failed ' + variable[0] + ': ' + fileName);
              continue;
            }
            if (artCache[cacheKey] && artCache[cacheKey].status === 'success' && fs.existsSync(artCache[cacheKey].file)) {
              await fsw.mkdir(path.dirname(targetFile), {recursive: true});
              await fsw.copyFile(artCache[cacheKey].file, targetFile);
              await clearArtFailed(dir, fileName, variable[0]);
              downloadedCount++;
              socket.emit('modaldata', 'Copied cached ' + variable[0] + ': ' + fileName);
              continue;
            }
            if (!fullScan && artCache[cacheKey] && artCache[cacheKey].status === 'failed') {
              skippedCount++;
              await markArtFailed(dir, fileName, variable[0]);
              continue;
            }
            let success = await ipfsDownload(metaData[sha][variable[0]], targetFile, 0, {
              timeout: Math.min(ipfsDownloadTimeout, 2500),
              attempts: 3
            });
            if (success) {
              artCache[cacheKey] = {status: 'success', file: targetFile};
              await clearArtFailed(dir, fileName, variable[0]);
              downloadedCount++;
            } else {
              artCache[cacheKey] = {status: 'failed'};
              await markArtFailed(dir, fileName, variable[0]);
              failedCount++;
            }
          };
        };
        if (metaData[sha].hasOwnProperty('video_position')) {
          await fsw.writeFile(dataRoot + dir + '/videos/' + name + '.position', metaData[sha].video_position); 
        };
      };
    };
    socket.emit('modaldata', 'Art download complete. Downloaded/Copied: ' + downloadedCount + ', Skipped: ' + skippedCount + ', Failed: ' + failedCount);
    getRoms(dir);
  };

  // Set user linked metadata
  async function userMeta(data) {
    await fsw.mkdir(metaPath, { recursive: true });
    let romSha = data[0];
    let linkSha = data[1];
    let dir = data[2];
    if (fs.existsSync(metaPath + dir + '.json')) {
      var metaData = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      var metaData = JSON.parse(metaData);
    } else {
      var metaData = {};
    };
    let link = {};
    link[romSha] = {'ref': linkSha};
    Object.assign(metaData, link);
    userMetadataFile = JSON.stringify(metaData, null, 2);
    await fsw.writeFile(metaPath + dir + '.json', userMetadataFile);
    getRoms(dir);
  };

  // Remove user linked metadata
  async function removeMeta(data) {
    await fsw.mkdir(metaPath, { recursive: true });
    let romSha = data[0];
    let dir = data[1];
    let file = data[2];
    let purge = data[3];
    let fileExtension = path.extname(file);
    let name = path.basename(file, fileExtension);
    if (fs.existsSync(metaPath + dir + '.json')) {
      var metaData = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      var metaData = JSON.parse(metaData);
    } else {
      var metaData = {};
    };
    if (metaData.hasOwnProperty(romSha)) {
      delete metaData[romSha];
      userMetadataFile = JSON.stringify(metaData, null, 2);
      await fsw.writeFile(metaPath + dir + '.json', userMetadataFile);
    }
    // Delete any downloaded or uploaded art
    for await (let variable of metaVariables) {
      let artFile = dataRoot + dir + '/' + variable[1] + '/' + name + variable[2];
      if (fs.existsSync(artFile)) {
        fs.unlinkSync(artFile); 
      }
    };
    let vidPosFile = dataRoot + dir + '/videos/' + name + '.position';
    if (fs.existsSync(vidPosFile)) {
      fs.unlinkSync(vidPosFile);
    }
    // Delete rom and sha if requested
    if (purge) {
      let romFile = dataRoot + dir + '/roms/' + file;
      let shaFile = dataRoot + 'hashes/' + dir + '/roms/' + file + '.sha1';
      for await (var delFile of [romFile, shaFile]) {
        if (fs.existsSync(delFile)) {
          fs.unlinkSync(delFile);
        }
      }
    }
    // Tell client to render
    getRoms(dir);
  };

  async function clearRomScan(data) {
    let dir = data[0];
    let file = data[1];
    let shaFile = hashPath + dir + '/roms/' + file + '.sha1';
    if (!fs.existsSync(shaFile)) {
      socket.emit('modaldata', 'No scan flag exists for ' + file);
      return;
    }
    await fsw.mkdir(hashPath + dir + '/rescan/', {recursive: true});
    await fsw.writeFile(rescanFlagPath(dir, file), '');
    socket.emit('scanflagcleared', {dir: dir, file: file});
  }

  // Get combined metadata
  async function getMeta(dir) {
    let metaDataRaw = await fsw.readFile('./metadata/' + dir + '.json', 'utf8');
    let metaData = JSON.parse(metaDataRaw);
    if (fs.existsSync(metaPath + dir + '.json')) {
      let userMetaDataRaw = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      let userMetaData = JSON.parse(userMetaDataRaw);
      metaData = merge(metaData, userMetaData);
    };
    return metaData;
  }
  
  // Render files page
  async function renderFiles() {
    var dirItems = await fsw.readdir(dataRoot);
    var dirs = [];
    for await (var item of dirItems) {
      if ((fs.lstatSync(dataRoot + item).isDirectory()) && (! /^\..*/.test(item))){
        dirs.push(item);
      };
    };
    socket.emit('renderfiledirs', dirs);
  };

  // Send profile data to client
  async function renderProfiles() {
    let profilesData = await fsw.readFile(home + '/profile/profile.json', 'utf8');
    let profilesJson = JSON.parse(profilesData);
    let profiles = [];
    if (Object.keys(profilesJson).length > 0) { 
      for await (let profile of Object.keys(profilesJson)) {
        profiles.push(profilesJson[profile].username)
      }
    }
    socket.emit('renderprofiles', profiles);
  }

  // Create a blank profile
  async function createProfile(data) {
    let user = data[0];
    let pass = data[1];
    if (!isValidUsername(user) || !pass || pass.length < 10) {
      return;
    }
    let auth = user + pass;
    // Create hash and store user in profile.json
    let hash = crypto.createHash('sha256').update(auth).digest('hex');
    let profilesJson = await readProfiles();
    if (Object.keys(profilesJson).some(function(profileHash) {
      return profilesJson[profileHash] && profilesJson[profileHash].username === user;
    })) {
      return;
    }
    profilesJson[hash] = {username: user, role: 'user'};
    let profileFile = JSON.stringify(profilesJson, null, 2);
    await fsw.writeFile(home + '/profile/profile.json', profileFile);
    // Make directory for user with default config
    await fsw.mkdir(path.join(home, 'profile', user));
    await fsw.writeFile(path.join(home, 'profile', user, 'retroarch.cfg'), retroArchCfg);
    // Tell client to render profiles
    let profiles = [];
    for await (let profile of Object.keys(profilesJson)) {
      profiles.push(profilesJson[profile].username)
    }
    socket.emit('renderprofiles', profiles);
  }

  // Delete a profile
  async function deleteProfile(user) {
    if (!isValidUsername(user)) {
      return;
    }
    let profilesJson = await readProfiles();
    let adminCount = Object.keys(profilesJson).filter(function(profileHash) {
      return roleFor(profilesJson[profileHash]) === 'admin';
    }).length;
    for await (let profile of Object.keys(profilesJson)) {
      if (profilesJson[profile].username == user) {
        if (roleFor(profilesJson[profile]) === 'admin' && adminCount <= 1) {
          return;
        }
        delete profilesJson[profile];
      }
    }
    let profileFile = JSON.stringify(profilesJson, null, 2);
    await fsw.writeFile(home + '/profile/profile.json', profileFile);
    if (user !== 'default') {
      await fsw.rm(path.join(home, 'profile', user), { recursive: true, force: true });
    }
    let profiles = [];
    for await (let profile of Object.keys(profilesJson)) {
      profiles.push(profilesJson[profile].username)
    }
    socket.emit('renderprofiles', profiles);
  }

  // Send individual rom data
  async function getRomData(data) {
    let dir = data[0];
    let file = data[1];
    let fileExtension = path.extname(file);
    let name = path.basename(file, fileExtension);
    // Create the preview json
    let rawConfig = await fsw.readFile(dataRoot + 'config/' + dir + '.json', 'utf8');
    let config = JSON.parse(rawConfig);
    let defaultVidPos = config.defaults.video_position;
    config.display_items = 1;
    config.items = {};
    config.items[name] = {};
    // Assemble metdata for client
    let romData = {};
    romData.file = file;
    let shaFile = hashPath + dir + '/roms/' + file + '.sha1';
    romData.scanFlag = fs.existsSync(shaFile);
    let hash = '';
    if (romData.scanFlag) {
      hash = await fsw.readFile(shaFile, 'utf8');
    }
    romData.hash = hash;
    let metaData = await getMeta(dir);
    if (hash && metaData.hasOwnProperty(hash)) {
      if (metaData[hash].hasOwnProperty('ref')) {
        romData.metadata = metaData[metaData[hash].ref];
        if (metaData[hash].hasOwnProperty('name')) {
          romData.metadata.name = metaData[hash].name;
        }
      } else {
        romData.metadata = metaData[hash];
      }
      if (metaData[hash].hasOwnProperty('video_position')) {
        romData.vidpos = true;
        romData.metadata.video_position = metaData[hash].video_position;
        config.items[name].video_position = metaData[hash].video_position;
      } else {
        romData.vidpos = false;
        romData.metadata.video_position = defaultVidPos;
        config.items[name].video_position = defaultVidPos;
      }
    } else {
      romData.metadata = false;
    }
    for await (let variable of metaVariables) {
      if (fs.existsSync(dataRoot + dir + '/' + variable[1] + '/' + name + variable[2])) {
        romData[variable[0]] = dir + '/' + variable[1] + '/' + name + variable[2];
        config.items[name]['has_' + variable[0].replace('vid','video')] = true;
      } else {
        romData[variable[0]] = false;
        config.items[name]['has_' + variable[0].replace('vid','video')] = false;
      }
    }
    // Write the preview config
    await fsw.writeFile(hashPath + 'preview.json', JSON.stringify(config, null, 2));
    // Send data to client
    socket.emit('romdata', romData);
  }

  // Process upload and add to custom user metadata
  async function uploadArt(data) {
    // Parse vars
    let fileType = data[0];
    let dir = data[1];
    let file = data[2];
    let hash = data[3];
    // Upload data to local ipfs node
    let fileData = Buffer.from(data[4]);
    let ipfsRes = await ipfs.add(fileData);
    let cid = ipfsRes.path;
    await ipfs.pin.add(cid);
    // Build and write custom metadata
    if (fs.existsSync(metaPath + dir + '.json')) {
      let rawMetaData = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      var metaData = JSON.parse(rawMetaData);
    } else {
      var metaData = {};
    }
    let metaUpdate = {};
    metaUpdate[hash] = {};
    metaUpdate[hash][fileType] = cid;
    metaData = merge(metaData, metaUpdate);
    await fsw.writeFile(metaPath + dir + '.json', JSON.stringify(metaData, null, 2));
    // Write actual file
    if (fileType == 'vid') {
      var extension = '.mp4';
      var filePath = '/videos/';
    } else if (fileType == 'back') {
      var extension = '.png';
      var filePath = '/backgrounds/';
    } else if (fileType == 'corner') {
      var extension = '.png';
      var filePath = '/corners/';
    } else if (fileType == 'logo') {
      var extension = '.png';
      var filePath = '/logos/';
    }
    let fileExtension = path.extname(file);
    let name = path.basename(file, fileExtension);
    if (! fs.existsSync(dataRoot + dir + filePath)) {
      await fsw.mkdir(dataRoot + dir + filePath);
    }
    await fsw.writeFile(dataRoot + dir + filePath + name + extension, fileData);
    // Render game for client
    getRomData([dir, file]);
  }

  // Update video position metadata for rom
  async function updateVidPosition(data) {
    let dir = data[0];
    let file = data[1];
    let hash = data[2];
    let position = data[3];
    // Build and write custom metadata
    if (fs.existsSync(metaPath + dir + '.json')) {
      let rawMetaData = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      var metaData = JSON.parse(rawMetaData);
    } else {
      var metaData = {};
    }
    let metaUpdate = {};
    metaUpdate[hash] = {};
    metaUpdate[hash].video_position = position;
    metaData = merge(metaData, metaUpdate);
    await fsw.writeFile(metaPath + dir + '.json', JSON.stringify(metaData, null, 2));
    getRomData([dir, file]);
  }

  // Create a custom metadata entry
  async function customMeta(data) {
    await fsw.mkdir(metaPath, { recursive: true });
    let romSha = data[0];
    let dir = data[1];
    let name = data[2];
    if (fs.existsSync(metaPath + dir + '.json')) {
      var metaData = await fsw.readFile(metaPath + dir + '.json', 'utf8');
      var metaData = JSON.parse(metaData);
    } else {
      var metaData = {};
    };
    metaData[romSha] = {};
    metaData[romSha].name = name;
    userMetadataFile = JSON.stringify(metaData, null, 2);
    await fsw.writeFile(metaPath + dir + '.json', userMetadataFile);
    getRoms(dir);
  }

  // Incoming socket requests
  if (socket.adminAuthenticated && existingSession) {
    socket.emit('adminauth', {status: 'success', user: existingSession.user, role: existingSession.role});
    await renderInitialAdminPage();
  }
  socket.on('adminauth', async function(data) {
    try {
      if (!consumeRateLimit(socketAdminAuthAttempts, socket.handshake.address || 'unknown', ADMIN_AUTH_LIMIT, RATE_LIMIT_WINDOW_MS)) {
        socket.emit('adminauth', {status: 'error'});
        return;
      }
      let profile = await authenticateProfile(data.user, data.pass);
      if (!profile || profile.role !== 'admin') {
        socket.emit('adminauth', {status: 'error'});
        return;
      }
      socket.adminAuthenticated = true;
      socket.emit('adminauth', {status: 'success', user: profile.username, role: profile.role});
      await renderInitialAdminPage();
    } catch(e) {
      console.log(e);
      socket.emit('adminauth', {status: 'error'});
    }
  });
  socket.on('renderconfigs', requireAdmin(renderConfigs));
  socket.on('renderroms', requireAdmin(renderRoms));
  socket.on('renderromsdir', requireAdmin(renderRomsDir));
  socket.on('getconfig', requireAdmin(getConfig));
  socket.on('getmeta', requireAdmin(getMetaJSON));
  socket.on('getroms', requireAdmin(getRoms));
  socket.on('saveconfig', requireAdmin(saveConfig));
  socket.on('dldefaultfiles', requireAdmin(dlDefaultFiles));
  socket.on('scanroms', requireAdmin(scanRoms));
  socket.on('addtoconfig', requireAdmin(addToConfig));
  socket.on('purgenoart', requireAdmin(purgeNoArt));
  socket.on('downloadart', requireAdmin(downloadArt));
  socket.on('usermeta', requireAdmin(userMeta));
  socket.on('renderfiles', requireAdmin(renderFiles));
  socket.on('renderprofiles', requireAdmin(renderProfiles));
  socket.on('renderlogs', requireAdmin(renderLogs));
  socket.on('savelogsettings', requireAdmin(saveLogSettings));
  socket.on('testlogsinflux', requireAdmin(testLogInflux));
  socket.on('createprofile', requireAdmin(createProfile));
  socket.on('deleteprofile', requireAdmin(deleteProfile));
  socket.on('getromdata', requireAdmin(getRomData));
  socket.on('uploadart', requireAdmin(uploadArt));
  socket.on('updatevidposition', requireAdmin(updateVidPosition));
  socket.on('removemeta', requireAdmin(removeMeta));
  socket.on('clearromscan', requireAdmin(clearRomScan));
  socket.on('custommeta', requireAdmin(customMeta));
  socket.on('rendermeta', requireAdmin(renderMeta));
});

// Cloudcmd File browser data
baserouter.use('/files', requireAdminHttp, cloudcmd({
  config: {
    root: dataRoot,
    prefix: baseUrl + 'files',
    terminal: false,
    console: false,
    configDialog: false,
    contact: false,
    auth: false,
    name: 'Files',
    log: false,
    keysPanel: false,
    oneFilePanel: true,
    zip: false
  }
}));

// Cloudcmd File browser profile
baserouter.use('/profile', requireAdminHttp, cloudcmd({
  config: {
    root: home + '/profile',
    prefix: baseUrl + 'profile',
    terminal: false,
    console: false,
    configDialog: false,
    contact: false,
    auth: false,
    name: 'Files',
    log: false,
    keysPanel: false,
    oneFilePanel: true,
    zip: false
  }
}));
