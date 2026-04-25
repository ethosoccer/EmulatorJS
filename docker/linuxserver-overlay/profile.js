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
app.use(express.json({ limit: '150MB' }));

function roleFor(profileRecord) {
  return profileRecord && profileRecord.role === 'admin' ? 'admin' : 'user';
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

async function readProfiles() {
  let profileJson = await fsw.readFile(home + '/profile/profile.json', 'utf8');
  let profiles = JSON.parse(profileJson);
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
    await writeProfiles(profiles);
  }
  return profiles;
}

async function writeProfiles(profile) {
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
  let basePayload = Object.assign({
    app: 'EmulatorJS'
  }, requestMetadata(req), payload || {});
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
        res.json({status: 'success', requireLogin: settings.requireLogin === true});
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
        // Return username if found
        if (type == 'login') {
          if (req.body.silent !== true) {
            let settings = await readSettings();
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
          res.json({status: 'success', user: profile[hash].username, role: currentRole});
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
        } else if (type == 'listusers') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let users = [];
          for await (let userHash of Object.keys(profile)) {
            users.push({username: profile[userHash].username, role: roleFor(profile[userHash])});
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
          profile[newHash] = {username: newUser, role: newRole};
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
          res.json({status: 'success', requireLogin: settings.requireLogin === true, passwordResetWebhook: settings.passwordResetWebhook || ''});
        } else if (type == 'setsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          let settings = await readSettings();
          settings.requireLogin = req.body.requireLogin === true;
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
          let records = [];
          let currentFiles = await collectFiles(profilePath, '', []);
          for await (let file of currentFiles) {
            if (!isSaveFile(file.relPath) || file.relPath.startsWith('.history/')) {
              continue;
            }
            records.push({
              id: 'profile::current::' + file.relPath,
              pathKey: file.relPath,
              name: safeDecodeName(path.basename(file.relPath)),
              type: saveTypeForPath(file.relPath),
              source: 'Profile: ' + file.relPath.split('/').slice(0, 2).join('/'),
              versionLabel: 'Server current',
              versionSort: file.stat.mtimeMs || 0,
              size: file.stat.size || 0
            });
          }
          let historyRoot = path.join(profilePath, '.history');
          if (fs.existsSync(historyRoot)) {
            let snapshots = await fsw.readdir(historyRoot);
            for await (let snapshot of snapshots) {
              let snapshotRoot = path.join(historyRoot, snapshot);
              let snapshotFiles = await collectFiles(snapshotRoot, '', []);
              for await (let file of snapshotFiles) {
                if (!isSaveFile(file.relPath)) {
                  continue;
                }
                records.push({
                  id: 'profile::history::' + snapshot + '::' + file.relPath,
                  pathKey: '.history/' + snapshot + '/' + file.relPath,
                  name: safeDecodeName(path.basename(file.relPath)),
                  type: saveTypeForPath(file.relPath),
                  source: 'Profile backup: ' + snapshot,
                  versionLabel: snapshot,
                  versionSort: file.stat.mtimeMs || 0,
                  size: file.stat.size || 0
                });
              }
            }
          }
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
          for await (let fileName of Object.keys(zip.files)) {
            let zipEntry = zip.files[fileName];
            if (zipEntry.dir) {
              await fsw.mkdir(safeProfilePath(profilePath, fileName), {recursive: true});
              continue;
            }
            let targetPath = safeProfilePath(profilePath, fileName);
            let content = Buffer.from(await zipEntry.async('arraybuffer'));
            await ensureDir(targetPath);
            if (fs.existsSync(targetPath)) {
              let existing = await fsw.readFile(targetPath);
              if (!existing.equals(content)) {
                let backupPath = safeProfilePath(profilePath, '.history/' + backupStamp + '/' + fileName);
                await ensureDir(backupPath);
                await fsw.copyFile(targetPath, backupPath);
              }
            }
            await fsw.writeFile(targetPath, content);
          }
          res.json({status: 'success',user: profile[hash].username});
        // Send client data to write to indexedDB
        } else if (type == 'pull') {
          try {
            let profilePath = home + '/profile/' + profile[hash].username + '/';
            let zip = new JSZip();
            let items = await fs.readdirSync(profilePath);
            async function addToZip(item) {
              if (fs.lstatSync(item).isDirectory()) {
                if (path.basename(item) === '.history') {
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
