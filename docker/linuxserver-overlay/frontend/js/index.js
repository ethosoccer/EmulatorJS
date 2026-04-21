//// Default vars ////
var Init = { method:'GET',headers:{'Access-Control-Allow-Origin':'*'},mode:'cors',cache:'no-store'};
var configCacheToken = Date.now().toString();
var defaultKeys = [
  'emulator',
  'bios',
  'path',
  'rom_extension',
  'video_position',
  'type',
  'has_back',
  'has_corner',
  'has_logo',
  'has_video',
  'multi_disc'
];
localStorage.setItem('retroArch',true);
var gamePadType;
var searchCatalog;
var searchCatalogLoading;
var searchSourceConfigs = {};
var profileEndpoint = 'profile';
var profileStoreName = 'RetroArch';
var favoritesProfileFile = '.emulatorjs-favorites.json';
var profileFs;
var profileFsReady;
var profilePushTimer;
var profilePushTimeout;
var profilePushInFlight = false;
var saveInventoryCache;
var saveInventoryLoading;
var savePanelBackHandler = null;
var requireMainLogin = false;
var isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') > -1 &&
               navigator.userAgent &&
               navigator.userAgent.indexOf('CriOS') == -1 &&
               navigator.userAgent.indexOf('FxiOS') == -1;

