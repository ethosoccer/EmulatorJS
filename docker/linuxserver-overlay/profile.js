// NPM modules
var crypto = require('crypto');
var home = require('os').homedir();
var express = require('express');
var app = express();
var fs = require('fs');
var fsw = require('fs').promises;
var path = require('path');
var JSZip = require('jszip');

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

async function readProfiles() {
  let profileJson = await fsw.readFile(home + '/profile/profile.json', 'utf8');
  return JSON.parse(profileJson);
}

async function writeProfiles(profile) {
  await fsw.writeFile(home + '/profile/profile.json', JSON.stringify(profile, null, 2));
}

async function readSettings() {
  try {
    return JSON.parse(await fsw.readFile(settingsFile, 'utf8'));
  } catch(e) {
    return {requireLogin: false};
  }
}

async function writeSettings(settings) {
  await fsw.writeFile(settingsFile, JSON.stringify(settings, null, 2));
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
          let newHash = crypto.createHash('sha256').update(newUser + newPass).digest('hex');
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
          res.json({status: 'success', requireLogin: settings.requireLogin === true});
        } else if (type == 'setsettings') {
          if (currentRole !== 'admin') {
            res.json(error);
            return;
          }
          await writeSettings({requireLogin: req.body.requireLogin === true});
          res.json({status: 'success'});
        // Take client data and write it to profile
        } else if (type == 'push') {
          let profilePath = home + '/profile/' + profile[hash].username + '/';
          let baseData = req.body.data;
          // Purge current storage
          let items = await fsw.readdir(profilePath);
          if (items.length > 0) {
            for await (let item of items) {
              var filePath = profilePath + item;
              if (fs.statSync(filePath).isFile()) {
                await fsw.rm(filePath);
              } else {
                await fsw.rm(filePath, { recursive: true, force: true });
              }
            }
          }
          // Load zip from data
          let zip = new JSZip();
          zip.loadAsync(baseData, {base64: true}).then(async function(contents) {
            // Unzip the files to the FS by name
            for await (let fileName of Object.keys(contents.files)) {
              if (fileName.endsWith('/')) {
                if (! fs.existsSync(profilePath + fileName)) {
                  await fsw.mkdir(profilePath + fileName);
                }
              }
            }
            for await (let fileName of Object.keys(contents.files)) {
              if (! fileName.endsWith('/')) {
                zip.file(fileName).async('arraybuffer').then(async function(content) {
                  await fsw.writeFile(profilePath + fileName, Buffer.from(content));
                });
              }
            }
          });
          res.json({status: 'success',user: profile[hash].username});
        // Send client data to write to indexedDB
        } else if (type == 'pull') {
          try {
            let profilePath = home + '/profile/' + profile[hash].username + '/';
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
