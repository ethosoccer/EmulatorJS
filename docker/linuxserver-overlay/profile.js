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
var favoritesProfileFile = '.emulatorjs-favorites.json';
var favoritesSyncProfileFile = '.emulatorjs-favorites-sync.json';
var dataRoot = fs.existsSync('/data') ? '/data/' : path.join(__dirname, 'frontend', 'user') + '/';
var authAttempts = new Map();
var forgotPasswordAttempts = new Map();
var RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
var AUTH_ATTEMPT_LIMIT = 20;
var FORGOT_PASSWORD_LIMIT = 5;
var USERNAME_REGEX = /^[A-Za-z0-9._-]{3,32}$/;
var geoLookupCache = new Map();
var GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
var nextcloudBackupJobs = new Map();
var nextcloudMirrorDeletePreviews = new Map();
var nextcloudBackupSeq = 1;
var MIN_ARCHIVE_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;
var ARCHIVE_MEMORY_SAFETY_RATIO = 0.75;
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
    influxToken: '',
    nextcloud: defaultNextcloudSettings()
  };
}

function defaultNextcloudSettings() {
  return {
    url: '',
    username: '',
    appPassword: '',
    mode: 'archive',
    archiveType: 'zip',
    retention: {
      mode: 'forever',
      value: 0
    },
    schedule: {
      type: 'manual',
      time: '03:00',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeZone: '',
      lastRunKey: ''
    },
    mirrorDelete: false,
    scopes: {
      roms: {enabled: false, remotePath: ''},
      artwork: {enabled: false, remotePath: ''},
      videos: {enabled: false, remotePath: ''},
      emulatorConfig: {enabled: false, remotePath: ''},
      profiles: {enabled: false, remotePath: ''},
      activity: {enabled: false, remotePath: ''},
      fullData: {enabled: false, remotePath: ''}
    },
    lastStatus: {
      status: 'idle',
      message: ''
    }
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

function sanitizeNextcloudPath(value) {
  let clean = String(value || '').trim().replace(/\\/g, '/');
  clean = clean.replace(/\/+/g, '/');
  if (clean && clean[0] !== '/') {
    clean = '/' + clean;
  }
  return clean;
}

function normalizeNextcloudSchedule(schedule) {
  let raw = schedule && typeof schedule === 'object' ? schedule : {};
  let type = ['manual', 'daily', 'weekly', 'monthly'].includes(raw.type) ? raw.type : 'manual';
  let time = /^\d{2}:\d{2}$/.test(String(raw.time || '')) ? raw.time : '03:00';
  let dayOfWeek = Math.max(0, Math.min(Number(raw.dayOfWeek || 0), 6));
  let dayOfMonth = Math.max(1, Math.min(Number(raw.dayOfMonth || 1), 31));
  return {
    type: type,
    time: time,
    dayOfWeek: dayOfWeek,
    dayOfMonth: dayOfMonth,
    timeZone: String(raw.timeZone || '').trim().slice(0, 80),
    lastRunKey: String(raw.lastRunKey || '').trim().slice(0, 120)
  };
}

function normalizeNextcloudSettings(input, existing) {
  let defaults = defaultNextcloudSettings();
  let previous = Object.assign({}, defaults, existing || {});
  let raw = input && typeof input === 'object' ? input : {};
  let scopes = {};
  Object.keys(defaults.scopes).forEach(function(scopeId) {
    let source = raw.scopes && raw.scopes[scopeId] || previous.scopes && previous.scopes[scopeId] || {};
    scopes[scopeId] = {
      enabled: source.enabled === true,
      remotePath: sanitizeNextcloudPath(source.remotePath)
    };
  });
  let retentionMode = raw.retention && ['forever', 'count', 'days'].includes(raw.retention.mode) ? raw.retention.mode : previous.retention.mode || 'forever';
  let retentionValue = Math.max(0, Math.min(parseInt(raw.retention && raw.retention.value || 0, 10) || 0, 3650));
  let appPassword = previous.appPassword || '';
  if (raw.clearAppPassword === true) {
    appPassword = '';
  } else if (typeof raw.appPassword === 'string' && raw.appPassword.trim()) {
    appPassword = raw.appPassword.trim();
  }
  let normalizedSchedule = normalizeNextcloudSchedule(raw.schedule || previous.schedule);
  if (raw.schedule && !raw.schedule.lastRunKey && previous.schedule && previous.schedule.lastRunKey) {
    let previousSchedule = normalizeNextcloudSchedule(previous.schedule);
    let comparableNow = [normalizedSchedule.type, normalizedSchedule.time, normalizedSchedule.dayOfWeek, normalizedSchedule.dayOfMonth, normalizedSchedule.timeZone].join('|');
    let comparablePrev = [previousSchedule.type, previousSchedule.time, previousSchedule.dayOfWeek, previousSchedule.dayOfMonth, previousSchedule.timeZone].join('|');
    if (comparableNow === comparablePrev) {
      normalizedSchedule.lastRunKey = previousSchedule.lastRunKey;
    }
  }
  return {
    url: String(raw.url || '').trim().replace(/\/+$/, ''),
    username: String(raw.username || '').trim(),
    appPassword: appPassword,
    mode: ['archive', 'mirror', 'both'].includes(raw.mode) ? raw.mode : 'archive',
    archiveType: 'zip',
    retention: {
      mode: retentionMode,
      value: retentionValue
    },
    schedule: normalizedSchedule,
    mirrorDelete: raw.mirrorDelete === true,
    scopes: scopes,
    lastStatus: previous.lastStatus || defaults.lastStatus
  };
}

function publicNextcloudSettings(settings) {
  let nextcloud = normalizeNextcloudSettings(settings && settings.nextcloud || {}, settings && settings.nextcloud || {});
  delete nextcloud.appPassword;
  nextcloud.appPasswordConfigured = !!(settings && settings.nextcloud && settings.nextcloud.appPassword);
  nextcloud.nextRun = describeNextcloudNextRun(nextcloud.schedule);
  return nextcloud;
}

function timezoneParts(date, timeZone) {
  let formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  let parts = {};
  formatter.formatToParts(date).forEach(function(part) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  });
  let hour = Number(parts.hour || 0);
  if (hour === 24) {
    hour = 0;
  }
  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 1),
    day: Number(parts.day || 1),
    hour: hour,
    minute: Number(parts.minute || 0)
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateKey(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function scheduleTimeParts(schedule) {
  let bits = String(schedule && schedule.time || '03:00').split(':');
  return {
    hour: Number(bits[0] || 3),
    minute: Number(bits[1] || 0)
  };
}

function scheduleDueInfo(schedule, now) {
  schedule = normalizeNextcloudSchedule(schedule);
  if (schedule.type === 'manual') {
    return {due: false, key: '', localParts: null};
  }
  let local = timezoneParts(now || new Date(), schedule.timeZone);
  let target = scheduleTimeParts(schedule);
  if (local.hour !== target.hour || local.minute !== target.minute) {
    return {due: false, key: '', localParts: local};
  }
  if (schedule.type === 'weekly') {
    let dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    if (dayOfWeek !== Number(schedule.dayOfWeek || 0)) {
      return {due: false, key: '', localParts: local};
    }
  }
  if (schedule.type === 'monthly') {
    let targetDay = Math.min(Number(schedule.dayOfMonth || 1), daysInMonth(local.year, local.month));
    if (local.day !== targetDay) {
      return {due: false, key: '', localParts: local};
    }
  }
  let key = [schedule.type, dateKey(local), schedule.time, schedule.timeZone || 'server'].join('|');
  return {
    due: schedule.lastRunKey !== key,
    key: key,
    localParts: local
  };
}

function describeNextcloudNextRun(schedule) {
  schedule = normalizeNextcloudSchedule(schedule);
  if (schedule.type === 'manual') {
    return {enabled: false, label: 'Manual only'};
  }
  let typeLabel = schedule.type.charAt(0).toUpperCase() + schedule.type.slice(1);
  let label = typeLabel + ' at ' + schedule.time;
  if (schedule.type === 'weekly') {
    label += ' on ' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(schedule.dayOfWeek || 0)];
  }
  if (schedule.type === 'monthly') {
    label += ' on day ' + Number(schedule.dayOfMonth || 1) + ' (last day fallback)';
  }
  if (schedule.timeZone) {
    label += ' ' + schedule.timeZone;
  }
  return {enabled: true, label: label};
}

function nextcloudDavUrl(settings, remotePath) {
  let parsed = new URL(settings.url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Nextcloud URL must start with http:// or https://.');
  }
  let pathParts = sanitizeNextcloudPath(remotePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  let base = parsed.pathname.replace(/\/+$/, '') + '/remote.php/dav/files/' + encodeURIComponent(settings.username) + '/';
  parsed.pathname = base + pathParts;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function nextcloudRequest(settings, method, remotePath, body, options) {
  return new Promise(function(resolve) {
    options = options || {};
    let parsed;
    try {
      parsed = nextcloudDavUrl(settings, remotePath);
    } catch(e) {
      resolve({ok: false, statusCode: 0, message: 'Invalid Nextcloud URL.'});
      return;
    }
    let transport = parsed.protocol === 'https:' ? https : http;
    let payload = body || '';
    let headers = {
      Authorization: 'Basic ' + Buffer.from(settings.username + ':' + settings.appPassword).toString('base64'),
      'User-Agent': 'EmulatorJS-Nextcloud-Backup',
      Depth: options.depth || '0'
    };
    if (options.contentType) {
      headers['Content-Type'] = options.contentType;
    }
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    let req = transport.request({
      method: method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: headers,
      timeout: 15000
    }, function(res) {
      let chunks = [];
      res.on('data', function(chunk) {
        chunks.push(chunk);
      });
      res.on('end', function() {
        let responseBuffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300 || res.statusCode === 207,
          statusCode: res.statusCode,
          body: options.responseType === 'buffer' ? responseBuffer : responseBuffer.toString('utf8')
        });
      });
    });
    req.on('timeout', function() {
      req.destroy(new Error('Nextcloud request timed out.'));
    });
    req.on('error', function(e) {
      resolve({ok: false, statusCode: 0, message: e.message});
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function testNextcloudSettings(settings) {
  if (!settings.url || !settings.username || !settings.appPassword) {
    return {status: 'error', message: 'Nextcloud URL, username, and app password are required.'};
  }
  let response = await nextcloudRequest(settings, 'PROPFIND', '/', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', {contentType: 'application/xml'});
  if (!response.ok) {
    let detail = response.statusCode ? 'WebDAV returned HTTP ' + response.statusCode + '.' : response.message || 'No response from Nextcloud.';
    return {status: 'error', message: detail};
  }
  return {status: 'success', message: 'Nextcloud WebDAV connection succeeded.'};
}

async function ensureNextcloudFolder(settings, remotePath) {
  let clean = sanitizeNextcloudPath(remotePath);
  if (!clean || clean === '/') {
    return;
  }
  let current = '';
  let parts = clean.split('/').filter(Boolean);
  for await (let part of parts) {
    current += '/' + part;
    let response = await nextcloudRequest(settings, 'MKCOL', current);
    if (![200, 201, 204, 301, 405].includes(response.statusCode)) {
      throw new Error('Unable to create Nextcloud folder ' + current + ' (HTTP ' + (response.statusCode || '0') + ').');
    }
  }
}

async function putNextcloudFile(settings, remotePath, content, contentType) {
  let clean = sanitizeNextcloudPath(remotePath);
  await ensureNextcloudFolder(settings, path.posix.dirname(clean));
  let response = await nextcloudRequest(settings, 'PUT', clean, content, {contentType: contentType || 'application/octet-stream'});
  if (!response.ok) {
    throw new Error('Unable to upload ' + clean + ' (HTTP ' + (response.statusCode || '0') + ').');
  }
}

async function getNextcloudFile(settings, remotePath) {
  let clean = sanitizeNextcloudPath(remotePath);
  let response = await nextcloudRequest(settings, 'GET', clean, '', {responseType: 'buffer'});
  if (!response.ok) {
    throw new Error('Unable to download ' + clean + ' (HTTP ' + (response.statusCode || '0') + ').');
  }
  return response.body;
}

function backupTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', 'Z');
}

function selectedNextcloudScopes(settings) {
  let scopes = settings.scopes || {};
  return Object.keys(scopes).filter(function(scopeId) {
    return scopes[scopeId] && scopes[scopeId].enabled === true;
  });
}

function assertSupportedNextcloudScopes(settings) {
  let selected = selectedNextcloudScopes(settings);
  if (selected.length === 0) {
    throw new Error('Select at least one backup scope.');
  }
  selected.forEach(function(scopeId) {
    if (!settings.scopes[scopeId].remotePath) {
      throw new Error('Enter a Nextcloud destination folder for the ' + scopeId + ' scope.');
    }
  });
}

function backupFileRecord(fullPath, relPath, stat, readContent) {
  return {
    fullPath: fullPath || '',
    relPath: String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, ''),
    stat: stat || {size: 0},
    readContent: readContent || null
  };
}

async function readBackupFileContent(file) {
  if (typeof file.readContent === 'function') {
    return await file.readContent();
  }
  return await fsw.readFile(file.fullPath);
}

async function collectProfileBackupFiles() {
  let files = await collectFiles(path.join(home, 'profile'), '', []);
  return files.filter(function(file) {
    let rel = String(file.relPath || '').replace(/\\/g, '/');
    return rel !== 'settings.json' && rel !== 'activity.db' && rel !== 'scan-history.jsonl';
  });
}

async function topLevelDataDirs() {
  if (!fs.existsSync(dataRoot)) {
    return [];
  }
  let items = await fsw.readdir(dataRoot);
  let dirs = [];
  for await (let item of items) {
    if (/^\./.test(item)) {
      continue;
    }
    let fullPath = path.join(dataRoot, item);
    try {
      let stat = await fsw.stat(fullPath);
      if (stat.isDirectory()) {
        dirs.push(item);
      }
    } catch(e) {}
  }
  return dirs;
}

async function collectExistingRoots(roots) {
  let files = [];
  for await (let root of roots) {
    if (!root || !fs.existsSync(root.fullPath)) {
      continue;
    }
    let stat = await fsw.stat(root.fullPath);
    if (stat.isDirectory()) {
      await collectFiles(root.fullPath, root.relRoot || '', files);
    } else {
      files.push(backupFileRecord(root.fullPath, root.relRoot || path.basename(root.fullPath), stat));
    }
  }
  return files.map(function(file) {
    return backupFileRecord(file.fullPath, file.relPath, file.stat, file.readContent);
  });
}

async function collectRomsBackupFiles() {
  let roots = [];
  let dirs = await topLevelDataDirs();
  dirs.forEach(function(dir) {
    roots.push({fullPath: path.join(dataRoot, dir, 'roms'), relRoot: path.posix.join(dir, 'roms')});
  });
  return await collectExistingRoots(roots);
}

async function collectArtworkBackupFiles() {
  let roots = [];
  let dirs = await topLevelDataDirs();
  dirs.forEach(function(dir) {
    ['logos', 'backgrounds', 'corners'].forEach(function(kind) {
      roots.push({fullPath: path.join(dataRoot, dir, kind), relRoot: path.posix.join(dir, kind)});
    });
  });
  return await collectExistingRoots(roots);
}

async function collectVideosBackupFiles() {
  let roots = [];
  let dirs = await topLevelDataDirs();
  dirs.forEach(function(dir) {
    roots.push({fullPath: path.join(dataRoot, dir, 'videos'), relRoot: path.posix.join(dir, 'videos')});
  });
  return await collectExistingRoots(roots);
}

async function collectEmulatorConfigBackupFiles() {
  return await collectExistingRoots([
    {fullPath: path.join(dataRoot, 'config'), relRoot: 'config'},
    {fullPath: path.join(dataRoot, 'metadata'), relRoot: 'metadata'},
    {fullPath: path.join(dataRoot, 'hashes'), relRoot: 'hashes'}
  ]);
}

function redactedSettingsContent(settings) {
  let clone = JSON.parse(JSON.stringify(settings || {}));
  if (clone.passwordResetWebhook) {
    clone.passwordResetWebhook = '[redacted]';
  }
  if (clone.influxToken) {
    clone.influxToken = '[redacted]';
  }
  if (clone.nextcloud && clone.nextcloud.appPassword) {
    clone.nextcloud.appPassword = '[redacted]';
  }
  return Buffer.from(JSON.stringify(clone, null, 2));
}

async function collectActivityBackupFiles() {
  let roots = [];
  let profileRoot = path.join(home, 'profile');
  [
    'activity.db',
    'scan-history.jsonl'
  ].forEach(function(fileName) {
    roots.push({fullPath: path.join(profileRoot, fileName), relRoot: fileName});
  });
  let files = await collectExistingRoots(roots);
  let settings = await readSettings();
  files.push(backupFileRecord('', 'settings.redacted.json', {size: Buffer.byteLength(JSON.stringify(settings || {}))}, async function() {
    return redactedSettingsContent(settings);
  }));
  return files;
}

async function collectFullDataBackupFiles() {
  let files = await collectFiles(dataRoot, '', []);
  return files.filter(function(file) {
    let rel = String(file.relPath || '').replace(/\\/g, '/');
    return rel !== '.ipfs' && rel.indexOf('.ipfs/') !== 0;
  }).map(function(file) {
    return backupFileRecord(file.fullPath, file.relPath, file.stat, file.readContent);
  });
}

async function collectNextcloudScopeFiles(scopeId) {
  if (scopeId === 'profiles') {
    return await collectProfileBackupFiles();
  }
  if (scopeId === 'roms') {
    return await collectRomsBackupFiles();
  }
  if (scopeId === 'artwork') {
    return await collectArtworkBackupFiles();
  }
  if (scopeId === 'videos') {
    return await collectVideosBackupFiles();
  }
  if (scopeId === 'emulatorConfig') {
    return await collectEmulatorConfigBackupFiles();
  }
  if (scopeId === 'activity') {
    return await collectActivityBackupFiles();
  }
  if (scopeId === 'fullData') {
    return await collectFullDataBackupFiles();
  }
  throw new Error('Unsupported backup scope: ' + scopeId);
}

function scopeArchivePrefix(scopeId) {
  return 'emulatorjs-' + scopeId.replace(/[A-Z]/g, function(match) {
    return '-' + match.toLowerCase();
  }) + '-';
}

async function buildScopeArchive(files) {
  let zip = new JSZip();
  for await (let file of files) {
    zip.file(file.relPath, await readBackupFileContent(file));
  }
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {level: 6}
  });
}

function formatBytes(bytes) {
  let value = Number(bytes || 0);
  let units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value = value / 1024;
    index++;
  }
  return (index === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[index];
}

function parseMemoryLimitValue(value) {
  let clean = String(value || '').trim();
  if (!clean || clean === 'max') {
    return 0;
  }
  let parsed = Number(clean);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return parsed;
}

function parseMemoryLimitText(value) {
  let text = String(value || '');
  let meminfoMatch = text.match(/^MemTotal:\s+(\d+)\s+kB/im);
  if (meminfoMatch) {
    return Number(meminfoMatch[1]) * 1024;
  }
  return parseMemoryLimitValue(text);
}

async function readFirstMemoryLimit(paths) {
  for await (let filePath of paths) {
    try {
      let parsed = parseMemoryLimitText(await fsw.readFile(filePath, 'utf8'));
      if (parsed > 0) {
        return parsed;
      }
    } catch(e) {}
  }
  return 0;
}

async function configuredMemoryLimitBytes() {
  let overrideLimit = parseMemoryLimitValue(process.env.NEXTCLOUD_ARCHIVE_MEMORY_LIMIT_BYTES || '');
  if (overrideLimit > 0) {
    return overrideLimit;
  }
  let limitFile = String(process.env.NEXTCLOUD_ARCHIVE_MEMORY_LIMIT_FILE || '').trim();
  if (limitFile) {
    try {
      return parseMemoryLimitText(await fsw.readFile(limitFile, 'utf8'));
    } catch(e) {}
  }
  return 0;
}

async function containerMemoryLimitBytes() {
  let cgroupLimit = await readFirstMemoryLimit([
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes'
  ]);
  if (cgroupLimit > 0 && cgroupLimit < 9000000000000000) {
    return cgroupLimit;
  }
  try {
    let meminfo = await fsw.readFile('/proc/meminfo', 'utf8');
    let match = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/im);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch(e) {}
  return 0;
}

async function archiveMemoryBudgetBytes() {
  let overrideBudget = parseMemoryLimitValue(process.env.NEXTCLOUD_ARCHIVE_BUDGET_BYTES || '');
  let limit = await configuredMemoryLimitBytes() || await containerMemoryLimitBytes();
  if (!limit || limit < MIN_ARCHIVE_MEMORY_LIMIT_BYTES) {
    return {
      limitBytes: limit || 0,
      budgetBytes: 0
    };
  }
  return {
    limitBytes: limit,
    budgetBytes: overrideBudget || Math.floor(limit * ARCHIVE_MEMORY_SAFETY_RATIO)
  };
}

function totalBackupFileBytes(files) {
  return (files || []).reduce(function(total, file) {
    return total + Number(file && file.stat && file.stat.size || 0);
  }, 0);
}

function skippedArchiveRecord(scopeId, files, totalBytes, budget, reason) {
  let limitLabel = budget.limitBytes ? formatBytes(budget.limitBytes) : 'unknown';
  let budgetLabel = budget.budgetBytes ? formatBytes(budget.budgetBytes) : 'unknown';
  return {
    scope: scopeId,
    filesConsidered: files.length,
    bytesConsidered: totalBytes,
    memoryLimitBytes: budget.limitBytes || 0,
    archiveBudgetBytes: budget.budgetBytes || 0,
    archiveBytesReserved: budget.archiveBytesReserved || 0,
    reason: reason || 'Archive scope ' + scopeId + ' is ' + formatBytes(totalBytes) + ', above the safe in-memory ZIP budget of ' + budgetLabel + ' for container RAM ' + limitLabel + '.'
  };
}

async function skipNextcloudArchiveScope(scopeId, files, totalBytes, budget, summary, job, reason) {
  let skipped = skippedArchiveRecord(scopeId, files, totalBytes, budget, reason);
  summary.skippedArchives += 1;
  summary.archiveSkipDetails.push(skipped);
  summary.scopeDetails[scopeId].archiveSkipped = true;
  summary.scopeDetails[scopeId].archiveSkipReason = skipped.reason;
  console.log('Nextcloud archive skipped:', skipped.reason);
  if (job) {
    updateNextcloudJob(job, {
      message: skipped.reason,
      summary: summary,
      progress: Math.max(job.progress || 0, 10)
    });
    await persistNextcloudJobStatus(job);
    await emitBackupActivity(job, 'backup_archive_skipped', 'warning', {
      reason: skipped.reason,
      backup: Object.assign(backupActivityPayload(job, 'backup_archive_skipped', 'warning').backup, {
        skippedArchive: skipped,
        summary: summary
      })
    });
  }
}

async function listNextcloudArchiveFiles(settings, remoteFolder, prefix) {
  let response = await nextcloudRequest(
    settings,
    'PROPFIND',
    remoteFolder,
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>',
    {depth: '1', contentType: 'application/xml'}
  );
  if (!response.ok) {
    return [];
  }
  let entries = [];
  let hrefMatches = response.body.match(/<d:href>[^<]+<\/d:href>|<D:href>[^<]+<\/D:href>/g) || [];
  hrefMatches.forEach(function(tag) {
    let href = tag.replace(/<\/?[A-Za-z]:href>/g, '');
    let decoded = '';
    try {
      decoded = decodeURIComponent(href);
    } catch(e) {
      decoded = href;
    }
    let name = decoded.split('/').filter(Boolean).pop() || '';
    if (name.indexOf(prefix) === 0 && /\.zip$/i.test(name)) {
      entries.push({name: name, remotePath: path.posix.join(sanitizeNextcloudPath(remoteFolder), name)});
    }
  });
  return entries.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
}

function parseNextcloudPropfindResponses(body, baseFolder) {
  let responses = String(body || '').match(/<[A-Za-z]:response[\s\S]*?<\/[A-Za-z]:response>/g) || [];
  let base = sanitizeNextcloudPath(baseFolder || '').replace(/\/+$/, '');
  let entries = [];
  responses.forEach(function(block) {
    let hrefMatch = block.match(/<[A-Za-z]:href>([\s\S]*?)<\/[A-Za-z]:href>/);
    if (!hrefMatch) {
      return;
    }
    let decoded = '';
    try {
      decoded = decodeURIComponent(hrefMatch[1]);
    } catch(e) {
      decoded = hrefMatch[1];
    }
    let marker = '/remote.php/dav/files/';
    let markerIndex = decoded.indexOf(marker);
    if (markerIndex >= 0) {
      let afterMarker = decoded.slice(markerIndex + marker.length).split('/').slice(1).join('/');
      decoded = '/' + afterMarker;
    }
    decoded = sanitizeNextcloudPath(decoded);
    if (decoded === base || decoded === base + '/') {
      return;
    }
    let relPath = decoded.indexOf(base + '/') === 0 ? decoded.slice(base.length + 1) : decoded.replace(/^\/+/, '');
    if (!relPath) {
      return;
    }
    entries.push({
      name: relPath.split('/').filter(Boolean).pop() || relPath,
      relPath: relPath.replace(/\/+$/, ''),
      remotePath: decoded.replace(/\/+$/, ''),
      isDirectory: /<[A-Za-z]:collection\s*\/>/.test(block) || /<[A-Za-z]:collection>/.test(block)
    });
  });
  return entries;
}

async function listNextcloudFolderEntries(settings, remoteFolder) {
  let response = await nextcloudRequest(
    settings,
    'PROPFIND',
    remoteFolder,
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    {depth: '1', contentType: 'application/xml'}
  );
  if (!response.ok) {
    return [];
  }
  return parseNextcloudPropfindResponses(response.body, remoteFolder);
}

async function listNextcloudMirrorFiles(settings, remoteFolder, relativeRoot, into, limit) {
  into = into || [];
  limit = limit || 20000;
  if (into.length >= limit) {
    return into;
  }
  let entries = await listNextcloudFolderEntries(settings, remoteFolder);
  for await (let entry of entries) {
    if (into.length >= limit) {
      break;
    }
    let relPath = relativeRoot ? path.posix.join(relativeRoot, entry.name) : entry.name;
    if (entry.isDirectory) {
      await listNextcloudMirrorFiles(settings, entry.remotePath, relPath, into, limit);
    } else {
      into.push({
        relPath: relPath,
        remotePath: entry.remotePath,
        name: entry.name
      });
    }
  }
  return into;
}

function isProtectedMirrorRemoteFile(scopeId, relPath) {
  let normalized = String(relPath || '').replace(/\\/g, '/');
  return normalized.indexOf('/') < 0 && normalized.indexOf(scopeArchivePrefix(scopeId)) === 0 && /\.zip$/i.test(normalized);
}

async function previewScopeMirrorDelete(settings, scopeId, files) {
  let remoteFolder = settings.scopes[scopeId].remotePath;
  let localPaths = new Set(files.map(function(file) {
    return String(file.relPath || '').replace(/\\/g, '/');
  }));
  let remoteFiles = await listNextcloudMirrorFiles(settings, remoteFolder, '', [], 20000);
  return remoteFiles.filter(function(file) {
    return !localPaths.has(file.relPath) && !isProtectedMirrorRemoteFile(scopeId, file.relPath);
  });
}

function cleanupMirrorDeletePreviews() {
  let cutoff = Date.now() - 30 * 60 * 1000;
  Array.from(nextcloudMirrorDeletePreviews.entries()).forEach(function(entry) {
    if (!entry[1] || entry[1].createdAt < cutoff) {
      nextcloudMirrorDeletePreviews.delete(entry[0]);
    }
  });
}

function mirrorDeletePreviewKey(settings) {
  let scopes = {};
  selectedNextcloudScopes(settings).forEach(function(scopeId) {
    scopes[scopeId] = settings.scopes[scopeId] && settings.scopes[scopeId].remotePath || '';
  });
  return crypto.createHash('sha256').update(JSON.stringify({
    url: settings.url || '',
    username: settings.username || '',
    scopes: scopes
  })).digest('hex');
}

async function previewNextcloudMirrorDelete(settings) {
  let test = await testNextcloudSettings(settings);
  if (test.status !== 'success') {
    throw new Error(test.message || 'Nextcloud connection failed.');
  }
  assertSupportedNextcloudScopes(settings);
  let selectedScopes = selectedNextcloudScopes(settings);
  let preview = {
    id: 'mirror-delete-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    createdAt: Date.now(),
    key: mirrorDeletePreviewKey(settings),
    scopes: selectedScopes,
    totalExtras: 0,
    extras: {},
    truncated: false
  };
  for await (let scopeId of selectedScopes) {
    let files = await collectNextcloudScopeFiles(scopeId);
    let extras = await previewScopeMirrorDelete(settings, scopeId, files);
    preview.extras[scopeId] = extras.slice(0, 500);
    preview.totalExtras += extras.length;
    if (extras.length > preview.extras[scopeId].length) {
      preview.truncated = true;
    }
  }
  cleanupMirrorDeletePreviews();
  nextcloudMirrorDeletePreviews.set(preview.id, preview);
  return preview;
}

async function applyNextcloudArchiveRetention(settings, remoteFolder, prefix) {
  let retention = settings.retention || {};
  if (retention.mode === 'forever') {
    return {deleted: 0};
  }
  let files = await listNextcloudArchiveFiles(settings, remoteFolder, prefix);
  let deleteList = [];
  if (retention.mode === 'count') {
    let keep = Math.max(1, parseInt(retention.value || 1, 10) || 1);
    deleteList = files.slice(0, Math.max(files.length - keep, 0));
  } else if (retention.mode === 'days') {
    let days = Math.max(1, parseInt(retention.value || 1, 10) || 1);
    let cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    deleteList = files.filter(function(file) {
      let match = file.name.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
      if (!match) {
        return false;
      }
      let parsed = Date.parse(match[1] + 'T' + match[2].replace(/-/g, ':') + 'Z');
      return parsed && parsed < cutoff;
    });
  }
  let deleted = 0;
  for await (let file of deleteList) {
    let response = await nextcloudRequest(settings, 'DELETE', file.remotePath);
    if (response.ok || response.statusCode === 404) {
      deleted++;
    }
  }
  return {deleted: deleted};
}

function assertNextcloudJobNotCanceled(job) {
  if (job && job.cancelRequested) {
    let label = job.kind === 'restore' ? 'restore' : 'backup';
    let error = new Error('Nextcloud ' + label + ' was canceled.');
    error.code = 'NEXTCLOUD_BACKUP_CANCELED';
    throw error;
  }
}

async function runScopeArchiveBackup(settings, scopeId, files, summary, job) {
  assertNextcloudJobNotCanceled(job);
  let remoteFolder = settings.scopes[scopeId].remotePath;
  await ensureNextcloudFolder(settings, remoteFolder);
  let prefix = scopeArchivePrefix(scopeId);
  let archiveName = prefix + backupTimestampLabel() + '.zip';
  assertNextcloudJobNotCanceled(job);
  let totalBytes = totalBackupFileBytes(files);
  let budget = summary.archiveBudget || await archiveMemoryBudgetBytes();
  budget.archiveBytesReserved = summary.archiveBytesReserved || 0;
  if (!budget.budgetBytes || totalBytes > budget.budgetBytes) {
    await skipNextcloudArchiveScope(scopeId, files, totalBytes, budget, summary, job);
    return;
  }
  if ((summary.archiveBytesReserved || 0) + totalBytes > budget.budgetBytes) {
    let reason = 'Archive scope ' + scopeId + ' is ' + formatBytes(totalBytes) + ', and selected archive scopes would reserve ' + formatBytes((summary.archiveBytesReserved || 0) + totalBytes) + ' against the safe in-memory ZIP budget of ' + formatBytes(budget.budgetBytes) + '.';
    await skipNextcloudArchiveScope(scopeId, files, totalBytes, budget, summary, job, reason);
    return;
  }
  summary.archiveBytesReserved += totalBytes;
  summary.scopeDetails[scopeId].archiveBytesReserved = totalBytes;
  let buffer = await buildScopeArchive(files);
  assertNextcloudJobNotCanceled(job);
  await putNextcloudFile(settings, path.posix.join(remoteFolder, archiveName), buffer, 'application/zip');
  assertNextcloudJobNotCanceled(job);
  summary.archivesUploaded += 1;
  summary.bytesUploaded += buffer.length;
  summary.archiveFiles.push(path.posix.join(remoteFolder, archiveName));
  summary.scopeDetails[scopeId].archivesUploaded += 1;
  summary.scopeDetails[scopeId].bytesUploaded += buffer.length;
  summary.scopeDetails[scopeId].archiveFiles.push(path.posix.join(remoteFolder, archiveName));
  let retention = await applyNextcloudArchiveRetention(settings, remoteFolder, prefix);
  assertNextcloudJobNotCanceled(job);
  summary.retentionDeleted += retention.deleted;
  summary.scopeDetails[scopeId].retentionDeleted += retention.deleted;
}

async function runScopeMirrorBackup(settings, scopeId, files, summary, job) {
  let remoteFolder = settings.scopes[scopeId].remotePath;
  await ensureNextcloudFolder(settings, remoteFolder);
  for await (let file of files) {
    assertNextcloudJobNotCanceled(job);
    let content = await readBackupFileContent(file);
    assertNextcloudJobNotCanceled(job);
    await putNextcloudFile(settings, path.posix.join(remoteFolder, file.relPath), content, 'application/octet-stream');
    assertNextcloudJobNotCanceled(job);
    summary.filesUploaded += 1;
    summary.bytesUploaded += content.length;
    summary.scopeDetails[scopeId].filesUploaded += 1;
    summary.scopeDetails[scopeId].bytesUploaded += content.length;
  }
  if (settings.mirrorDelete === true && job && job.mirrorDeletePreview && job.mirrorDeletePreview.extras) {
    let extras = job.mirrorDeletePreview.extras[scopeId] || [];
    for await (let extra of extras) {
      assertNextcloudJobNotCanceled(job);
      let response = await nextcloudRequest(settings, 'DELETE', extra.remotePath);
      if (response.ok || response.statusCode === 404) {
        summary.remoteExtrasDeleted += 1;
        summary.scopeDetails[scopeId].remoteExtrasDeleted += 1;
      }
    }
  }
}

async function runNextcloudBackup(settings, job) {
  assertNextcloudJobNotCanceled(job);
  let test = await testNextcloudSettings(settings);
  if (test.status !== 'success') {
    throw new Error(test.message || 'Nextcloud connection failed.');
  }
  assertNextcloudJobNotCanceled(job);
  assertSupportedNextcloudScopes(settings);
  let selectedScopes = selectedNextcloudScopes(settings);
  let archiveBudget = settings.mode === 'archive' || settings.mode === 'both' ? await archiveMemoryBudgetBytes() : {limitBytes: 0, budgetBytes: 0};
  let summary = {
    mode: settings.mode,
    scopes: selectedScopes,
    filesConsidered: 0,
    filesUploaded: 0,
    archivesUploaded: 0,
    bytesUploaded: 0,
    retentionDeleted: 0,
    remoteExtrasDeleted: 0,
    skippedArchives: 0,
    archiveSkipDetails: [],
    archiveBudget: archiveBudget,
    archiveBytesReserved: 0,
    mirrorDeletePreviewId: job && job.mirrorDeletePreview ? job.mirrorDeletePreview.id : '',
    archiveFiles: [],
    scopeDetails: {}
  };
  for await (let scopeId of selectedScopes) {
    assertNextcloudJobNotCanceled(job);
    let files = await collectNextcloudScopeFiles(scopeId);
    assertNextcloudJobNotCanceled(job);
    summary.filesConsidered += files.length;
    summary.scopeDetails[scopeId] = {
      filesConsidered: files.length,
      filesUploaded: 0,
      archivesUploaded: 0,
      bytesUploaded: 0,
      retentionDeleted: 0,
      remoteExtrasDeleted: 0,
      archiveSkipped: false,
      archiveSkipReason: '',
      archiveBytesReserved: 0,
      archiveFiles: []
    };
    if (settings.mode === 'archive' || settings.mode === 'both') {
      await runScopeArchiveBackup(settings, scopeId, files, summary, job);
    }
    if (settings.mode === 'mirror' || settings.mode === 'both') {
      await runScopeMirrorBackup(settings, scopeId, files, summary, job);
    }
  }
  return summary;
}

function assertSafeNextcloudArchivePath(settings, scopeId, remotePath) {
  let scope = settings.scopes && settings.scopes[scopeId] || {};
  let remoteFolder = sanitizeNextcloudPath(scope.remotePath || '');
  let clean = sanitizeNextcloudPath(remotePath || '');
  let folderWithSlash = remoteFolder.replace(/\/+$/, '') + '/';
  if (!remoteFolder || (clean !== remoteFolder && clean.indexOf(folderWithSlash) !== 0)) {
    throw new Error('Selected archive is outside the configured Nextcloud folder.');
  }
  let archiveName = clean.split('/').filter(Boolean).pop() || '';
  if (archiveName.indexOf(scopeArchivePrefix(scopeId)) !== 0 || !/\.zip$/i.test(archiveName)) {
    throw new Error('Selected file does not look like a ' + scopeId + ' archive.');
  }
  return clean;
}

async function listNextcloudProfileArchives(settings) {
  let test = await testNextcloudSettings(settings);
  if (test.status !== 'success') {
    throw new Error(test.message || 'Nextcloud connection failed.');
  }
  if (!settings.scopes || !settings.scopes.profiles || !settings.scopes.profiles.remotePath) {
    throw new Error('Enter the Profiles Nextcloud destination folder before listing archives.');
  }
  return await listNextcloudArchiveFiles(settings, settings.scopes.profiles.remotePath, scopeArchivePrefix('profiles'));
}

async function restoreProfileArchive(settings, archivePath, job) {
  assertNextcloudJobNotCanceled(job);
  let cleanArchivePath = assertSafeNextcloudArchivePath(settings, 'profiles', archivePath);
  let archiveBuffer = await getNextcloudFile(settings, cleanArchivePath);
  assertNextcloudJobNotCanceled(job);
  let zip = await JSZip.loadAsync(archiveBuffer);
  let entries = Object.keys(zip.files).filter(function(name) {
    return !zip.files[name].dir;
  });
  let profileRoot = path.join(home, 'profile');
  let backupRoot = path.join(profileRoot, '.restore-backups', backupTimestampLabel());
  let summary = {
    mode: 'restore',
    scopes: ['profiles'],
    archiveFile: cleanArchivePath,
    filesRestored: 0,
    filesBackedUp: 0,
    bytesRestored: 0,
    backupFolder: backupRoot
  };
  for await (let entryName of entries) {
    assertNextcloudJobNotCanceled(job);
    if (entryName === 'settings.json' || entryName === 'activity.db' || entryName === 'scan-history.jsonl') {
      continue;
    }
    let targetPath = safeProfilePath(profileRoot, entryName);
    let backupPath = safeProfilePath(backupRoot, entryName);
    let content = await zip.files[entryName].async('nodebuffer');
    if (fs.existsSync(targetPath)) {
      await ensureDir(backupPath);
      await fsw.copyFile(targetPath, backupPath);
      summary.filesBackedUp += 1;
    }
    await ensureDir(targetPath);
    await fsw.writeFile(targetPath, content);
    summary.filesRestored += 1;
    summary.bytesRestored += content.length;
  }
  return summary;
}

function publicNextcloudJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    kind: job.kind || 'backup',
    status: job.status,
    message: job.message || '',
    mode: job.mode || '',
    scopes: job.scopes || [],
    startedAt: job.startedAt || '',
    completedAt: job.completedAt || '',
    requestedBy: job.requestedBy || '',
    progress: job.progress || 0,
    summary: job.summary || null,
    error: job.error || ''
  };
}

function latestNextcloudJob() {
  let jobs = Array.from(nextcloudBackupJobs.values());
  jobs.sort(function(a, b) {
    return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  });
  return jobs[0] || null;
}

function runningNextcloudJob() {
  return Array.from(nextcloudBackupJobs.values()).find(function(job) {
    return job.status === 'running' || job.status === 'queued' || job.status === 'canceling';
  }) || null;
}

function trimNextcloudJobs() {
  let jobs = Array.from(nextcloudBackupJobs.values());
  if (jobs.length <= 20) {
    return;
  }
  jobs.sort(function(a, b) {
    return String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
  });
  jobs.slice(20).forEach(function(job) {
    nextcloudBackupJobs.delete(job.id);
  });
}

function backupRequestContext(req) {
  return {
    headers: Object.assign({}, req.headers || {}),
    socket: {
      remoteAddress: req && req.socket ? req.socket.remoteAddress : ''
    }
  };
}

function schedulerRequestContext() {
  return {
    headers: {
      'user-agent': 'EmulatorJS Nextcloud Scheduler'
    },
    socket: {
      remoteAddress: '127.0.0.1'
    }
  };
}

function backupActivityPayload(job, action, status, extra) {
  let kind = job.kind === 'restore' ? 'restore' : 'backup';
  return Object.assign({
    title: 'EmulatorJS Nextcloud ' + kind + ' ' + status,
    event: 'nextcloud_' + kind + '_' + status,
    action: action,
    status: status,
    username: job.requestedBy || '',
    role: 'admin',
    source: 'filebrowser',
    nextcloudJob: {
      id: job.id,
      kind: kind,
      mode: job.mode || '',
      scopes: job.scopes || [],
      startedAt: job.startedAt || '',
      completedAt: job.completedAt || '',
      message: job.message || ''
    },
    backup: {
      id: job.id,
      kind: kind,
      mode: job.mode || '',
      scopes: job.scopes || [],
      startedAt: job.startedAt || '',
      completedAt: job.completedAt || '',
      message: job.message || ''
    }
  }, extra || {});
}

async function emitBackupActivity(job, action, status, extra) {
  try {
    let settings = await readSettings();
    await emitActivityWebhook(settings, job.requestContext || {headers: {}, socket: {}}, backupActivityPayload(job, action, status, extra));
  } catch(e) {
    console.log('Unable to emit Nextcloud backup activity', e);
  }
}

function updateNextcloudJob(job, updates) {
  Object.assign(job, updates || {});
  nextcloudBackupJobs.set(job.id, job);
  return job;
}

async function persistNextcloudJobStatus(job) {
  let settings = await readSettings();
  settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
  settings.nextcloud.lastStatus = {
    kind: job.kind || 'backup',
    status: job.status,
    message: job.message || '',
    startedAt: job.startedAt || '',
    completedAt: job.completedAt || '',
    jobId: job.id,
    summary: job.summary || null
  };
  await writeSettings(settings);
}

async function runNextcloudBackupJob(job, settings) {
  updateNextcloudJob(job, {
    status: 'running',
    message: 'Nextcloud backup is running.',
    progress: 5
  });
  await persistNextcloudJobStatus(job);
  await emitBackupActivity(job, 'backup_start', 'started');
  try {
    let summary = await runNextcloudBackup(settings, job);
    let skipText = summary.skippedArchives ? ' Skipped ' + summary.skippedArchives + ' oversized archive scope(s).' : '';
    updateNextcloudJob(job, {
      status: 'success',
      completedAt: new Date().toISOString(),
      progress: 100,
      summary: summary,
      message: 'Backup completed. Uploaded ' + summary.filesUploaded + ' file(s), ' + summary.archivesUploaded + ' archive(s), deleted ' + summary.remoteExtrasDeleted + ' remote extra file(s), ' + summary.bytesUploaded + ' byte(s).' + skipText
    });
    await persistNextcloudJobStatus(job);
    await emitBackupActivity(job, 'backup_complete', 'succeeded', {backup: Object.assign(backupActivityPayload(job, 'backup_complete', 'succeeded').backup, {summary: summary})});
  } catch(e) {
    let canceled = e && e.code === 'NEXTCLOUD_BACKUP_CANCELED';
    updateNextcloudJob(job, {
      status: canceled ? 'canceled' : 'error',
      completedAt: new Date().toISOString(),
      progress: 100,
      error: canceled ? '' : e && e.message ? e.message : 'Nextcloud backup failed.',
      message: canceled ? 'Nextcloud backup canceled.' : e && e.message ? e.message : 'Nextcloud backup failed.'
    });
    await persistNextcloudJobStatus(job);
    if (canceled) {
      await emitBackupActivity(job, 'backup_canceled', 'canceled');
    } else {
      await emitBackupActivity(job, 'backup_failed', 'failed', {
        reason: job.error,
        backup: Object.assign(backupActivityPayload(job, 'backup_failed', 'failed').backup, {error: job.error})
      });
    }
  } finally {
    trimNextcloudJobs();
  }
}

async function runNextcloudRestoreJob(job, settings, archivePath) {
  updateNextcloudJob(job, {
    status: 'running',
    message: 'Nextcloud restore is running.',
    progress: 10
  });
  await persistNextcloudJobStatus(job);
  await emitBackupActivity(job, 'restore_start', 'started');
  try {
    let summary = await restoreProfileArchive(settings, archivePath, job);
    updateNextcloudJob(job, {
      status: 'success',
      completedAt: new Date().toISOString(),
      progress: 100,
      summary: summary,
      message: 'Restore completed. Restored ' + summary.filesRestored + ' profile file(s) from ' + path.posix.basename(summary.archiveFile) + '.'
    });
    await persistNextcloudJobStatus(job);
    await emitBackupActivity(job, 'restore_complete', 'succeeded', {backup: Object.assign(backupActivityPayload(job, 'restore_complete', 'succeeded').backup, {summary: summary}), restore: summary});
  } catch(e) {
    let canceled = e && e.code === 'NEXTCLOUD_BACKUP_CANCELED';
    updateNextcloudJob(job, {
      status: canceled ? 'canceled' : 'error',
      completedAt: new Date().toISOString(),
      progress: 100,
      error: canceled ? '' : e && e.message ? e.message : 'Nextcloud restore failed.',
      message: canceled ? 'Nextcloud restore canceled.' : e && e.message ? e.message : 'Nextcloud restore failed.'
    });
    await persistNextcloudJobStatus(job);
    if (canceled) {
      await emitBackupActivity(job, 'restore_canceled', 'canceled');
    } else {
      await emitBackupActivity(job, 'restore_failed', 'failed', {
        reason: job.error,
        backup: Object.assign(backupActivityPayload(job, 'restore_failed', 'failed').backup, {error: job.error})
      });
    }
  } finally {
    trimNextcloudJobs();
  }
}

function startNextcloudBackupJob(req, profileRecord, settings) {
  let existing = runningNextcloudJob();
  if (existing) {
    return {existing: true, job: existing};
  }
  assertSupportedNextcloudScopes(settings);
  cleanupMirrorDeletePreviews();
  let mirrorDeletePreview = null;
  if (settings.mirrorDelete === true) {
    mirrorDeletePreview = nextcloudMirrorDeletePreviews.get(String(req.body.mirrorDeletePreviewId || ''));
    if (!mirrorDeletePreview || mirrorDeletePreview.key !== mirrorDeletePreviewKey(settings)) {
      throw new Error('Preview mirror deletes before running a backup with mirror delete enabled.');
    }
  }
  let job = {
    id: 'nextcloud-' + Date.now() + '-' + nextcloudBackupSeq++,
    kind: 'backup',
    status: 'queued',
    message: 'Nextcloud backup queued.',
    mode: settings.mode,
    scopes: selectedNextcloudScopes(settings),
    progress: 0,
    startedAt: new Date().toISOString(),
    completedAt: '',
    requestedBy: profileRecord && profileRecord.username || '',
    summary: null,
    error: '',
    cancelRequested: false,
    mirrorDeletePreview: mirrorDeletePreview,
    requestContext: backupRequestContext(req)
  };
  nextcloudBackupJobs.set(job.id, job);
  setImmediate(function() {
    runNextcloudBackupJob(job, settings).catch(function(e) {
      console.log('Nextcloud backup job failed outside handler', e);
    });
  });
  return {existing: false, job: job};
}

function startNextcloudRestoreJob(req, profileRecord, settings, archivePath) {
  let existing = runningNextcloudJob();
  if (existing) {
    return {existing: true, job: existing};
  }
  assertSafeNextcloudArchivePath(settings, 'profiles', archivePath);
  let job = {
    id: 'nextcloud-' + Date.now() + '-' + nextcloudBackupSeq++,
    kind: 'restore',
    status: 'queued',
    message: 'Nextcloud restore queued.',
    mode: 'restore',
    scopes: ['profiles'],
    progress: 0,
    startedAt: new Date().toISOString(),
    completedAt: '',
    requestedBy: profileRecord && profileRecord.username || '',
    summary: null,
    error: '',
    cancelRequested: false,
    requestContext: backupRequestContext(req)
  };
  nextcloudBackupJobs.set(job.id, job);
  setImmediate(function() {
    runNextcloudRestoreJob(job, settings, archivePath).catch(function(e) {
      console.log('Nextcloud restore job failed outside handler', e);
    });
  });
  return {existing: false, job: job};
}

async function checkNextcloudSchedule() {
  try {
    if (runningNextcloudJob()) {
      return;
    }
    let settings = await readSettings();
    settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
    let schedule = settings.nextcloud.schedule || {};
    let due = scheduleDueInfo(schedule, new Date());
    if (!due.due) {
      return;
    }
    settings.nextcloud.schedule.lastRunKey = due.key;
    await writeSettings(settings);
    try {
      startNextcloudBackupJob(schedulerRequestContext(), {username: 'scheduler'}, settings.nextcloud);
    } catch(e) {
      settings = await readSettings();
      settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
      settings.nextcloud.lastStatus = {
        status: 'error',
        message: e && e.message ? e.message : 'Scheduled Nextcloud backup failed to start.',
        completedAt: new Date().toISOString()
      };
      await writeSettings(settings);
    }
  } catch(e) {
    console.log('Nextcloud schedule check failed', e);
  }
}

async function markStaleNextcloudRunningStatus() {
  try {
    let settings = await readSettings();
    settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
    let last = settings.nextcloud.lastStatus || {};
    if (last.status !== 'running' && last.status !== 'queued' && last.status !== 'canceling') {
      return;
    }
    let completedAt = new Date().toISOString();
    let message = 'Previous Nextcloud backup did not finish before the service restarted. It was marked failed so a new backup can run.';
    settings.nextcloud.lastStatus = Object.assign({}, last, {
      status: 'error',
      message: message,
      completedAt: completedAt
    });
    await writeSettings(settings);
    let job = {
      id: last.jobId || 'nextcloud-stale-' + Date.now(),
      kind: last.kind || 'backup',
      status: 'error',
      mode: settings.nextcloud.mode || '',
      scopes: selectedNextcloudScopes(settings.nextcloud),
      startedAt: last.startedAt || '',
      completedAt: completedAt,
      requestedBy: 'system',
      message: message,
      requestContext: schedulerRequestContext()
    };
    console.log('Nextcloud backup stale running status marked failed:', message);
    await emitBackupActivity(job, 'backup_stale_failed', 'failed', {
      reason: message,
      backup: Object.assign(backupActivityPayload(job, 'backup_stale_failed', 'failed').backup, {
        error: message
      })
    });
  } catch(e) {
    console.log('Unable to mark stale Nextcloud backup status', e);
  }
}

markStaleNextcloudRunningStatus();
setInterval(checkNextcloudSchedule, 60 * 1000);
setTimeout(checkNextcloudSchedule, 15 * 1000);

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

function normalizeFavoritesList(favorites) {
  return Array.isArray(favorites) ? favorites.map(function(favorite) {
    return typeof favorite === 'string' ? {id: favorite} : favorite;
  }).filter(function(favorite) {
    return favorite && favorite.id && favorite.id !== 'undefined' && favorite.id.indexOf('undefined::') !== 0;
  }) : [];
}

function favoriteSyncTimestamp(record) {
  return Math.max(Number(record && record.updatedAt || 0), Number(record && record.addedAt || 0), Number(record && record.removedAt || 0));
}

function mergeFavoritesState(baseFavoritesData, baseSyncData, incomingFavoritesData, incomingSyncData) {
  let state = {version: 1, records: {}};
  function parseFavorites(data) {
    if (!data) {
      return [];
    }
    try {
      return normalizeFavoritesList(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)));
    } catch (e) {
      console.log('Unable to parse favorites data', e);
      return [];
    }
  }
  function parseSync(data) {
    if (!data) {
      return null;
    }
    try {
      let parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      return parsed && parsed.records && typeof parsed.records === 'object' ? parsed : null;
    } catch (e) {
      console.log('Unable to parse favorites sync data', e);
      return null;
    }
  }
  function seedFavorites(favorites) {
    favorites.forEach(function(favorite) {
      if (!state.records[favorite.id]) {
        state.records[favorite.id] = {
          id: favorite.id,
          favorite: favorite,
          addedAt: 1,
          removedAt: null,
          updatedAt: 1
        };
      }
    });
  }
  function mergeSync(sync) {
    if (!sync) {
      return;
    }
    Object.keys(sync.records || {}).forEach(function(id) {
      let record = sync.records[id];
      if (!record || !id) {
        return;
      }
      let existing = state.records[id];
      if (!existing || favoriteSyncTimestamp(record) >= favoriteSyncTimestamp(existing)) {
        state.records[id] = {
          id: id,
          favorite: record.favorite || existing && existing.favorite || {id: id},
          addedAt: Number(record.addedAt || 0),
          removedAt: record.removedAt || null,
          updatedAt: favoriteSyncTimestamp(record)
        };
      }
    });
  }
  seedFavorites(parseFavorites(baseFavoritesData));
  mergeSync(parseSync(baseSyncData));
  seedFavorites(parseFavorites(incomingFavoritesData));
  mergeSync(parseSync(incomingSyncData));
  return state;
}