//// Helper functions ////
// Debounce calls to functions that run heavy
function debounce(func, wait, immediate) {
  var timeout;
  return function() {
    var context = this, args = arguments;
    var later = function() {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    var callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(context, args);
  };
};
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function(char) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}
function safeDecodeDisplayName(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch(e) {
    return String(value || '');
  }
}
function hasUsableValue(value) {
  return typeof value !== 'undefined' && value !== null && String(value).trim() !== '' && String(value) !== 'undefined';
}
function favoriteNameFallback(favoriteId) {
  if (!hasUsableValue(favoriteId)) {
    return 'Unknown game';
  }
  var name = String(favoriteId).split('::').slice(1).join('::');
  return hasUsableValue(name) ? name : 'Unknown game';
}
function cleanGameName(name, favoriteId) {
  return hasUsableValue(name) ? String(name) : favoriteNameFallback(favoriteId);
}
function getFavoriteIds() {
  return getFavorites().map(function(favorite) {
    return favorite.id;
  });
}
function getFavorites() {
  try {
    var favorites = JSON.parse(localStorage.getItem('ejsFavorites') || '[]');
    if (Array.isArray(favorites)) {
      return favorites.map(function(favorite) {
        if (typeof favorite === 'string') {
          return {id: favorite};
        }
        return favorite;
      }).filter(function(favorite) {
        return favorite && favorite.id && favorite.id !== 'undefined' && favorite.id.indexOf('undefined::') !== 0;
      }).map(function(favorite) {
        favorite.name = cleanGameName(favorite.name, favorite.id);
        favorite.root = hasUsableValue(favorite.root) ? favorite.root : 'main';
        favorite.title = hasUsableValue(favorite.title) ? favorite.title : 'Games';
        favorite.index = Number(favorite.index || 0);
        return favorite;
      });
    }
  } catch(e) {
    console.log(e);
  }
  return [];
}
function saveFavorites(favorites) {
  localStorage.setItem('ejsFavorites', JSON.stringify(favorites));
}
function restoreFavoritesFromProfile(data) {
  if (!hasUsableValue(data)) {
    return;
  }
  try {
    JSON.parse(data);
    localStorage.setItem('ejsFavorites', data);
  } catch(e) {
    console.log(e);
  }
}
function profileRequest(body) {
  return fetch(profileEndpoint, {
    method: 'POST',
    headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
}
function freshJsonUrl(url) {
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  return url + separator + 'v=' + configCacheToken;
}
function fetchFreshJson(url) {
  return fetch(freshJsonUrl(url), Init);
}
function idbRead(dbName, storeName, reader) {
  return new Promise(function(resolve) {
    if (!window.indexedDB) {
      resolve();
      return;
    }
    var request = indexedDB.open(dbName);
    request.onerror = function() {
      resolve();
    };
    request.onsuccess = function() {
      var db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve();
        return;
      }
      try {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var readRequest = reader(store);
        readRequest.onsuccess = function() {
          resolve(readRequest.result);
        };
        readRequest.onerror = function() {
          resolve();
        };
        tx.oncomplete = function() {
          db.close();
        };
      } catch(e) {
        db.close();
        resolve();
      }
    };
  });
}
async function idbGetKeys(dbName, storeName) {
  if (!window.indexedDB) {
    return [];
  }
  if (IDBObjectStore.prototype.getAllKeys) {
    return await idbRead(dbName, storeName, function(store) {
      return store.getAllKeys();
    }) || [];
  }
  return new Promise(function(resolve) {
    var request = indexedDB.open(dbName);
    request.onerror = function() {
      resolve([]);
    };
    request.onsuccess = function() {
      var db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      var keys = [];
      try {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var cursor = store.openKeyCursor();
        cursor.onsuccess = function() {
          var result = cursor.result;
          if (result) {
            keys.push(result.key);
            result.continue();
          }
        };
        cursor.onerror = function() {
          resolve(keys);
        };
        tx.oncomplete = function() {
          db.close();
          resolve(keys);
        };
      } catch(e) {
        db.close();
        resolve(keys);
      }
    };
  });
}
async function idbGetValue(dbName, storeName, key) {
  return await idbRead(dbName, storeName, function(store) {
    return store.get(key);
  });
}
function saveBasename(value) {
  var name = String(value || '').split('/').pop().split('#')[0].split('?')[0];
  try {
    name = decodeURIComponent(name);
  } catch(e) {}
  var previous;
  do {
    previous = name;
    name = name.replace(/\.(auto|zip|7z|nes|sfc|smc|gb|gbc|gba|n64|z64|v64|bin|cue|iso|chd|state|srm|sav|eep|fla|sra|dsv|rtc|ram|nvm|mcr|mcd|disk[0-9]+)$/i, '');
  } while (name !== previous);
  return name;
}
function saveMatchKey(value) {
  return saveBasename(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function quickSaveMirrorKey(gameName, slot) {
  return saveBasename(gameName || 'game') + '.slot' + (slot || 1) + '.quick.state';
}
function saveRecordMatchesGame(record, gameBase) {
  var gameKey = saveMatchKey(gameBase);
  var saveKey = saveMatchKey(record.name || record.key || '');
  return gameKey && saveKey && (saveKey.indexOf(gameKey) !== -1 || gameKey.indexOf(saveKey) !== -1);
}
function saveVariantGroupKey(record) {
  return String(record.name || record.key || '').toLowerCase();
}
function installQuickSaveMirror(gameName) {
  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    var emulator = window.EJS_emulator;
    var gameManager = emulator && emulator.gameManager;
    if (!gameManager || !gameManager.quickSave || !emulator.storage || !emulator.storage.states) {
      if (attempts > 100) {
        clearInterval(timer);
      }
      return;
    }
    clearInterval(timer);
    if (gameManager.quickSave.__ejsSaveMirrorInstalled) {
      return;
    }
    var originalQuickSave = gameManager.quickSave.bind(gameManager);
    gameManager.quickSave = function(slot) {
      var saveSlot = slot || 1;
      var saved = originalQuickSave(saveSlot);
      if (saved) {
        try {
          var data = gameManager.FS.readFile('/' + saveSlot + '-quick.state');
          emulator.storage.states.put(quickSaveMirrorKey(gameName, saveSlot), data);
        } catch(e) {
          console.log('Unable to mirror quick save', e);
        }
      }
      return saved;
    };
    gameManager.quickSave.__ejsSaveMirrorInstalled = true;
  }, 100);
}
function formatBytes(size) {
  if (!size && size !== 0) {
    return 'unknown size';
  }
  if (size < 1024) {
    return size + ' B';
  }
  if (size < 1024 * 1024) {
    return Math.round(size / 102.4) / 10 + ' KB';
  }
  return Math.round(size / 1024 / 102.4) / 10 + ' MB';
}
function formatDateTime(timestamp) {
  if (!timestamp) {
    return 'time unavailable';
  }
  try {
    return new Date(timestamp).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch(e) {
    return 'time unavailable';
  }
}
function saveVersionSummary(save) {
  return (save.versionLabel || save.source || 'Version') + ' - ' + formatDateTime(save.versionSort) + ' - ' + (save.type || 'Save') + ' - ' + formatBytes(save.size);
}
function groupedSaveSummary(group) {
  return (group.latest.type || 'Save') + ' - ' + (group.latest.versionLabel || group.latest.source || 'Latest') + ' - ' + formatDateTime(group.latest.versionSort) + ' - ' + group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's');
}
function bytesFromSaveValue(value) {
  if (!value) {
    return null;
  }
  if (value.contents) {
    return value.contents;
  }
  if (value.data) {
    return value.data;
  }
  return value;
}
function saveByteLength(value) {
  var bytes = bytesFromSaveValue(value);
  if (!bytes) {
    return 0;
  }
  return bytes.byteLength || bytes.length || 0;
}
function profileRequestBody(type, extra) {
  var body = {
    user: localStorage.getItem('user'),
    pass: localStorage.getItem('pass'),
    type: type
  };
  return Object.assign(body, extra || {});
}
function isProfileSavePath(fileName) {
  return /^states\/.+\/.+/i.test(fileName) || /^saves\/.+\/.+/i.test(fileName);
}
function profileSaveType(fileName) {
  if (/^states\//i.test(fileName)) {
    return /\.auto$/i.test(fileName) ? 'Auto Save State' : 'Save State';
  }
  return 'In-game Save';
}
function profileSaveSource(fileName) {
  var parts = String(fileName || '').split('/');
  return 'Profile: ' + (parts[0] || 'saves') + (parts[1] ? '/' + parts[1] : '');
}
function isHistoryProfileSavePath(fileName) {
  return /^\.history\/[^/]+\/(states|saves)\/.+\/.+/i.test(fileName);
}
function historyRelativeSavePath(fileName) {
  return String(fileName || '').replace(/^\.history\/[^/]+\//i, '');
}
function historyVersionLabel(fileName) {
  var match = String(fileName || '').match(/^\.history\/([^/]+)\//i);
  return match ? match[1] : 'Local backup';
}
async function buildLocalProfileSaveInventory() {
  try {
    await setupProfileFs();
    var files = [];
    async function walk(dirPath) {
      if (!profileFs.existsSync(dirPath)) {
        return;
      }
      var items = profileFs.readdirSync(dirPath);
      for (var item of items) {
        var fullPath = (dirPath === '/' ? '' : dirPath) + '/' + item;
        if (profileFs.lstatSync(fullPath).isDirectory()) {
          await walk(fullPath);
        } else {
          files.push(fullPath.replace(/^\//, ''));
        }
      }
    }
    await walk('/');
    var saves = [];
    for (var fileName of files) {
      var localName = fileName;
      var versionLabel = 'Local profile';
      if (isHistoryProfileSavePath(fileName)) {
        localName = historyRelativeSavePath(fileName);
        versionLabel = historyVersionLabel(fileName);
      }
      if (!isProfileSavePath(localName)) {
        continue;
      }
      var bytes = profileFs.readFileSync('/' + fileName);
      var localStat = profileFs.statSync('/' + fileName);
      saves.push({
        id: 'localprofile::' + fileName,
        key: fileName,
        name: safeDecodeDisplayName(localName.split('/').pop()),
        type: profileSaveType(localName),
        source: isHistoryProfileSavePath(fileName) ? 'Local backup: ' + versionLabel : profileSaveSource(localName),
        size: saveByteLength(bytes),
        versionLabel: versionLabel,
        versionSort: localStat && localStat.mtimeMs ? localStat.mtimeMs : Date.now(),
        load: async function(data) {
          return data;
        }.bind(null, bytes)
      });
    }
    return saves;
  } catch(e) {
    console.log('Unable to scan local profile saves', e);
    return [];
  }
}
async function buildProfileSaveInventory() {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return [];
  }
  try {
    var saves = [];
    saves = saves.concat(await buildLocalProfileSaveInventory());
    var response = await profileRequest(profileRequestBody('listprofilesaves'));
    var profile = await response.json();
    if (profile.status !== 'success' || !profile.saves) {
      return saves;
    }
    for (var profileSave of profile.saves) {
      saves.push({
        id: profileSave.id,
        key: profileSave.key || profileSave.pathKey,
        name: profileSave.name,
        type: profileSave.type,
        source: profileSave.source,
        size: profileSave.size || 0,
        versionLabel: profileSave.versionLabel || 'Server current',
        versionSort: profileSave.versionSort || 0,
        pathKey: profileSave.pathKey,
        load: async function(pathKey) {
          var download = await profileRequest(profileRequestBody('downloadprofilesave', {pathKey: pathKey}));
          var json = await download.json();
          if (json.status !== 'success' || !json.data) {
            return null;
          }
          return Uint8Array.from(atob(json.data), function(char) {
            return char.charCodeAt(0);
          });
        }.bind(null, profileSave.pathKey)
      });
    }
    return saves;
  } catch(e) {
    console.log('Unable to scan profile saves', e);
    return [];
  }
}
async function buildSaveInventory() {
  var saves = [];
  saves = saves.concat(await buildProfileSaveInventory());
  var stateKeys = await idbGetKeys('EmulatorJS-states', 'states');
  for (var stateKey of stateKeys) {
    if (!stateKey || stateKey === '?EJS_KEYS!') {
      continue;
    }
    var stateValue = await idbGetValue('EmulatorJS-states', 'states', stateKey);
      saves.push({
        id: 'state::' + stateKey,
        key: stateKey,
        name: safeDecodeDisplayName(stateKey),
        type: 'Save State',
        source: 'EmulatorJS-states',
        versionLabel: 'Local browser',
        versionSort: null,
        size: saveByteLength(stateValue),
      load: async function(key) {
        return bytesFromSaveValue(await idbGetValue('EmulatorJS-states', 'states', key));
      }.bind(null, stateKey)
    });
  }
  var fileKeys = await idbGetKeys('FILE_DATA', 'FILE_DATA');
  for (var fileKey of fileKeys) {
    if (!fileKey || String(fileKey).indexOf('/data/saves/') === -1) {
      continue;
    }
    var fileValue = await idbGetValue('FILE_DATA', 'FILE_DATA', fileKey);
    var fileName = String(fileKey).split('/').pop();
    saves.push({
      id: 'file::' + fileKey,
      key: fileKey,
      name: safeDecodeDisplayName(fileName),
      type: fileName.indexOf('quick.state') !== -1 ? 'Quick Save' : 'In-game Save',
      source: 'RetroArch saves',
      versionLabel: 'Local browser',
      versionSort: null,
      size: saveByteLength(fileValue),
      load: async function(key) {
        return bytesFromSaveValue(await idbGetValue('FILE_DATA', 'FILE_DATA', key));
      }.bind(null, fileKey)
    });
  }
  saves.sort(function(a, b) {
    return (a.name || '').localeCompare(b.name || '');
  });
  saveInventoryCache = saves;
  return saves;
}
async function getSaveInventory(refresh) {
  if (!refresh && saveInventoryCache) {
    return saveInventoryCache;
  }
  if (saveInventoryLoading) {
    return saveInventoryLoading;
  }
  saveInventoryLoading = buildSaveInventory();
  var saves = await saveInventoryLoading;
  saveInventoryLoading = null;
  return saves;
}
function findSaveById(saveId) {
  return (saveInventoryCache || []).find(function(save) {
    return save.id === saveId;
  });
}
async function downloadSaveFile(saveId) {
  var save = findSaveById(saveId);
  if (!save) {
    await getSaveInventory(true);
    save = findSaveById(saveId);
  }
  if (!save) {
    alert('Save not found.');
    return;
  }
  var bytes = await save.load();
  if (!bytes) {
    alert('Unable to read save file.');
    return;
  }
  var blob = new Blob([bytes], {type: 'application/octet-stream'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = save.name || 'game-save.bin';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function setSavePanelBack(handler) {
  savePanelBackHandler = handler || null;
  $('#save-panel-back').toggleClass('hidden', !savePanelBackHandler);
}
function savePanelBack() {
  if (typeof savePanelBackHandler === 'function') {
    savePanelBackHandler();
  }
}
function groupSaveVariants(saves) {
  var groups = {};
  for (var save of saves) {
    var key = saveVariantGroupKey(save);
    if (!groups[key]) {
      groups[key] = {
        key: key,
        name: save.name || save.key || 'Unknown save',
        versions: []
      };
    }
    groups[key].versions.push(save);
  }
  var grouped = Object.keys(groups).map(function(key) {
    groups[key].versions.sort(function(a, b) {
      return Number(b.versionSort || 0) - Number(a.versionSort || 0);
    });
    groups[key].latest = groups[key].versions[0];
    return groups[key];
  });
  grouped.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
  return grouped;
}
function renderSaveVersionRows(target, saves) {
  $(target).empty();
  for (var save of saves) {
    var row = $('<div>').addClass('save-file-row');
    var detail = $('<button>').addClass('search-result').attr('type', 'button');
    detail.append($('<span>').addClass('save-file-title').text(save.name));
    detail.append($('<span>').addClass('save-file-meta').text(saveVersionSummary(save)));
    detail.on('click', function(saveId) {
      return function() {
        downloadSaveFile(saveId);
      };
    }(save.id));
    var download = $('<button>').attr('type', 'button').text('Download');
    download.on('click', function(saveId) {
      return function() {
        downloadSaveFile(saveId);
      };
    }(save.id));
    row.append(detail, download);
    $(target).append(row);
  }
}
function openSaveVersionPicker(group, backHandler) {
  setSavePanelBack(backHandler);
  $('#save-panel').removeClass('hidden');
  $('#save-panel-title').text(safeDecodeDisplayName(group.name) + ' Versions');
  $('#save-panel-status').text(group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's') + ' available');
  $('#save-panel-results').empty();
  if (group.versions.length > 1) {
    var allButton = $('<button>').attr('type', 'button').text('Download All Versions');
    allButton.on('click', function() {
      downloadSaveList(group.versions.map(function(save) { return save.id; }), saveBasename(group.name) + '-versions.zip');
    });
    $('#save-panel-results').append(allButton);
  }
  renderSaveVersionRows('#save-panel-results', group.versions);
}
async function downloadSaveList(saveIds, fileName) {
  var zip = new JSZip();
  for (var saveId of saveIds) {
    var save = findSaveById(saveId);
    if (!save) {
      continue;
    }
    var bytes = await save.load();
    if (bytes) {
      var folder = (save.type || 'Save') + '/' + (save.versionLabel || save.source || 'Version').replace(/[\\/:*?"<>|]+/g, '-');
      zip.file(folder + '/' + (save.name || save.key), bytes);
    }
  }
  var blob = await zip.generateAsync({type:'blob'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'emulatorjs-saves.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function downloadAllSaves() {
  var saves = await getSaveInventory(true);
  if (saves.length === 0) {
    alert('No saves found.');
    return;
  }
  await downloadSaveList(saves.map(function(save) { return save.id; }), 'emulatorjs-saves.zip');
}
function renderSaveRows(target, saves, emptyMessage, backHandler) {
  $(target).empty();
  if (saves.length === 0) {
    $(target).append($('<div>').addClass('search-status').text(emptyMessage || 'No saves found.'));
    return;
  }
  var groups = groupSaveVariants(saves);
  for (var group of groups) {
    var row = $('<div>').addClass('save-file-row');
    var detail = $('<button>').addClass('search-result').attr('type', 'button');
    detail.append($('<span>').addClass('save-file-title').text(safeDecodeDisplayName(group.name)));
    detail.append($('<span>').addClass('save-file-meta').text(groupedSaveSummary(group)));
    detail.on('click', function(saveGroup) {
      return function() {
        openSaveVersionPicker(saveGroup, backHandler);
      };
    }(group));
    var download = $('<button>').attr('type', 'button').text(group.versions.length > 1 ? 'Versions' : 'Download');
    download.on('click', function(saveGroup) {
      return function() {
        openSaveVersionPicker(saveGroup, backHandler);
      };
    }(group));
    row.append(detail, download);
    $(target).append(row);
  }
}
function closeSavePanel() {
  setSavePanelBack(null);
  $('#save-panel').addClass('hidden');
}
async function openGameSaves(event, gameName, gameBase) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  $('#save-panel-title').text('Saves for ' + safeDecodeDisplayName(gameName));
  $('#save-panel-status').text('Loading saves...');
  $('#save-panel-results').empty();
  $('#save-panel').removeClass('hidden');
  setSavePanelBack(null);
  var saves = (await getSaveInventory(true)).filter(function(save) {
    return saveRecordMatchesGame(save, gameBase);
  });
  $('#save-panel-status').text(saves.length + ' save' + (saves.length === 1 ? '' : 's') + ' found');
  renderSaveRows('#save-panel-results', saves, 'No local saves found for this game yet.', function() {
    openGameSaves(null, gameName, gameBase);
  });
  if (saves.length > 1) {
    var allButton = $('<button>').attr('type', 'button').text('Download All for This Game');
    allButton.on('click', function() {
      downloadSaveList(saves.map(function(save) { return save.id; }), saveBasename(gameName) + '-saves.zip');
    });
    $('#save-panel-results').prepend(allButton);
  }
}
async function renderProfileSaves() {
  $('#profile-saves-status').text('Scanning local saves...');
  $('#profile-saves-results').empty();
  var saves = await getSaveInventory(true);
  $('#profile-saves-status').text(saves.length + ' save' + (saves.length === 1 ? '' : 's') + ' found');
  renderSaveRows('#profile-saves-results', saves, 'No local saves found yet.', function() {
    closeSavePanel();
    showProfileTab('saves');
  });
}
function showProfileTab(tab) {
  var showSaves = tab === 'saves';
  $('#profile-tab-profile').toggleClass('is-active', !showSaves);
  $('#profile-tab-saves').toggleClass('is-active', showSaves);
  $('#profile-tab-panel-profile').toggleClass('hidden', showSaves);
  $('#profile-tab-panel-saves').toggleClass('hidden', !showSaves);
  if (showSaves) {
    renderProfileSaves();
  }
}
function setProfileStatus(message) {
  $('#profile-status').text(message || '');
}
async function forgotProfilePassword() {
  var user = $('#profile-user').val() || localStorage.getItem('user') || '';
  if (!user) {
    setProfileStatus('Enter your username first.');
    $('#profile-user').trigger('focus');
    return;
  }
  setProfileStatus('Notifying admin...');
  try {
    var res = await profileRequest({type:'forgotpassword', user:user, source:'frontend'});
    var json = await res.json();
    setProfileStatus(json.status == 'success' ? 'The admin has been notified.' : 'Password reset notification is not configured.');
  } catch(e) {
    console.log(e);
    setProfileStatus('Unable to notify admin.');
  }
}
async function changeProfilePassword() {
  var oldPass = $('#profile-old-pass').val();
  var newPass = $('#profile-new-pass').val();
  if (!newPass) {
    setProfileStatus('Enter a new password.');
    return;
  }
  setProfileStatus('Updating password...');
  try {
    var res = await profileRequest(profileRequestBody('changepassword', {oldPass: oldPass, newPass: newPass}));
    var json = await res.json();
    if (json.status == 'success') {
      localStorage.setItem('pass', newPass);
      $('#profile-old-pass').val('');
      $('#profile-new-pass').val('');
      setProfileStatus('Password updated.');
    } else {
      setProfileStatus('Password update failed.');
    }
  } catch(e) {
    console.log(e);
    setProfileStatus('Password update failed.');
  }
}
function updateLoginState() {
  var user = localStorage.getItem('user');
  var role = localStorage.getItem('role') || 'user';
  if (user && localStorage.getItem('pass')) {
    $('#login-button').text(user);
    $('#profile-panel-title').text('Profile');
    $('#profile-name').text('Logged in as ' + user + ' (' + role + ')');
    $('#profile-logged-out').addClass('hidden');
    $('#profile-logged-in').removeClass('hidden');
    $('body').removeClass('profile-required');
    if (role == 'admin') {
      $('#file-browser-link').removeClass('hidden');
    } else {
      $('#file-browser-link').addClass('hidden');
    }
    scheduleProfileAutoPush();
  } else {
    $('#login-button').text('Login');
    $('#profile-panel-title').text(requireMainLogin ? 'Login' : 'Profile');
    $('#profile-name').empty();
    $('#profile-logged-in').addClass('hidden');
    $('#profile-logged-out').removeClass('hidden');
    $('#file-browser-link').addClass('hidden');
    if (requireMainLogin) {
      $('body').addClass('profile-required');
      $('#login-panel').removeClass('hidden');
      setProfileStatus('Login required.');
    }
  }
}
function openLoginPanel() {
  closeSearchPanel();
  closeFavoritesPanel();
  closeSavePanel();
  $('#login-panel').removeClass('hidden');
  updateLoginState();
}
function closeLoginPanel() {
  if (requireMainLogin && !localStorage.getItem('user')) {
    return;
  }
  $('#login-panel').addClass('hidden');
}
async function profileLogin() {
  var user = $('#profile-user').val();
  var pass = $('#profile-pass').val();
  $('#profile-pass').val('');
  setProfileStatus('Logging in...');
  try {
    var res = await profileRequest({user:user, pass:pass, type:'login'});
    var json = await res.json();
    if (json.status == 'success') {
      localStorage.setItem('user', json.user);
      localStorage.setItem('pass', pass);
      localStorage.setItem('role', json.role || 'user');
      $('#profile-user').val('');
      updateLoginState();
      await pullServerProfile(true);
      window.location.reload();
    } else {
      setProfileStatus('Bad login.');
    }
  } catch(e) {
    console.log(e);
    setProfileStatus('Login failed.');
  }
}
async function verifyStoredProfileLogin() {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    updateLoginState();
    return;
  }
  try {
    var res = await profileRequest({user:localStorage.getItem('user'), pass:localStorage.getItem('pass'), type:'login'});
    var json = await res.json();
    if (json.status == 'success') {
      localStorage.setItem('user', json.user);
      localStorage.setItem('role', json.role || 'user');
    } else {
      localStorage.removeItem('user');
      localStorage.removeItem('pass');
      localStorage.removeItem('role');
    }
  } catch(e) {
    console.log(e);
  }
  updateLoginState();
}
function profileLogout() {
  localStorage.removeItem('user');
  localStorage.removeItem('pass');
  localStorage.removeItem('role');
  updateLoginState();
  setProfileStatus('Logged out.');
}

async function loadPublicSettings() {
  try {
    var res = await profileRequest({type:'publicsettings'});
    var json = await res.json();
    requireMainLogin = json.status == 'success' && json.requireLogin === true;
  } catch(e) {
    console.log(e);
  }
  await verifyStoredProfileLogin();
}
function setupProfileFs() {
  if (profileFsReady) {
    return profileFsReady;
  }
  profileFsReady = new Promise(function(resolve, reject) {
    try {
      if (!window.BrowserFS || !window.JSZip) {
        resolve(false);
        return;
      }
      BrowserFS.install(window);
      var nodeFs = require('fs');
      var mfs = new BrowserFS.FileSystem.MountableFileSystem();
      var imfs = new BrowserFS.FileSystem.InMemory();
      var afs = new BrowserFS.FileSystem.AsyncMirror(imfs, new BrowserFS.FileSystem.IndexedDB(function(e) {
        if (e) {
          reject(e);
          return;
        }
        afs.initialize(function(initError) {
          if (initError) {
            reject(initError);
            return;
          }
          mfs.mount('/', afs);
          BrowserFS.initialize(mfs);
          profileFs = nodeFs;
          resolve(true);
        });
      }, profileStoreName));
    } catch(e) {
      reject(e);
    }
  });
  return profileFsReady;
}
async function rmProfileDir(dirPath) {
  try {
    var files = profileFs.readdirSync(dirPath);
    if (files.length > 0) {
      for await (var file of files) {
        var filePath = dirPath + '/' + file;
        if (profileFs.statSync(filePath).isFile()) {
          profileFs.unlinkSync(filePath);
        } else {
          await rmProfileDir(filePath);
        }
      }
    }
    if (dirPath !== '/') {
      profileFs.rmdirSync(dirPath);
    }
  } catch(e) {
    console.log(e);
  }
}
function ensureProfileDirSync(dirPath) {
  if (!dirPath || dirPath === '/' || profileFs.existsSync(dirPath)) {
    return;
  }
  var parent = dirPath.split('/').slice(0, -1).join('/') || '/';
  if (parent !== dirPath) {
    ensureProfileDirSync(parent);
  }
  if (!profileFs.existsSync(dirPath)) {
    profileFs.mkdirSync(dirPath);
  }
}
function localProfileBackupPath(relativePath, stamp) {
  return '/.history/' + stamp + '/' + String(relativePath || '').replace(/^\/+/, '');
}
async function writeProfileFileWithBackup(relativePath, buffer, stamp) {
  var targetPath = '/' + String(relativePath || '').replace(/^\/+/, '');
  var parent = targetPath.split('/').slice(0, -1).join('/') || '/';
  ensureProfileDirSync(parent);
  if (profileFs.existsSync(targetPath)) {
    var existing = profileFs.readFileSync(targetPath);
    if (Buffer.from(existing).equals(Buffer.from(buffer))) {
      return;
    }
    var backupPath = localProfileBackupPath(relativePath, stamp);
    var backupParent = backupPath.split('/').slice(0, -1).join('/') || '/';
    ensureProfileDirSync(backupParent);
    profileFs.writeFileSync(backupPath, Buffer.from(existing));
  }
  profileFs.writeFileSync(targetPath, Buffer.from(buffer));
}
async function addProfileFsToZip(zip, item) {
  if (item === '/.history' || item.indexOf('/.history/') === 0) {
    return;
  }
  if (profileFs.lstatSync(item).isDirectory()) {
    var items = profileFs.readdirSync(item);
    if (items.length > 0) {
      for await (var subPath of items) {
        await addProfileFsToZip(zip, item + '/' + subPath);
      }
    }
  } else {
    var data = profileFs.readFileSync(item);
    var zipPath = item.replace(/^\//,'');
    zip.file(zipPath, data);
  }
}
async function pullServerProfile(silent) {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    setProfileStatus('Login first.');
    return;
  }
  setProfileStatus('Pulling from server...');
  try {
    await setupProfileFs();
    var res = await profileRequest({user:localStorage.getItem('user'), pass:localStorage.getItem('pass'), type:'pull'});
    var json = await res.json();
    if (json.status !== 'success') {
      setProfileStatus('Error pulling profile.');
      return;
    }
    var zip = new JSZip();
    var contents = await zip.loadAsync(json.data, {base64: true});
    var pullStamp = Date.now().toString();
    for await (var fileName of Object.keys(contents.files)) {
      if (fileName.endsWith('/') && fileName !== favoritesProfileFile) {
        ensureProfileDirSync('/' + fileName.replace(/\/+$/, ''));
      }
    }
    for await (var pullFileName of Object.keys(contents.files)) {
      if (!pullFileName.endsWith('/')) {
        if (pullFileName === favoritesProfileFile) {
          restoreFavoritesFromProfile(await zip.file(pullFileName).async('string'));
        } else {
          var content = await zip.file(pullFileName).async('arraybuffer');
          await writeProfileFileWithBackup(pullFileName, Buffer.from(content), pullStamp);
        }
      }
    }
    setProfileStatus('Pulled from server.');
    if (!$('#favorites-panel').hasClass('hidden')) {
      renderFavoritesPanel();
    }
    if (!silent) {
      alert('Pulled from server');
      window.location.reload();
    }
  } catch(e) {
    console.log(e);
    setProfileStatus('Error pulling profile.');
  }
}
async function pushServerProfile(silent) {
  if (profilePushInFlight || !localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  if (silent && window.location.hash !== '#game' && document.visibilityState === 'visible') {
    return;
  }
  profilePushInFlight = true;
  setProfileStatus('Pushing to server...');
  try {
    await setupProfileFs();
    var zip = new JSZip();
    var items = profileFs.readdirSync('/');
    for await (var item of items) {
      await addProfileFsToZip(zip, '/' + item);
    }
    zip.file(favoritesProfileFile, localStorage.getItem('ejsFavorites') || '[]');
    var base64 = await zip.generateAsync({type:"base64"});
    var res = await profileRequest({user:localStorage.getItem('user'), pass:localStorage.getItem('pass'), type:'push', data:base64});
    var json = await res.json();
    setProfileStatus(json.status == 'success' ? 'Pushed to server.' : 'Error pushing profile.');
    if (!silent && json.status == 'success') {
      alert('Pushed to server');
      window.location.reload();
    }
  } catch(e) {
    console.log(e);
    setProfileStatus('Error pushing profile.');
  }
  profilePushInFlight = false;
}
function queueProfilePush() {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  if (window.location.hash !== '#game' && document.visibilityState === 'visible') {
    setProfileStatus('Saved locally. Use Push to Server to sync now.');
    return;
  }
  clearTimeout(profilePushTimeout);
  profilePushTimeout = setTimeout(function() {
    pushServerProfile(true);
  }, 2000);
}
function scheduleProfileAutoPush() {
  if (profilePushTimer || !localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  profilePushTimer = setInterval(function() {
    if (window.location.hash === '#game' || document.visibilityState === 'hidden') {
      pushServerProfile(true);
    }
  }, 300000);
}
function readFavoriteRecord(button, favoriteId) {
  var $button = $(button);
  return {
    id: favoriteId,
    name: cleanGameName($button.attr('data-favorite-name'), favoriteId),
    root: $button.attr('data-favorite-root') || 'main',
    title: $button.attr('data-favorite-title') || 'Games',
    index: Number($button.attr('data-favorite-index') || 0)
  };
}
function isFavorite(favoriteId) {
  return getFavoriteIds().indexOf(favoriteId) !== -1;
}
function setFavoriteButtonState(favoriteId) {
  $('.favorite-toggle').filter(function() {
    return this.dataset.favoriteId === favoriteId;
  }).each(function() {
    var active = isFavorite(favoriteId);
    $(this).toggleClass('is-favorite', active);
    $(this).attr('aria-pressed', active);
    $(this).attr('title', active ? 'Remove from favorites' : 'Add to favorites');
  });
}
function setSaveButtonState(saveBase, hasSaves) {
  $('.save-toggle').filter(function() {
    return this.dataset.saveBase === saveBase;
  }).each(function() {
    $(this).toggleClass('hidden', !hasSaves);
    $(this).toggleClass('has-saves', hasSaves);
    $(this).attr('title', hasSaves ? 'Download saves' : 'No local saves found');
  });
}
async function refreshSaveIndicators() {
  var saves = await getSaveInventory(false);
  $('.save-toggle').each(function() {
    var saveBase = this.dataset.saveBase;
    var hasSaves = saves.some(function(save) {
      return saveRecordMatchesGame(save, saveBase);
    });
    setSaveButtonState(saveBase, hasSaves);
  });
}
function toggleFavorite(event, favoriteId, button) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!favoriteId || favoriteId === 'undefined') {
    return;
  }
  var favorites = getFavorites();
  var favoriteIds = favorites.map(function(favorite) {
    return favorite.id;
  });
  var index = favoriteIds.indexOf(favoriteId);
  if (index === -1) {
    favorites.push(readFavoriteRecord(button, favoriteId));
  } else {
    favorites.splice(index, 1);
  }
  saveFavorites(favorites);
  setFavoriteButtonState(favoriteId);
  if (!$('#search-panel').hasClass('hidden')) {
    runGameSearch();
  }
  if (!$('#favorites-panel').hasClass('hidden')) {
    renderFavoritesPanel();
  }
  queueProfilePush();
}
function downloadRom(event, button) {
  event.preventDefault();
  event.stopPropagation();
  var url = 'user/' + button.getAttribute('data-rom-path') + '/roms/' + button.getAttribute('data-rom-name') + button.getAttribute('data-rom-extension');
  var a = document.createElement('a');
  a.href = encodeURI(url);
  a.download = button.getAttribute('data-rom-name') + button.getAttribute('data-rom-extension');
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function openSearchPanel() {
  closeFavoritesPanel();
  closeSavePanel();
  $('#search-panel').removeClass('hidden');
  ensureSearchCatalog().then(function() {
    runGameSearch();
  });
  setTimeout(function() {
    $('#game-search').trigger('focus');
  }, 0);
}
function closeSearchPanel() {
  $('#search-panel').addClass('hidden');
}
function closeFavoritesPanel() {
  $('#favorites-panel').addClass('hidden');
}
function toggleAdvancedSearch() {
  $('#advanced-search').toggleClass('hidden');
}
function clearGameSearch() {
  $('#game-search').val('');
  $('#console-filter').val('all');
  $('#art-filter').val('all');
  $('#favorites-filter').prop('checked', false);
  runGameSearch();
}
function showFavorites() {
  closeSearchPanel();
  closeSavePanel();
  $('#favorites-panel').removeClass('hidden');
  $('#favorites-status').text('Loading favorites...');
  $('#favorites-results').empty();
  ensureSearchCatalog().then(function() {
    renderFavoritesPanel();
  });
}
function renderFavoritesPanel() {
  if (!searchCatalog) {
    $('#favorites-status').text('Loading favorites...');
    return;
  }
  var favorites = getFavorites();
  var favoriteItems = favorites.map(function(favorite) {
    var catalogMatch = searchCatalog.items.find(function(item) {
      return item.id === favorite.id;
    });
    return catalogMatch || favorite;
  }).filter(function(favorite) {
    return favorite && favorite.id;
  });
  $('#favorites-results').empty();
  if (favoriteItems.length === 0) {
    $('#favorites-status').text('No favorites yet. Use the heart beside a game to add one.');
    return;
  }
  $('#favorites-status').text(favoriteItems.length + ' favorite' + (favoriteItems.length === 1 ? '' : 's'));
  for (var item of favoriteItems) {
    var row = $('<div>').addClass('favorite-result-row');
    var root = item.root || 'main';
    var index = Number(item.index || 0);
    var openButton = $('<button>').addClass('search-result').attr('type', 'button').attr('onclick', 'openFavoriteResult("' + root + '",' + index + ')');
    openButton.append($('<span>').addClass('search-result-title').html('&hearts; ' + escapeHtml(cleanGameName(item.name, item.id))));
    openButton.append($('<span>').addClass('search-result-meta').text(item.title || item.root || 'Games'));
    var removeButton = $('<button>').addClass('favorite-remove').attr('type', 'button').attr('title', 'Remove from favorites').text('Remove');
    removeButton.on('click', function(favoriteId) {
      return function(event) {
        toggleFavorite(event, favoriteId);
      };
    }(item.id));
    row.append(openButton, removeButton);
    $('#favorites-results').append(row);
  }
}
function resolveItem(item, defaults) {
  var resolved = {};
  for (var key of defaultKeys) {
    if (item.hasOwnProperty(key)) {
      resolved[key] = item[key];
    } else {
      resolved[key] = defaults[key];
    }
  }
  return resolved;
}
async function fetchConfig(name) {
  if (searchSourceConfigs[name]) {
    return searchSourceConfigs[name];
  }
  var response = await fetchFreshJson('user/config/' + name + '.json');
  var data = await response.json();
  searchSourceConfigs[name] = data;
  return data;
}
async function ensureSearchCatalog() {
  if (searchCatalog) {
    return searchCatalog;
  }
  if (searchCatalogLoading) {
    return searchCatalogLoading;
  }
  searchCatalogLoading = buildSearchCatalog();
  searchCatalog = await searchCatalogLoading;
  populateConsoleFilter(searchCatalog.consoles);
  return searchCatalog;
}
async function buildSearchCatalog() {
  var catalog = [];
  var consoles = [];
  var mainConfig = searchSourceConfigs.main || $('#menu').data('config') || await fetchConfig('main');
  searchSourceConfigs.main = mainConfig;
  for await (var consoleRoot of Object.keys(mainConfig.items)) {
    try {
      var consoleConfig = await fetchConfig(consoleRoot);
      var defaults = consoleConfig.defaults || {};
      var consoleTitle = consoleConfig.title || consoleRoot;
      consoles.push({root: consoleRoot, title: consoleTitle});
      var index = 0;
      for await (var name of Object.keys(consoleConfig.items)) {
        var item = consoleConfig.items[name];
        if ((item.hasOwnProperty('cloneof')) && (consoleConfig.items.hasOwnProperty(item.cloneof))) {
          continue;
        }
        var resolved = resolveItem(item, defaults);
        if (resolved.type !== 'game') {
          index++;
          continue;
        }
        catalog.push({
          id: resolved.path + '::' + name,
          name: name,
          root: consoleRoot,
          title: consoleTitle,
          index: index,
          path: resolved.path,
          hasLogo: resolved.has_logo === true || resolved.has_logo === 'true',
          hasVideo: resolved.has_video === true || resolved.has_video === 'true',
          multiDisc: Number(resolved.multi_disc || 0),
          extension: resolved.rom_extension || ''
        });
        index++;
      }
    } catch(e) {
      console.log('Unable to index config', consoleRoot, e);
    }
  }
  return {items: catalog, consoles: consoles};
}
function populateConsoleFilter(consoles) {
  var currentValue = $('#console-filter').val() || 'all';
  $('#console-filter').empty();
  $('#console-filter').append($('<option>').attr('value', 'all').text('All consoles'));
  for (var consoleInfo of consoles) {
    $('#console-filter').append($('<option>').attr('value', consoleInfo.root).text(consoleInfo.title));
  }
  $('#console-filter').val(currentValue);
}
function runGameSearch() {
  if (!searchCatalog) {
    $('#search-status').text('Indexing games...');
    return;
  }
  var query = ($('#game-search').val() || '').toLowerCase().trim();
  var consoleFilter = $('#console-filter').val() || 'all';
  var artFilter = $('#art-filter').val() || 'all';
  var favoritesOnly = $('#favorites-filter').prop('checked');
  var favorites = getFavoriteIds();
  var results = searchCatalog.items.filter(function(item) {
    if (query && item.name.toLowerCase().indexOf(query) === -1) {
      return false;
    }
    if (consoleFilter !== 'all' && item.root !== consoleFilter) {
      return false;
    }
    if (favoritesOnly && favorites.indexOf(item.id) === -1) {
      return false;
    }
    if (artFilter === 'has-logo' && !item.hasLogo) {
      return false;
    }
    if (artFilter === 'missing-logo' && item.hasLogo) {
      return false;
    }
    if (artFilter === 'has-video' && !item.hasVideo) {
      return false;
    }
    if (artFilter === 'missing-video' && item.hasVideo) {
      return false;
    }
    return true;
  }).slice(0, 80);
  renderSearchResults(results, query, favoritesOnly);
}
function renderSearchResults(results, query, favoritesOnly) {
  $('#search-results').empty();
  if (!query && !favoritesOnly && ($('#console-filter').val() || 'all') === 'all' && ($('#art-filter').val() || 'all') === 'all') {
    $('#search-status').text('Type a title, choose a console, or open favorites.');
    return;
  }
  $('#search-status').text(results.length + ' result' + (results.length === 1 ? '' : 's') + ' shown');
  if (results.length === 0) {
    $('#search-results').append($('<div>').addClass('search-status').text('No matches yet.'));
    return;
  }
  for (var item of results) {
    var favorite = isFavorite(item.id);
    var result = $('<button>').addClass('search-result').attr('type', 'button').attr('onclick', 'openSearchResult("' + item.root + '",' + item.index + ')');
    result.append($('<span>').addClass('search-result-title').html((favorite ? '&hearts; ' : '') + escapeHtml(item.name)));
    var meta = item.title;
    if (!item.hasLogo) {
      meta += ' - missing logo';
    }
    if (!item.hasVideo) {
      meta += ' - missing video';
    }
    if (item.multiDisc > 1) {
      meta += ' - ' + item.multiDisc + ' discs';
    }
    result.append($('<span>').addClass('search-result-meta').text(meta));
    $('#search-results').append(result);
  }
}
function openSearchResult(root, index) {
  closeSearchPanel();
  var target = '#' + root + '---' + index;
  if (window.location.hash === target) {
    loadjson(root, index);
  } else {
    window.location.href = target;
  }
}
function openFavoriteResult(root, index) {
  closeFavoritesPanel();
  openSearchResult(root, index);
}
function clearConsoleListFilter() {
  $('#console-list-search').val('').trigger('input');
}
function goBackToMain() {
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeSavePanel();
  $('#console-list-search').val('');
  if (window.location.hash === '#main') {
    loadjson('main');
  } else {
    window.location.href = '#main';
  }
}
function updateConsoleBackButton(root, data) {
  var showBack = root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name));
  $('#console-back-button').toggleClass('hidden', !showBack);
}
// Load and play video
var loadvideo = debounce(function(active_item) {
  var name = $('#i' + active_item.toString()).data('name');
  var has_video = $('#i' + active_item.toString()).data('has_video');
  var video_position = $('#i' + active_item.toString()).data('video_position');
  var video_src;
  if (has_video) {
    var video_path = 'user/' + $('#i' + active_item.toString()).data('path') + '/videos/';
    video_src = video_path + name + '.mp4';
  } else {
    video_src = 'user/main/videos/default.mp4';
  }
  $('#bgvid').attr('style', 'position:fixed;object-fit:fill;' + (video_position || ''));
  var oldvid = $('#vid').attr('src');
  if (typeof oldvid !== 'undefined' && oldvid !== false) {
    $('#bgvid').trigger('pause');
  }
  $('#vid').attr('src', video_src);
  $('#bgvid').trigger('load');
  $('#bgvid').trigger('play');
}, 200);
// Apply background art
var loadart = debounce(function(active_item) {
  var name = $('#i' + active_item.toString()).data('name');
  var has_back = $('#i' + active_item.toString()).data('has_back');
  var has_corner = $('#i' + active_item.toString()).data('has_corner');
  var back_name = name;
  var corner_name = name;
  if (has_back !== true) {
    var back_name = 'default';
  };
  if (has_corner !== true) {
    var corner_name = 'default';
  };
  var path = 'user/' + $('#i' + active_item.toString()).data('path') + '/';
  var back_src = path + 'backgrounds/' + back_name + '.png'
  var corner_src = path + 'corners/' + corner_name + '.png'
  $('#background').attr("src", back_src);
  $('#corner').attr("src", corner_src);
}, 200);
// Load logo list
function loadlogos(logo_load_start, display_items, items_length, active_item) {
  for (var i = 0; i < display_items; i++) {
    var item_num = logo_load_start;
    if (items_length >= 0) {
      item_num = ((item_num % (items_length + 1)) + (items_length + 1)) % (items_length + 1);
    }
    var itemLink = $('#i' + item_num.toString());
    var has_logo = itemLink.data('has_logo');
    var name = itemLink.data('name');
    var path = 'user/' + itemLink.data('path') + '/logos/';
    var logo_src = encodeURI(path + name + '.png');
    if (has_logo) {
      $(itemLink.children()[0]).attr('src', logo_src);
      $('#active' + i).empty();
      $('#active' + i).append($('#m' + item_num).html());
      $('#active' + i).find('img.menu-img').attr('src', logo_src);
    } else {
      $('#active' + i).empty();
      $('#active' + i).append($('#m' + item_num).html());
    }
    logo_load_start++;
  }
}
// Launcher
function launch(active_item) {
  var selected = active_item && active_item.nodeType ? $(active_item) : $('#i' + active_item.toString()).first();
  var selectedIndex = selected.attr('id') ? Number(selected.attr('id').replace('i', '')) : Number(active_item);
  var name = selected.data('name');
  var type = selected.data('type');
  var multi = selected.data('multi_disc');
  var root = $('#menu').data('root');
  var originalActiveItem = Number(selected.attr('data-original-index') || selectedIndex);
  $(document).attr('title', name);
  if (type == 'menu') {
    window.location.href = '#' + name
  } else if (multi > 1) {
    var config = $('#menu').data('config');
    config.display_items = multi;
    config.parent = config.root + '---' + originalActiveItem.toString();
    config.multi_name = name;
    var baseItem = config.items[name];
    config.items = {};
    for (let count = 1; count <= multi; count++) {
      config.items['Disc ' + count.toString()] = {};
      Object.assign(config.items['Disc ' + count.toString()], baseItem);
      config.items['Disc ' + count.toString()].rom_extension = '.disk' + count.toString();
      config.items['Disc ' + count.toString()].has_logo = false;
      config.items['Disc ' + count.toString()].has_video = false;
      config.items['Disc ' + count.toString()].multi_disc = 0;
    };
    rendermenu([config, 0]);
  } else if (type == 'game') {
    scheduleProfileAutoPush();
    // Disable keyevents and hash watching
    window.exit = false;
    $(window).off('hashchange');
    $(window).off('orientationchange');
    window.location.href = '#game';
    $(document).off('keydown');
    // Default variables for emulator
    var emulator = selected.data('emulator');
    if (emulator.startsWith('libretro-')) {
      var emulator = emulator.replace('libretro-','');
      var script = 'js/libretro.js'
      var EJSemu = false;
      EJS_onGameStart = function() {
        gameStarted = true;
        let gps = navigator.getGamepads();
        if (gps) {
          for (let gp of gps) {
            if (gp) {
              let gpEvt = new GamepadEvent("gamepadconnected",{gamepad: gp});
              window.dispatchEvent(gpEvt);
            }
          }
        }
      }
    } else {
      var script = 'data/loader.js'
      var EJSemu = true;
      EJS_onGameStart = function() {
        gameStarted = true;
        document.querySelectorAll('[data-btn="fullscreen"]')[0].click();
      }
    };
    var path =  selected.data('path');
    var rom_path = 'user/' + path + '/roms/';
    var rom_extension = selected.data('rom_extension');
    var gameSaveName = name + rom_extension;
    var bios = 'user/' + path + '/bios/' + selected.data('bios');
    // Clear screen
    $('body').empty();
    // Add game window
    var gameDiv = $('<div>').attr('id','game');
    $('body').append(gameDiv);
    // Set emulator variables
    if (bios !== 'user/' + path + '/bios/') {
      EJS_biosUrl = bios;
    }
    EJS_player = '#game';
    EJS_gameUrl = encodeURI(rom_path + name + rom_extension);
    EJS_gameName = gameSaveName;
    EJS_core = emulator;
    EJS_pathtodata = 'data/';
    var previousGameStart = EJS_onGameStart;
    EJS_onGameStart = function() {
      if (typeof previousGameStart === 'function') {
        previousGameStart();
      }
      installQuickSaveMirror(gameSaveName);
    };
    // Load touch screen interface
    if ((! EJSemu) && (window.orientation !== undefined) && localStorage.getItem('touchpad') !== 'false' && !navigator.getGamepads()?.[0]) {
      // Determine type to render
      if (localStorage.getItem('touchpad') !== null) {
        if (localStorage.getItem('touchpad') == 'simple') {
          gamePadType = 'simple';
        } else if (localStorage.getItem('touchpad') == 'modern') {
          gamePadType = 'modern';
        }
      } else {
        if ((emulator == 'gearboy') || (emulator == 'fceumm') || (emulator == 'mednafen_vb') || (emulator == 'gambatte') || (emulator == 'stella2014') || (emulator == 'prosystem') || (emulator == 'mednafen_pce_fast')) {
          gamePadType = 'simple';
        } else if ((emulator == 'prboom') || (emulator == 'mednafen_psx') || (emulator == 'tyrquake') || (emulator == 'melonds') || (emulator == 'melonds_threaded')) {
          gamePadType = 'modern';
	} else if (emulator == 'mupen64plus_next') {
          gamePadType = 'n64';
        }
      }
      var touchDiv = $('<div>').attr('id','gamepad');
      $('body').append(touchDiv);
      var touchscript = document.createElement('script');
      touchscript.src = 'js/touchpad.js';
      document.head.append(touchscript);
    }
    // Load in EJS loader
    var loaderscript = document.createElement('script');
    loaderscript.src = script;
    document.head.append(loaderscript);
    // Click play button as soon as it appears
    if (EJSemu) {
      var clickplay = setInterval(() => {
        if (typeof document.getElementsByClassName('ejs--73f9b4e94a7a1fe74e11107d5ab2ef')[0] !== 'undefined') {
          clearInterval(clickplay);
          document.getElementsByClassName('ejs--73f9b4e94a7a1fe74e11107d5ab2ef')[0].click();
        }
      }, 100);
    };
    // Reload window if user clicks back
    $(window).on('hashchange', async function() {
      if (window.location.hash !== '#game') {
        // Make sure games are saved by sleeping for a second before reloading
        window.exit = true;
        if (Module) {
          try {
            Module._cmd_savefiles();
          } catch(e) {
            console.log(e);
          }
        };
        window.dispatchEvent(new Event('beforeunload'));
        setTimeout(function(){
          window.location.href = '#' + root + '---' + originalActiveItem;
          window.location.reload();
	}, 1000);
      }
    });
  }
}

//// Page rendering logic ////
async function rendermenu(datas) {
  var data = datas[0];
  var active_item = datas[1];
  // Set default variables
  var portrait = window.orientation;
  $('#menu').data('config', data);
  var root = data.root;
  $('#menu').data('root', root);
  updateConsoleBackButton(root, data);
  var parent = data.parent;
  var allItems = {};
  var originalIndexByName = {};
  var originalCount = 0;
  for await (var originalName of Object.keys(data.items)) {
    var originalItem = data.items[originalName];
    if ((originalItem.hasOwnProperty('cloneof')) && (data.items.hasOwnProperty(originalItem.cloneof))) {
      continue;
    }
    allItems[originalName] = originalItem;
    originalIndexByName[originalName] = originalCount;
    originalCount++;
  };
  data.items = allItems;
  var items = allItems;
  if (Object.keys(allItems).length == 0) {
    alert('No items to load, please add some games');
    return '';
  };
  var items_length = Object.keys(allItems).length - 1;
  // Determine counts and style based on menu items
  var display_items = data.display_items;
  if (typeof active_item == 'undefined'){
    var active_item = Math.floor(display_items/2);
  };
  var image_height = Math.floor(100/display_items).toString() + 'vh';
  var visible_items = display_items;
  // Render zoom effect on active item
  function highlight(active_item) {
    if (portrait !== 0) {
      $('#h' + active_item).addClass('grow')
    } else {
      $('#h' + active_item).addClass('grow-mobile')
    };
  }
  // Set page title
  $(document).attr('title', data.title);
  // Empty any existing
  $('#games-list').empty();
  $('#active-list').empty();
  // Determine CSS to use
  if (portrait !== 0) {
    var shrink = 'shrink';
  } else {
    var shrink = 'shrink-mobile';
  };
  var jumpIndex = {};
  var letters = "abcdefghijklmnopqrstuvwxyz".split("");
  var filteredNames = Object.keys(allItems);
  function renderConsoleFilterState(totalCount, filteredCount, query) {
    var showFilter = root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name));
    $('#console-list-tools').toggleClass('hidden', !showFilter);
    $('#menu').toggleClass('console-filter-active', showFilter);
    if (!showFilter) {
      $('#console-list-search').val('');
      $('#console-list-status').empty();
      return;
    }
    if (query) {
      $('#console-list-status').text(filteredCount + ' of ' + totalCount + ' shown');
    } else {
      $('#console-list-status').text(totalCount + ' games');
    }
  }
  function buildMenuEntry(name, count) {
    var item = data.items[name];
    // Use text or image tag based on logo
    if (item.hasOwnProperty('has_logo')) {
      var has_logo = item.has_logo;
    } else {
      var has_logo = data.defaults.has_logo;
    };
    // Render differently for multi disc menus
    if (data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name)) {
      var romName = data.multi_name;
    } else {
      var romName = name;
    };
    if (has_logo == true) {
      var logo_html = '<img class="menu-img" alt="'+ romName +'" title="'+ romName +'">';
    } else {
      var logo_html = '<p class="menu-img">' + name + '</p>';
    };
    // Set varibles to default if not set in item
    var jsdata = '';
    jsdata += 'data-name="' + romName + '" ';
    jsdata += 'data-original-index="' + originalIndexByName[name] + '" ';
    for (var key of defaultKeys) {
      if (item.hasOwnProperty(key)) {
        jsdata += 'data-' + key + '="' + item[key] + '" ';
      } else {
        jsdata += 'data-' + key + '="' + data.defaults[key] + '" ';
      };
    };
    var itemType = item.hasOwnProperty('type') ? item.type : data.defaults.type;
    var itemPath = item.hasOwnProperty('path') ? item.path : data.defaults.path;
    var itemTitle = data.title || itemPath || 'Games';
    var favoriteName = cleanGameName(romName, itemPath + '::' + name);
    var favoriteId = itemPath + '::' + favoriteName;
    var saveBase = saveBasename(romName + (item.hasOwnProperty('rom_extension') ? item.rom_extension : data.defaults.rom_extension || ''));
    var favoriteButton = '';
    var saveButton = '';
    var romDownloadButton = '';
    if (itemType == 'game') {
      saveButton = '<button class="save-toggle hidden" type="button" data-save-base="' + escapeHtml(saveBase) + '" data-save-name="' + escapeHtml(favoriteName) + '" onclick="openGameSaves(event, this.getAttribute(\'data-save-name\'), this.getAttribute(\'data-save-base\'))" aria-label="Download saves" title="No local saves found">&#128190;</button>';
      romDownloadButton = '<button class="rom-download-toggle" type="button" data-rom-path="' + escapeHtml(itemPath) + '" data-rom-name="' + escapeHtml(romName) + '" data-rom-extension="' + escapeHtml(item.hasOwnProperty('rom_extension') ? item.rom_extension : data.defaults.rom_extension || '') + '" onclick="downloadRom(event, this)" aria-label="Download ROM" title="Download ROM">&#10515;</button>';
      favoriteButton = '<button class="favorite-toggle" type="button" data-favorite-id="' + escapeHtml(favoriteId) + '" data-favorite-name="' + escapeHtml(favoriteName) + '" data-favorite-root="' + escapeHtml(root) + '" data-favorite-title="' + escapeHtml(itemTitle) + '" data-favorite-index="' + originalIndexByName[name] + '" onclick="toggleFavorite(event, this.getAttribute(\'data-favorite-id\'), this)" aria-label="Toggle favorite" title="Add to favorites">&hearts;</button>';
    }
    return '\
      <div id="m' + count + '">\
        <div id="h' + count + '" class="menu-wrap ' + shrink + '">\
          <a onclick="launch(this)" id="i' + count + '" ' + jsdata + '>\
            ' + logo_html + '\
          </a>' + saveButton + romDownloadButton + favoriteButton + '\
        </div>\
      </div>';
  }
  function renderVisibleEntries() {
    $('#games-list').empty();
    var logo_load_start = active_item - Math.floor(visible_items/2);
    var rendered = {};
    for (var slot = 0; slot < visible_items; slot++) {
      var itemIndex = logo_load_start + slot;
      if (items_length >= 0) {
        itemIndex = ((itemIndex % (items_length + 1)) + (items_length + 1)) % (items_length + 1);
      }
      if (itemIndex >= 0 && itemIndex <= items_length && filteredNames[itemIndex] && !rendered[itemIndex]) {
        rendered[itemIndex] = true;
        $('#games-list').append(buildMenuEntry(filteredNames[itemIndex], itemIndex));
      }
    }
    for (var favoriteId of getFavoriteIds()) {
      setFavoriteButtonState(favoriteId);
    }
    refreshSaveIndicators();
    $('.menu-img').css({'max-height': image_height});
    if (portrait !== 0) {
      $('.menu-img').css({'max-width': '30vw'});
    } else {
      $('.menu-img').css({'max-width': '90vw'});
    }
  }
  function renderMenuItems(nextActiveItem) {
    var showFilter = root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name));
    var query = showFilter ? ($('#console-list-search').val() || '').toLowerCase().trim() : '';
    filteredNames = Object.keys(allItems).filter(function(name) {
      return !query || name.toLowerCase().indexOf(query) !== -1;
    });
    items = {};
    for (var filteredName of filteredNames) {
      items[filteredName] = allItems[filteredName];
    }
    data.items = items;
    items_length = filteredNames.length - 1;
    visible_items = Math.min(display_items, filteredNames.length);
    jumpIndex = {};
    $('#games-list').empty();
    $('#active-list').empty();
    renderConsoleFilterState(Object.keys(allItems).length, filteredNames.length, query);
    if (filteredNames.length === 0) {
      active_item = 0;
      $('#active-list').append('<div class="console-empty">No games match "' + escapeHtml($('#console-list-search').val() || '') + '".</div>');
      $('#vid').attr('src', '');
      $('#bgvid').trigger('load');
      return;
    }
    if (typeof nextActiveItem == 'number' && !isNaN(nextActiveItem)) {
      active_item = Math.max(0, Math.min(nextActiveItem, items_length));
    } else if (active_item > items_length) {
      active_item = 0;
    }
    var count = 0;
    for (var name of filteredNames) {
      // Generate an index table based on alphabetical order ignoring numbers
      if (count == 0) {
        jumpIndex['0'] = count;
      } else {
        letterLoop:
        for (let letter of letters) {
          let startLetter = name.charAt(0).toLowerCase();
          if ((! jumpIndex.hasOwnProperty(startLetter)) && (letter == startLetter)) {
            jumpIndex[letter] = count;
            break letterLoop;
          }
        }
      }
      count++;
    };
    // Render active list
    for (var active_num of [...Array(visible_items).keys()]) {
      $('#active-list').append('<div id="active' + active_num + '" class="menu-div"></div>');
    }
    renderVisibleEntries();
    // Render initial
    if (portrait !== 0) {
      $('.menu-img').css({'max-width': '30vw'});
      $('.games-list').css({'width': '40vw'});
      loadart(active_item);
      loadvideo(active_item);
    } else {
      $('.menu-img').css({'max-width': '90vw'});
      $('.games-list').css({'width': '100vw'});
    }
    var logo_load_start = active_item - Math.floor(visible_items/2);
    loadlogos(logo_load_start, visible_items, items_length, active_item);
    $('.menu-div').css({'height': image_height});
    $('.menu-img').css({'max-height': image_height});
    highlight(active_item);
  }
  $('#console-list-search').off('input.consoleFilter').on('input.consoleFilter', debounce(function() {
    renderMenuItems(0);
  }, 120));
  renderMenuItems(Number(active_item));
  // Move items up
  function moveUp(num) {
    if (items_length < 0) {
      return;
    }
    if (! isSafari) {
      $('#bgvid').prop('muted', false);
      $('#bgvid').prop('volume', 0.5);
    }
    if (typeof num == 'number') {
      active_item = (active_item - num);
    } else {
      active_item--
    }
    if (active_item < 0) {
      active_item = items_length;
    }
    var logo_load_start = active_item - Math.floor(visible_items/2);
    renderVisibleEntries();
    loadlogos(logo_load_start, visible_items, items_length, active_item);
    // Background art and video
    if (portrait !== 0) {
      loadart(active_item);
      loadvideo(active_item);
    }
    highlight(active_item);
  };
  // Move items down
  function moveDown(num) {
    if (items_length < 0) {
      return;
    }
    if (! isSafari) {
      $('#bgvid').prop('muted', false);
      $('#bgvid').prop('volume', 0.5);
    }
    if (typeof num == 'number') {
      active_item = (active_item + num);
    } else {
      active_item++
    }
    if (active_item > items_length) {
      active_item = 0;
    }
    var logo_load_start = active_item - Math.floor(visible_items/2);
    renderVisibleEntries();
    loadlogos(logo_load_start, visible_items, items_length, active_item);
    // Background art and video
    if (portrait !== 0) {
      loadart(active_item);
      loadvideo(active_item);
    }
    highlight(active_item);
  };
  // Jump items up
  async function indexUp() {
    for await (index of Object.keys(jumpIndex).reverse()) {
      if (active_item > jumpIndex[index]) {
        let jumpNum = (active_item - jumpIndex[index]);
        moveUp(jumpNum);
        break;
      }
    }
  }
  // Jump items down
  async function indexDown() {
    for await (index of Object.keys(jumpIndex)) {
      if (jumpIndex[index] > active_item) {
        let jumpNum = (jumpIndex[index] - active_item);
        moveDown(jumpNum);
        break;
      }
    }
  }
  // Capture key events for menu navigation
  let upPressed = false;
  let downPressed = false;
  $(document).keydown(function(event) {
    if ($(event.target).is('input, select, textarea')) {
      return;
    }
    // Scroll on keypress
    if (event.key == 'ArrowDown') {
      downPressed = true;
      moveDown();
    }
    if (event.key == 'ArrowUp') {
      upPressed = true;
      moveUp();
    }
    // Scroll faster with diagnols
    if ((event.key == 'ArrowRight') && ((upPressed == false) && (downPressed == true))) {
      moveDown(10);
    }
    if ((event.key == 'ArrowRight') && ((upPressed == true) && (downPressed == false))) {
      moveUp(10);
    }
    // Load item
    if (((event.key == 'ArrowRight') || (event.key == 'Enter')) && ((upPressed == false) && (downPressed == false))) {
      $('#i' + active_item).click();
    }
    // Go to Parent
    if (event.key == 'ArrowLeft') {
      window.location.href = '#' + parent;
    }
    // Jump Down
    if (event.key == 'PageDown') {
      indexDown();
    }
    // Jump Up
    if (event.key == 'PageUp') {
      indexUp();
    }
  });
  // Remove events for multi key presses
  $(document).keyup(function(event) {
    if (event.key == 'ArrowDown') {
      downPressed = false;
    }
    if (event.key == 'ArrowUp') {
      upPressed = false;
    }
  });
  //// Touch controls ////
  // Scroll wheel
  async function scroll(ev) {
    window.scrollKill = false;
    var scrolling = setInterval(() => {
      if (window.scrollKill == false) {
        if (ev.additionalEvent == 'panup') {
          moveDown(5);
        } else if (ev.additionalEvent == 'pandown') {
          moveUp(5);
        } else {
          clearInterval(scrolling);
        };
      } else {
        clearInterval(scrolling);
      };
    }, 50);
  };
  // Stop scrolling 
  function killScroll(ev) {
    window.scrollKill = true;
  };
  var mc = new Hammer(document.getElementById('menu'));
  mc.get('swipe').set({ direction: Hammer.DIRECTION_ALL });
  mc.get('pan').set({ direction: Hammer.DIRECTION_ALL, threshold: 180 });
  mc.on("swipeup", moveDown);
  mc.on("swipedown", moveUp);
  mc.on("panstart", scroll);
  mc.on("panend", killScroll);
  // Render menu on orientation change
  $(window).on('orientationchange',function(){
    window.location.href = '#' + root + '---' + active_item;
    window.location.reload();
  });
  //// Mouse Scrolling ////
  $('#menu').bind('DOMMouseScroll', function(e){
    if(e.originalEvent.detail > 0) {
      moveDown();
    } else {
      moveUp();
    };
    return false;
  });
  $('#menu').bind('mousewheel', function(e){
    if(e.originalEvent.wheelDelta < 0) {
      moveDown();
    } else {
      moveUp();
    };
    return false;
  });
  //// GamePad controls ////
  let scrollDelay
  let animReq
  let homeTimer;
  let home = 0;
  let homePressed = false;
  let gpUpdate;
  function gameLoop() {
    // Handle if buttons are missing
    function buttonsMissing(axes,buttons) {
      var missing = true;
      axes.forEach(function(i) {
        if (typeof gp.axes[i] === 'undefined') {
          missing = false;
        }
      });
      buttons.forEach(function(i) {
        if (typeof gp.buttons[i] === 'undefined') {
          missing = false;
        }
      });
      return missing;
    }
    let gamePads = navigator.getGamepads();
    if (!gamePads?.[0]) return;
    let gp = gamePads[0];
    if (window.location.hash != "#game") {
      gameStarted = false;
      if (!scrollDelay) {
        // Analog down
        if ((buttonsMissing([1,3],[])) && (gp.axes[1] > .5 || gp.axes[3] > .5)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          moveDown();
        // Analog up
        } else if ((buttonsMissing([1,3],[])) && (gp.axes[1] < -.5 || gp.axes[3] < -.5)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          moveUp();
        // D-pad down
        } else if ((buttonsMissing([],[13])) && (gp.buttons[13].pressed)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          moveDown();
        // D-pad up
        } else if ((buttonsMissing([],[12])) && (gp.buttons[12].pressed)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          moveUp();
        // R1 index down
        } else if ((buttonsMissing([],[5])) && (gp.buttons[5].pressed)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          indexDown();
        // L1 index up
        } else if ((buttonsMissing([],[4])) && (gp.buttons[4].pressed)) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          indexUp();
        // Analog L2 scroll up by strength
        } else if ((buttonsMissing([],[6])) && (gp.buttons[6].pressed)) {
          if (gp.buttons[6].value) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, (Math.abs(gp.buttons[6].value - 1) * 200) + 40);
          } else {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 40);
	  }
	  moveUp();
        // Analog R2 scroll down by strength
        } else if ((buttonsMissing([],[7])) && (gp.buttons[7].pressed)) {
          if (gp.buttons[7].value) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, (Math.abs(gp.buttons[7].value - 1) * 200) + 40);
          } else {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 40);
          }
          moveDown();
        }
      }
      if (gp.timestamp == gpUpdate) {
        animReq = requestAnimationFrame(gameLoop);
        return;
      }
      gpUpdate = gp.timestamp
      if (gp.buttons[0].pressed) {
        if ($('#i' + active_item.toString()).data('type') == "game") {
          cancelAnimationFrame(animReq);
        }
        $('#i' + active_item).click();
        return;
      } else if (gp.buttons[1].pressed && parent && '#' + parent != window.location.hash) {
        window.location.href = '#' + parent;
        return;
      } else if ((buttonsMissing([],[16])) && (gp.buttons[16].pressed && window.location.hash != '#main')) {
        window.location.href = '#main';
        return;
      }
    } else {
      if (gp.timestamp == gpUpdate) {
        animReq = requestAnimationFrame(gameLoop);
        return;
      }
      gpUpdate = gp.timestamp
      try {
        if (!gameStarted && gp.buttons[1].pressed && parent) {
          window.location.href = '#' + parent;
          return;
        }
      } catch (e) {
        console.log(e);
      }
      // Press home button 3 times to exit game
      if ((buttonsMissing([],[16])) && (!gp.buttons[16].pressed && homePressed)) {
        home++;
        homePressed = false;
      }
      if ((buttonsMissing([],[16])) && (gp.buttons[16].pressed)) {
        clearTimeout(homeTimer)
        homeTimer = setTimeout(() => home = 0, 500)
        homePressed = true
      }
      if ((buttonsMissing([],[16])) && (gp.buttons[16].pressed && home >= 2)) {
        window.location.href = '#' + parent;
      }
    }
    animReq = requestAnimationFrame(gameLoop);
  }
  window.addEventListener("gamepadconnected", gameLoop)
  window.addEventListener("gamepaddisconnected", cancelAnimationFrame(animReq))
  window.addEventListener("load", () => {
    var gameStarted = false;
    let gps = navigator.getGamepads();
    if (gps) {
      for (let gp of gps) {
        let gpEvt = new GamepadEvent("gamepadconnected", {
          gamepad: gp
        })
        window.dispatchEvent(gpEvt)
      }
    }
  });
  window.addEventListener("hashchange", gameLoop);
}

