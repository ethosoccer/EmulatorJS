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

// Default vars
var error = {status: 'error'};
var settingsFile = home + '/profile/settings.json';
app.use(express.json({ limit: '500MB' }));

function roleFor(profileRecord) {
  if (profileRecord.role) {
    return profileRecord.role;
  }
  if (profileRecord.username == 'eugene') {
    return 'admin';
  }
  return 'user';
}

function defaultSettings() {
  return {requireLogin: false, passwordResetWebhook: ''};
}

async function readProfiles() {
  let profileJson = await fsw.readFile(home + '/profile/profile.json', 'utf8');
  return JSON.parse(profileJson);
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

function findUserHash(profile, username) {
  for (let userHash of Object.keys(profile)) {
    if (profile[userHash].username == username) {
      return userHash;
    }
  }
  return null;
}

function requestIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
}

function sendWebhook(url, payload) {
  return new Promise(function(resolve, reject) {
    try {
      let parsed = new URL(url);
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
          time: new Date().toISOString(),
          ip: requestIp(req),
          forwardedFor: req.headers['x-forwarded-for'] || '',
          userAgent: req.headers['user-agent'] || '',
          host: req.headers.host || '',
          origin: req.headers.origin || '',
          referer: req.headers.referer || ''
        };
        let sent = await sendWebhook(settings.passwordResetWebhook, payload);
        res.json(sent ? {status: 'success'} : error);
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
          res.json({status: 'success', user: profile[hash].username, role: currentRole});
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
          for await (let userHash of Object.keys(profile)) {
            if (profile[userHash].username == target) {
              profile[userHash].role = role;
            }
          }
          await writeProfiles(profile);
          res.json({status: 'success'});
        } else if (type == 'changepassword') {
          let newPass = req.body.newPass;
          if (!newPass) {
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
          if (!targetHash || !newPass) {
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
          if (!newUser || !newPass || /[\/\\]/.test(newUser)) {
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
            time: new Date().toISOString(),
            ip: requestIp(req),
            userAgent: req.headers['user-agent'] || '',
            host: req.headers.host || ''
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
        res.json(error);
      }
    }
  } catch (e) {
    console.log(e)
    res.json(error);
  }
});

app.listen(3001);