function activeFavoritesFromSyncState(state) {
  return Object.keys(state.records || {}).map(function(id) {
    return state.records[id];
  }).filter(function(record) {
    return record && (!record.removedAt || Number(record.addedAt || 0) > Number(record.removedAt || 0));
  }).sort(function(a, b) {
    return Number(a.addedAt || 0) - Number(b.addedAt || 0);
  }).map(function(record) {
    return record.favorite || {id: record.id};
  });
}

async function mergeAndWriteFavorites(profilePath, zip, incomingFavoritesContent) {
  let favoritesPath = safeProfilePath(profilePath, favoritesProfileFile);
  let syncPath = safeProfilePath(profilePath, favoritesSyncProfileFile);
  let existingFavorites = fs.existsSync(favoritesPath) ? await fsw.readFile(favoritesPath) : null;
  let existingSync = fs.existsSync(syncPath) ? await fsw.readFile(syncPath) : null;
  let incomingSync = zip.files[favoritesSyncProfileFile] ? Buffer.from(await zip.files[favoritesSyncProfileFile].async('arraybuffer')) : null;
  let merged = mergeFavoritesState(existingFavorites, existingSync, incomingFavoritesContent, incomingSync);
  await ensureDir(favoritesPath);
  await fsw.writeFile(favoritesPath, JSON.stringify(activeFavoritesFromSyncState(merged), null, 2));
  await fsw.writeFile(syncPath, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    records: merged.records || {}
  }, null, 2));
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
        } else if (type == 'getnextcloudsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          res.json({status: 'success', nextcloud: publicNextcloudSettings(settings)});
        } else if (type == 'setnextcloudsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          settings.nextcloud = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          await writeSettings(settings);
          res.json({status: 'success', nextcloud: publicNextcloudSettings(settings)});
        } else if (type == 'testnextcloudconnection') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          let testSettings = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          let result = await testNextcloudSettings(testSettings);
          res.json(result.status === 'success' ? result : {status: 'error', message: result.message || 'Nextcloud connection failed.'});
        } else if (type == 'listnextcloudarchives') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          let testSettings = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          try {
            let archives = await listNextcloudProfileArchives(testSettings);
            res.json({status: 'success', archives: archives});
          } catch(e) {
            res.json({status: 'error', message: e && e.message ? e.message : 'Unable to list Nextcloud archives.'});
          }
        } else if (type == 'previewnextcloudmirrordelete') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          let testSettings = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          try {
            let preview = await previewNextcloudMirrorDelete(testSettings);
            res.json({status: 'success', preview: preview});
          } catch(e) {
            res.json({status: 'error', message: e && e.message ? e.message : 'Unable to preview mirror deletes.'});
          }
        } else if (type == 'runnextcloudbackup') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          settings.nextcloud = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          await writeSettings(settings);
          try {
            let started = startNextcloudBackupJob(req, profile[hash], settings.nextcloud);
            res.json({
              status: 'success',
              message: started.existing ? 'A Nextcloud backup is already running.' : 'Nextcloud backup started.',
              job: publicNextcloudJob(started.job),
              nextcloud: publicNextcloudSettings(settings)
            });
          } catch(e) {
            settings = await readSettings();
            settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
            settings.nextcloud.lastStatus = {
              status: 'error',
              message: e && e.message ? e.message : 'Nextcloud backup failed.',
              completedAt: new Date().toISOString()
            };
            await writeSettings(settings);
            res.json({status: 'error', message: settings.nextcloud.lastStatus.message, nextcloud: publicNextcloudSettings(settings)});
          }
        } else if (type == 'restorenextcloudarchive') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          settings.nextcloud = normalizeNextcloudSettings(req.body.nextcloud || {}, settings.nextcloud);
          await writeSettings(settings);
          try {
            let archivePath = String(req.body.archivePath || '');
            let started = startNextcloudRestoreJob(req, profile[hash], settings.nextcloud, archivePath);
            res.json({
              status: 'success',
              message: started.existing ? 'A Nextcloud job is already running.' : 'Nextcloud restore started.',
              job: publicNextcloudJob(started.job),
              nextcloud: publicNextcloudSettings(settings)
            });
          } catch(e) {
            settings = await readSettings();
            settings.nextcloud = normalizeNextcloudSettings(settings.nextcloud || {}, settings.nextcloud);
            settings.nextcloud.lastStatus = {
              kind: 'restore',
              status: 'error',
              message: e && e.message ? e.message : 'Nextcloud restore failed.',
              completedAt: new Date().toISOString()
            };
            await writeSettings(settings);
            res.json({status: 'error', message: settings.nextcloud.lastStatus.message, nextcloud: publicNextcloudSettings(settings)});
          }
        } else if (type == 'getnextcloudbackupstatus') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let job = req.body.jobId ? nextcloudBackupJobs.get(req.body.jobId) : runningNextcloudJob() || latestNextcloudJob();
          let settings = await readSettings();
          res.json({status: 'success', job: publicNextcloudJob(job), nextcloud: publicNextcloudSettings(settings)});
        } else if (type == 'cancelnextcloudbackup') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let job = req.body.jobId ? nextcloudBackupJobs.get(req.body.jobId) : runningNextcloudJob();
          if (!job || (job.status !== 'running' && job.status !== 'queued' && job.status !== 'canceling')) {
            res.json({status: 'error', message: 'No running Nextcloud job was found.'});
            return;
          }
          let label = job.kind === 'restore' ? 'restore' : 'backup';
          job.cancelRequested = true;
          updateNextcloudJob(job, {
            status: 'canceling',
            message: 'Stop requested. Nextcloud ' + label + ' will stop after the current file finishes.',
            progress: Math.max(job.progress || 0, 5)
          });
          await persistNextcloudJobStatus(job);
          res.json({status: 'success', message: job.message, job: publicNextcloudJob(job)});
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
            if (normalizedFileName === favoritesSyncProfileFile) {
              continue;
            }
            let targetPath = safeProfilePath(profilePath, normalizedFileName);
            let content = Buffer.from(await zipEntry.async('arraybuffer'));
            if (normalizedFileName === favoritesProfileFile) {
              await mergeAndWriteFavorites(profilePath, zip, content);
              continue;
            }
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