// Go fullscreen
function fullscreen() {
  let page = document.documentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    if (page.requestFullscreen) {
      page.requestFullscreen();
    } else if (page.webkitRequestFullscreen) {
      page.webkitRequestFullscreen();
    } else if (page.msRequestFullscreen) {
      page.msRequestFullscreen();
    }
  }
}

// Load the json profile selected
async function loadjson(name, active_item) {
  if (name == 'preview') {
    var url = 'user/hashes/preview.json';
  } else {
    var url = 'user/config/' + name + '.json';
  }
  let response = await fetchFreshJson(url);
  let data = await response.json();
  rendermenu([data, active_item]);
}

window.onload = function() {
  updateLoginState();
  loadPublicSettings();
  $('#game-search').on('input', debounce(runGameSearch, 150));
  $('#console-filter').on('change', runGameSearch);
  $('#art-filter').on('change', runGameSearch);
  $('#favorites-filter').on('change', runGameSearch);
  if (! window.location.hash) {
    loadjson('main');
  } else {
    var hash = window.location.hash.replace('#','');
    var name = hash.split('---')[0];
    let active_item = hash.split('---')[1];
    loadjson(name, active_item);
  }
  $(window).on('hashchange', function() {
    window.location.reload();
  });
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      pushServerProfile(true);
    }
  });
};
