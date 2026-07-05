//Default vars
var endPoint = 'profile'
var storeName = 'RetroArch';
var afs;
BrowserFS.install(window);
var fs = require('fs');
var mfs = new BrowserFS.FileSystem.MountableFileSystem();
var postSettings = {method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'}};
var favoritesProfileFile = '.emulatorjs-favorites.json';
var favoritesSyncProfileFile = '.emulatorjs-favorites-sync.json';
var favoritesSyncStorageKey = 'ejsFavoritesSync';
var nextcloudJobPollTimer = null;
var activeNextcloudJobId = null;
var activeMirrorDeletePreviewId = '';
var userOverrideHelp = {
  selectorStyle: 'Use popup game/save selectors instead of the controller-friendly full menu selector',
  launchErrorDebug: 'Show in-game launch error overlay for debugging'
};
var nextcloudScopes = [
  {
    id: 'roms',
    label: 'ROMs',
    description: 'Game files under each system roms folder.',
    placeholder: '/EmulatorJS/roms'
  },
  {
    id: 'artwork',
    label: 'Artwork',
    description: 'Logos, backgrounds, and corner images.',
    placeholder: '/EmulatorJS/artwork'
  },
  {
    id: 'videos',
    label: 'Videos',
    description: 'Preview videos and video position metadata.',
    placeholder: '/EmulatorJS/videos'
  },
  {
    id: 'emulatorConfig',
    label: 'Emulator config, metadata, and hashes',
    description: 'Console config JSON, metadata overrides, hashes, scan state, and generated indexes.',
    placeholder: '/EmulatorJS/config-metadata'
  },
  {
    id: 'profiles',
    label: 'Profiles, saves, states, and favorites',
    description: 'Server profile folders, save/state history, favorites sync data, and profile records.',
    placeholder: '/EmulatorJS/profiles'
  },
  {
    id: 'activity',
    label: 'Activity logs and settings',
    description: 'Server settings, activity database, scan history, and related admin logs.',
    placeholder: '/EmulatorJS/activity'
  },
  {
    id: 'fullData',
    label: 'Full /data folder',
    description: 'Everything in the server data folder except the live .ipfs runtime repo. This may be very large.',
    placeholder: '/EmulatorJS/full-data'
  }
];

function booleanOverrideSelect(value, title) {
  return $('<select>').attr('title', title)
    .append($('<option>').attr('value', '').text('Default'))
    .append($('<option>').attr('value', 'true').text('On'))
    .append($('<option>').attr('value', 'false').text('Off'))
    .val(value === true ? 'true' : value === false ? 'false' : '');
}

function selectorOverrideSelect(value, title) {
  return $('<select>').attr('title', title)
    .append($('<option>').attr('value', '').text('Default'))
    .append($('<option>').attr('value', 'menu').text('Menu'))
    .append($('<option>').attr('value', 'popup').text('Popup'))
    .val(value === 'popup' ? 'popup' : value === 'menu' ? 'menu' : '');
}

function readBooleanOverrideValue(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

function getFavoritesForProfile() {
  return localStorage.getItem('ejsFavorites') || '[]';
}

function getFavoritesSyncForProfile() {
  return localStorage.getItem(favoritesSyncStorageKey) || JSON.stringify(readFavoritesSyncState());
}

function normalizeFavoritesList(favorites) {
  return Array.isArray(favorites) ? favorites.map(function(favorite) {
    return typeof favorite === 'string' ? {id: favorite} : favorite;
  }).filter(function(favorite) {
    return favorite && favorite.id && favorite.id !== 'undefined' && favorite.id.indexOf('undefined::') !== 0;
  }) : [];
}

function readFavoritesSyncState() {
  try {
    var parsed = JSON.parse(localStorage.getItem(favoritesSyncStorageKey) || '{}');
    if (parsed && parsed.records && typeof parsed.records === 'object') {
      return parsed;
    }
  } catch(e) {
    console.log(e);
  }
  return {version: 1, records: {}};
}

function writeFavoritesSyncState(state) {
  localStorage.setItem(favoritesSyncStorageKey, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    records: state && state.records || {}
  }));
}

function favoriteSyncTimestamp(record) {
  return Math.max(Number(record && record.updatedAt || 0), Number(record && record.addedAt || 0), Number(record && record.removedAt || 0));
}

function mergeFavoritesState(baseFavorites, baseSyncData, incomingFavorites, incomingSyncData) {
  var state = {version: 1, records: {}};
  function parseFavorites(data) {
    if (typeof data === 'undefined' || data === null || data === '') {
      return [];
    }
    try {
      return normalizeFavoritesList(JSON.parse(data));
    } catch(e) {
      console.log(e);
      return [];
    }
  }
  function parseSync(data) {
    if (typeof data === 'undefined' || data === null || data === '') {
      return null;
    }
    try {
      var parsed = typeof data === 'string' ? JSON.parse(data) : data;
      return parsed && parsed.records && typeof parsed.records === 'object' ? parsed : null;
    } catch(e) {
      console.log(e);
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
      var record = sync.records[id];
      if (!record || !id) {
        return;
      }
      var existing = state.records[id];
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
  seedFavorites(parseFavorites(baseFavorites));
  mergeSync(parseSync(baseSyncData));
  seedFavorites(parseFavorites(incomingFavorites));
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

function restoreFavoritesFromProfile(data, syncData) {
  if (typeof data === 'undefined' || data === null) {
    data = '[]';
  }
  var merged = mergeFavoritesState(
    localStorage.getItem('ejsFavorites') || '[]',
    localStorage.getItem(favoritesSyncStorageKey) || '',
    data,
    syncData
  );
  localStorage.setItem('ejsFavorites', JSON.stringify(normalizeFavoritesList(activeFavoritesFromSyncState(merged))));
  writeFavoritesSyncState(merged);
}

function toggleFilebrowserTheme() {
  var theme = $('html').attr('data-theme') === 'dark' ? 'light' : 'dark';
  $('html').attr('data-theme', theme);
  localStorage.setItem('ejs-admin-theme', theme);
  updateThemeToggle();
}

function updateThemeToggle() {
  $('#theme-toggle').text($('html').attr('data-theme') === 'dark' ? 'Light mode' : 'Dark mode');
}

function showFilebrowserTab(tab) {
  $('.admin-tab').removeClass('active');
  $('.admin-tab[data-tab="' + tab + '"]').addClass('active');
  $('.tab-panel').addClass('hidden').removeClass('active');
  $('#tab-' + tab).removeClass('hidden').addClass('active');
  if (tab === 'users') {
    loadUserManagementTab();
  }
  if (tab === 'webhooks') {
    loadAdminSettings();
  }
  if (tab === 'nextcloud') {
    renderNextcloudScopes();
    loadNextcloudSettings();
  }
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch(e) {
    return '';
  }
}

function clonePostBody(body) {
  return {
    method: 'POST',
    headers: {Accept:'application/json','Content-Type':'application/json'},
    body: JSON.stringify(body)
  };
}

function renderNextcloudScopes() {
  let wrapper = $('#nextcloudScopes');
  if (wrapper.children().length) {
    return;
  }
  nextcloudScopes.forEach(function(scope) {
    let row = $('<div>').addClass('scope-row').attr('data-scope', scope.id);
    let checkbox = $('<input>').attr({
      id: 'nextcloudScope-' + scope.id,
      type: 'checkbox',
      title: 'Include ' + scope.label + ' in archive and/or mirror backup jobs'
    });
    let label = $('<label>').addClass('scope-toggle').attr({
      for: 'nextcloudScope-' + scope.id,
      title: scope.description
    }).append(checkbox, $('<span>').text(scope.label));
    let detail = $('<span>').addClass('scope-description').text(scope.description);
    let path = $('<input>').attr({
      id: 'nextcloudPath-' + scope.id,
      type: 'text',
      placeholder: scope.placeholder,
      title: 'Independent Nextcloud destination folder for ' + scope.label
    });
    row.append(label, detail, path);
    wrapper.append(row);
  });
}

function updateNextcloudScheduleVisibility() {
  let schedule = $('#nextcloudScheduleType').val();
  $('.nextcloud-weekly-field').toggleClass('hidden', schedule !== 'weekly');
  $('.nextcloud-monthly-field').toggleClass('hidden', schedule !== 'monthly');
}

function nextcloudStatus(message, isError) {
  $('#nextcloudStatus').text(message || '').toggleClass('is-error', !!isError);
}

function setNextcloudProgress(percent, visible) {
  let clean = Math.max(0, Math.min(Number(percent || 0), 100));
  $('#nextcloudJobProgress').toggleClass('hidden', visible === false).attr('aria-hidden', visible === false ? 'true' : 'false');
  $('#nextcloudJobProgressBar').css('width', clean + '%');
}

function describeNextcloudJob(job) {
  if (!job) {
    setNextcloudProgress(0, false);
    return '';
  }
  let summary = job.summary || {};
  let jobLabel = job.kind === 'restore' ? 'Restore' : 'Backup';
  let bits = [];
  bits.push(jobLabel + ' ' + job.status + ': ' + (job.message || 'No message.'));
  if (job.mode) {
    bits.push('Mode: ' + job.mode + '.');
  }
  if (job.scopes && job.scopes.length) {
    bits.push('Scopes: ' + job.scopes.join(', ') + '.');
  }
  if (job.startedAt) {
    bits.push('Started: ' + new Date(job.startedAt).toLocaleString() + '.');
  }
  if (job.completedAt) {
    bits.push('Finished: ' + new Date(job.completedAt).toLocaleString() + '.');
  }
  if (summary.filesUploaded || summary.archivesUploaded || summary.bytesUploaded) {
    bits.push('Uploaded ' + (summary.filesUploaded || 0) + ' file(s), ' + (summary.archivesUploaded || 0) + ' archive(s), ' + (summary.bytesUploaded || 0) + ' byte(s).');
  }
  if (summary.remoteExtrasDeleted) {
    bits.push('Deleted ' + summary.remoteExtrasDeleted + ' remote extra file(s).');
  }
  if (summary.filesRestored || summary.filesBackedUp || summary.bytesRestored) {
    bits.push('Restored ' + (summary.filesRestored || 0) + ' file(s), backed up ' + (summary.filesBackedUp || 0) + ' overwritten file(s), ' + (summary.bytesRestored || 0) + ' byte(s).');
  }
  setNextcloudProgress(job.progress || (job.status === 'success' || job.status === 'error' ? 100 : 0), true);
  return bits.join(' ');
}

function updateNextcloudJobStatus(job) {
  if (!job) {
    return;
  }
  activeNextcloudJobId = job.id || activeNextcloudJobId;
  nextcloudStatus(describeNextcloudJob(job), job.status === 'error');
  let active = job.status === 'running' || job.status === 'queued' || job.status === 'canceling';
  $('#nextcloudStopBackup').toggleClass('hidden', !active).prop('disabled', job.status === 'canceling');
  if (active) {
    startNextcloudJobPolling(job.id);
  } else {
    stopNextcloudJobPolling();
  }
}

function stopNextcloudJobPolling() {
  if (nextcloudJobPollTimer) {
    clearTimeout(nextcloudJobPollTimer);
    nextcloudJobPollTimer = null;
  }
}

function startNextcloudJobPolling(jobId) {
  activeNextcloudJobId = jobId || activeNextcloudJobId;
  if (nextcloudJobPollTimer) {
    return;
  }
  async function poll() {
    nextcloudJobPollTimer = null;
    await loadNextcloudBackupStatus(activeNextcloudJobId);
    if (activeNextcloudJobId) {
      nextcloudJobPollTimer = setTimeout(poll, 2500);
    }
  }
  nextcloudJobPollTimer = setTimeout(poll, 1000);
}

async function loadNextcloudBackupStatus(jobId) {
  if (localStorage.getItem('role') !== 'admin') {
    return;
  }
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('getnextcloudbackupstatus', {jobId: jobId || ''})));
  let json = await res.json();
  if (json.status !== 'success') {
    return;
  }
  if (json.job) {
    updateNextcloudJobStatus(json.job);
    if (json.job.status !== 'running' && json.job.status !== 'queued' && json.job.status !== 'canceling') {
      activeNextcloudJobId = null;
      $('#nextcloudStopBackup').addClass('hidden').prop('disabled', false);
    }
  }
}

function nextcloudPayload(includePassword) {
  let scopes = {};
  nextcloudScopes.forEach(function(scope) {
    scopes[scope.id] = {
      enabled: $('#nextcloudScope-' + scope.id).prop('checked') === true,
      remotePath: String($('#nextcloudPath-' + scope.id).val() || '').trim()
    };
  });
  let payload = {
    url: String($('#nextcloudUrl').val() || '').trim(),
    username: String($('#nextcloudUsername').val() || '').trim(),
    clearAppPassword: $('#nextcloudClearPassword').prop('checked') === true,
    mode: $('#nextcloudMode').val(),
    archiveType: 'zip',
    retention: {
      mode: $('#nextcloudRetentionMode').val(),
      value: Number($('#nextcloudRetentionValue').val() || 0)
    },
    schedule: {
      type: $('#nextcloudScheduleType').val(),
      time: $('#nextcloudScheduleTime').val() || '03:00',
      dayOfWeek: Number($('#nextcloudScheduleDayOfWeek').val() || 0),
      dayOfMonth: Number($('#nextcloudScheduleDayOfMonth').val() || 1),
      timeZone: browserTimeZone()
    },
    mirrorDelete: $('#nextcloudMirrorDelete').prop('checked') === true,
    scopes: scopes
  };
  if (includePassword) {
    payload.appPassword = String($('#nextcloudAppPassword').val() || '');
  }
  return payload;
}

function resetMirrorDeletePreview() {
  activeMirrorDeletePreviewId = '';
  $('#nextcloudMirrorDeletePreview').addClass('hidden').attr('aria-hidden', 'true').empty();
}

function applyNextcloudSettings(settings) {
  settings = settings || {};
  renderNextcloudScopes();
  $('#nextcloudUrl').val(settings.url || '');
  $('#nextcloudUsername').val(settings.username || '');
  $('#nextcloudAppPassword').val('').attr('placeholder', settings.appPasswordConfigured ? 'App password configured - leave blank to keep' : 'Paste app password');
  $('#nextcloudClearPassword').prop('checked', false);
  $('#nextcloudMode').val(settings.mode || 'archive');
  $('#nextcloudArchiveType').val('zip');
  $('#nextcloudRetentionMode').val(settings.retention && settings.retention.mode || 'forever');
  $('#nextcloudRetentionValue').val(settings.retention && settings.retention.value ? settings.retention.value : '');
  $('#nextcloudScheduleType').val(settings.schedule && settings.schedule.type || 'manual');
  $('#nextcloudScheduleTime').val(settings.schedule && settings.schedule.time || '03:00');
  $('#nextcloudScheduleDayOfWeek').val(String(settings.schedule && Number(settings.schedule.dayOfWeek) || 0));
  $('#nextcloudScheduleDayOfMonth').val(settings.schedule && settings.schedule.dayOfMonth || 1);
  $('#nextcloudMirrorDelete').prop('checked', settings.mirrorDelete === true);
  let scopes = settings.scopes || {};
  nextcloudScopes.forEach(function(scope) {
    $('#nextcloudScope-' + scope.id).prop('checked', scopes[scope.id] && scopes[scope.id].enabled === true);
    $('#nextcloudPath-' + scope.id).val(scopes[scope.id] && scopes[scope.id].remotePath || '');
  });
  resetMirrorDeletePreview();
  updateNextcloudScheduleVisibility();
  let status = settings.lastStatus || {};
  let statusText = status.message || 'Nextcloud settings loaded. No backup jobs have run from this UI yet.';
  if (settings.schedule && settings.schedule.type && settings.schedule.type !== 'manual') {
    statusText += ' Schedule timezone: ' + (settings.schedule.timeZone || browserTimeZone() || 'server local time') + '.';
  }
  if (settings.nextRun && settings.nextRun.label) {
    statusText += ' Next scheduled run: ' + settings.nextRun.label + '.';
  }
  nextcloudStatus(statusText, status.status === 'error');
  setNextcloudProgress(status.status === 'running' ? 15 : status.status === 'success' || status.status === 'error' ? 100 : 0, status.status === 'running' || status.status === 'success' || status.status === 'error');
}

async function loadNextcloudSettings() {
  if (localStorage.getItem('role') !== 'admin') {
    return;
  }
  renderNextcloudScopes();
  nextcloudStatus('Loading Nextcloud settings...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('getnextcloudsettings')));
  let json = await res.json();
  if (json.status !== 'success') {
    nextcloudStatus('Unable to load Nextcloud settings.', true);
    return;
  }
  applyNextcloudSettings(json.nextcloud || {});
  loadNextcloudBackupStatus();
}

async function saveNextcloudSettings() {
  let payload = nextcloudPayload(true);
  nextcloudStatus('Saving Nextcloud settings...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('setnextcloudsettings', {nextcloud: payload})));
  let json = await res.json();
  if (json.status !== 'success') {
    nextcloudStatus(json.message || 'Unable to save Nextcloud settings.', true);
    return;
  }
  applyNextcloudSettings(json.nextcloud || {});
  nextcloudStatus('Nextcloud settings saved.');
}

async function testNextcloudConnection() {
  let payload = nextcloudPayload(true);
  nextcloudStatus('Testing Nextcloud WebDAV access...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('testnextcloudconnection', {nextcloud: payload})));
  let json = await res.json();
  if (json.status !== 'success') {
    nextcloudStatus(json.message || 'Unable to reach Nextcloud WebDAV with these settings.', true);
    return;
  }
  nextcloudStatus(json.message || 'Nextcloud WebDAV connection succeeded.');
}

async function runNextcloudBackup() {
  let payload = nextcloudPayload(true);
  let selectedScopes = Object.keys(payload.scopes || {}).filter(function(scopeId) {
    return payload.scopes[scopeId] && payload.scopes[scopeId].enabled === true;
  });
  if (!selectedScopes.length) {
    nextcloudStatus('Select at least one backup scope before running a backup.', true);
    return;
  }
  let missingPathScope = selectedScopes.find(function(scopeId) {
    return !payload.scopes[scopeId].remotePath;
  });
  if (missingPathScope) {
    nextcloudStatus('Enter a Nextcloud destination folder for each selected scope.', true);
    return;
  }
  if (payload.mirrorDelete === true) {
    if (payload.mode !== 'mirror' && payload.mode !== 'both') {
      nextcloudStatus('Mirror delete only applies when Backup mode is Mirror sync or Both.', true);
      return;
    }
    if (!activeMirrorDeletePreviewId) {
      nextcloudStatus('Preview mirror deletes before running a backup with mirror delete enabled.', true);
      return;
    }
    if (!confirm('Run backup and delete the remote extras shown in the latest mirror-delete preview?')) {
      return;
    }
  }
  nextcloudStatus('Starting Nextcloud backup job on the server...');
  setNextcloudProgress(5, true);
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('runnextcloudbackup', {nextcloud: payload, mirrorDeletePreviewId: activeMirrorDeletePreviewId})));
  let json = await res.json();
  if (json.nextcloud) {
    applyNextcloudSettings(json.nextcloud);
  }
  if (json.status !== 'success') {
    nextcloudStatus(json.message || 'Nextcloud backup failed.', true);
    return;
  }
  if (json.job) {
    updateNextcloudJobStatus(json.job);
    startNextcloudJobPolling(json.job.id);
    return;
  }
  nextcloudStatus(json.message || 'Nextcloud backup started.');
}

function renderMirrorDeletePreview(preview) {
  let panel = $('#nextcloudMirrorDeletePreview');
  panel.empty().removeClass('hidden').attr('aria-hidden', 'false');
  let total = preview && preview.totalExtras || 0;
  panel.append($('<h3>').text('Mirror Delete Preview'));
  panel.append($('<p>').text(total + ' remote extra file(s) would be deleted after the mirror upload completes. Archive zip files are protected.'));
  if (preview && preview.truncated) {
    panel.append($('<p>').text('Preview list was truncated for display. The backup job will only delete files included in this confirmed preview.'));
  }
  let list = $('<ul>');
  Object.keys(preview && preview.extras || {}).forEach(function(scopeId) {
    (preview.extras[scopeId] || []).forEach(function(file) {
      list.append($('<li>').text(scopeId + ': ' + file.relPath));
    });
  });
  if (!list.children().length) {
    list.append($('<li>').text('No remote extras found.'));
  }
  panel.append(list);
}

async function previewNextcloudMirrorDelete() {
  let payload = nextcloudPayload(true);
  let selectedScopes = Object.keys(payload.scopes || {}).filter(function(scopeId) {
    return payload.scopes[scopeId] && payload.scopes[scopeId].enabled === true;
  });
  if (payload.mode !== 'mirror' && payload.mode !== 'both') {
    nextcloudStatus('Switch Backup mode to Mirror sync or Both before previewing mirror deletes.', true);
    return;
  }
  if (!selectedScopes.length) {
    nextcloudStatus('Select at least one backup scope before previewing mirror deletes.', true);
    return;
  }
  let missingPathScope = selectedScopes.find(function(scopeId) {
    return !payload.scopes[scopeId].remotePath;
  });
  if (missingPathScope) {
    nextcloudStatus('Enter a Nextcloud destination folder for each selected scope.', true);
    return;
  }
  nextcloudStatus('Previewing remote files that mirror delete would remove...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('previewnextcloudmirrordelete', {nextcloud: payload})));
  let json = await res.json();
  if (json.status !== 'success') {
    resetMirrorDeletePreview();
    nextcloudStatus(json.message || 'Unable to preview mirror deletes.', true);
    return;
  }
  activeMirrorDeletePreviewId = json.preview && json.preview.id || '';
  renderMirrorDeletePreview(json.preview || {});
  nextcloudStatus('Mirror delete preview ready. Review it before running backup.');
}

async function cancelNextcloudBackup() {
  if (!activeNextcloudJobId) {
    nextcloudStatus('No running Nextcloud job was found.', true);
    return;
  }
  if (!confirm('Stop the running Nextcloud job? It will stop after the current file finishes.')) {
    return;
  }
  $('#nextcloudStopBackup').prop('disabled', true);
  nextcloudStatus('Requesting backup stop...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('cancelnextcloudbackup', {jobId: activeNextcloudJobId})));
  let json = await res.json();
  if (json.status !== 'success') {
    $('#nextcloudStopBackup').prop('disabled', false);
    nextcloudStatus(json.message || 'Unable to stop backup.', true);
    return;
  }
  if (json.job) {
    updateNextcloudJobStatus(json.job);
  } else {
    nextcloudStatus(json.message || 'Stop requested.');
  }
}

function populateNextcloudArchives(archives) {
  let select = $('#nextcloudRestoreArchive');
  select.empty();
  if (!archives || !archives.length) {
    select.append($('<option>').attr('value', '').text('No profile archives found'));
    return;
  }
  archives.slice().reverse().forEach(function(archive) {
    select.append($('<option>').attr('value', archive.remotePath).text(archive.name));
  });
}

async function listNextcloudArchives() {
  let payload = nextcloudPayload(true);
  let profilesScope = payload.scopes && payload.scopes.profiles;
  if (!profilesScope || !profilesScope.remotePath) {
    nextcloudStatus('Enter the Profiles Nextcloud destination folder before listing archives.', true);
    return;
  }
  nextcloudStatus('Listing profile archives from Nextcloud...');
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('listnextcloudarchives', {nextcloud: payload, scope: 'profiles'})));
  let json = await res.json();
  if (json.status !== 'success') {
    nextcloudStatus(json.message || 'Unable to list Nextcloud archives.', true);
    return;
  }
  populateNextcloudArchives(json.archives || []);
  nextcloudStatus((json.archives || []).length + ' profile archive(s) found.');
}

async function restoreNextcloudArchive() {
  let payload = nextcloudPayload(true);
  let archivePath = String($('#nextcloudRestoreArchive').val() || '');
  if (!archivePath) {
    nextcloudStatus('Select a profile archive to restore.', true);
    return;
  }
  let archiveName = $('#nextcloudRestoreArchive option:selected').text() || archivePath;
  if (!confirm('Restore profiles from ' + archiveName + '? Matching local files will be overwritten, overwritten files will be backed up locally first, and extra local files will be kept.')) {
    return;
  }
  nextcloudStatus('Starting Nextcloud restore job on the server...');
  setNextcloudProgress(10, true);
  let res = await fetch(endPoint, clonePostBody(adminProfileBody('restorenextcloudarchive', {nextcloud: payload, scope: 'profiles', archivePath: archivePath})));
  let json = await res.json();
  if (json.nextcloud) {
    applyNextcloudSettings(json.nextcloud);
  }
  if (json.status !== 'success') {
    nextcloudStatus(json.message || 'Nextcloud restore failed.', true);
    return;
  }
  if (json.job) {
    updateNextcloudJobStatus(json.job);
    startNextcloudJobPolling(json.job.id);
    return;
  }
  nextcloudStatus(json.message || 'Nextcloud restore started.');
}

// Render file list
async function renderFiles(directory) {
  directory = directory.replace("//","/");
  directory = directory.replace("|","'");
  let directoryClean = directory.replace("'","|");
  if ((directory !== '/') && (directory.endsWith('/'))) {
    directory = directory.slice(0, -1);
  }
  $('#filebrowser').empty();
  $('#filebrowser').data('directory', directory);
  $('#filebrowser').append($('<div>').text(directory));
  let items = await fs.readdirSync(directory);
  let baseName = directory.split('/').slice(-1)[0]; 
  let parentFolder = directory.replace(baseName,'');
  let parentLink = $('<td>').addClass('directory').attr('onclick', 'renderFiles(\'' + parentFolder + '\');').text('..');
  if (directoryClean == '/') {
    directoryClean = '';
  }
  let table = $('<table>').addClass('fileTable');
  let tableHeader = $('<tr>');
  for await (name of ['Name', 'Type', 'Delete']) {
    tableHeader.append($('<th>').text(name));
  }
  let parentRow = $('<tr>');
  for await (item of [parentLink, $('<td>').text('Parent'), $('<td>')]) {
    parentRow.append(item);
  }
  table.append(tableHeader,parentRow);
  $('#filebrowser').append(table);
  items.sort();
  if (items.length > 0) {
    let dirs = [];
    let files = [];
    for await (let item of items) {
      if (fs.lstatSync(directory + '/' + item).isDirectory()) {
        dirs.push(item)
      } else {
        files.push(item)
      }
    }
    if (dirs.length > 0) {
      for await (let dir of dirs) {
        let tableRow = $('<tr>');
        let dirClean = dir.replace("'","|");
        let link = $('<td>').addClass('directory').attr('onclick', 'renderFiles(\'' + directoryClean + '/' + dirClean + '\');').text(dir);
        let type = $('<td>').text('Dir');
        let del = $('<td>').append($('<button>').addClass('deleteButton').attr('onclick', 'deleter(\'' + directoryClean + '/' + dirClean + '\');').text('Delete'));
        for await (item of [link, type, del]) {
          tableRow.append(item);
        }
        table.append(tableRow);
      }
    }
    if (files.length > 0) {
      for await (let file of files) {
        let tableRow = $('<tr>');
        let fileClean = file.replace("'","|");
        let link = $('<td>').addClass('file').attr('onclick', 'downloadFile(\'' + directoryClean + '/' + fileClean + '\');').text(file);
        let type = $('<td>').text('File');
        let del = $('<td>').append($('<button>').addClass('deleteButton').attr('onclick', 'deleter(\'' + directoryClean + '/' + fileClean + '\');').text('Delete'));
        for await (item of [link, type, del]) {
          tableRow.append(item);
        }
        table.append(tableRow);
      }
    }
  }
}

// Download file when clicked
async function downloadFile(file) {
  file = file.replace("|","'");
  let fileName = file.split('/').slice(-1)[0];
  let data = fs.readFileSync(file);
  let blob = new Blob([data], { type: "application/octetstream" });
  let url = window.URL || window.webkitURL;
  link = url.createObjectURL(blob);
  let a = $("<a />");
  a.attr("download", fileName);
  a.attr("href", link);
  $("body").append(a);
  a[0].click();
  $("body").remove(a);
}

// Upload file to current directory
async function upload(input) {
  let directory = $('#filebrowser').data('directory');
  if (directory == '/') {
    directoryUp = '';
  } else {
    directoryUp = directory;
  }
  if (input.files && input.files[0]) {
    for await (let file of input.files) {
      let reader = new FileReader();
      reader.onload = function(e) {
        let fileName = file.name;
        let data = e.target.result;
        fs.writeFileSync(directoryUp + '/' + fileName, Buffer.from(data));
        if (file == input.files[input.files.length - 1]) {
          renderFiles(directory);
        }
      }
      reader.readAsArrayBuffer(file);
    }
  }
}

// Create a directory
async function createFolder() {
  let folderName = $('#folderName').val();
  $('#folderName').val('');
  if ((folderName.length == 0) || (folderName.includes('/'))) {
    alert('Bad or Null Directory Name');
    return '';
  }
  let directory = $('#filebrowser').data('directory');
  if (directory == '/') {
    directoryUp = '';
  } else {
    directoryUp = directory;
  }
  let createD = directoryUp + '/' + folderName;
  if (!fs.existsSync(createD)){
    fs.mkdirSync(createD);
  }
  renderFiles(directory);
}

// Handle drag and drop
async function dropFiles(ev) {
  ev.preventDefault();
  let directory = $('#filebrowser').data('directory');
  if (directory == '/') {
    directoryUp = '';
  } else {
    directoryUp = directory;
  }
  let items = await getAllFileEntries(event.dataTransfer.items);
  for await (let item of items) {
    let fullPath = item.fullPath;
    let dirPath = fullPath.split('/');
    // Check if directories need to be created
    if (dirPath.length > 2) {
      var startDir = directoryUp;
      dirPath.splice(dirPath.length - 1);
      dirPath.shift();
      for await (let dir of dirPath) {
        startDir = startDir + '/' + dir;
        if (!fs.existsSync(startDir)){
          fs.mkdirSync(startDir);
        }
      }
    }
    // Write file
    item.file(async function(file) {
      let reader = new FileReader();
      reader.onload = function(e) {
        let data = e.target.result;
        fs.writeFileSync(directoryUp + '/' + fullPath, Buffer.from(data));
        if (item == items[items.length - 1]) {
          $('#dropzone').css({'visibility':'hidden','opacity':0});
          renderFiles(directory);
        }
      }
      reader.readAsArrayBuffer(file);
    });
  }
}
// Drop handler function to get all files
async function getAllFileEntries(dataTransferItemList) {
  let fileEntries = [];
  // Use BFS to traverse entire directory/file structure
  let queue = [];
  // Unfortunately dataTransferItemList is not iterable i.e. no forEach
  for (let i = 0; i < dataTransferItemList.length; i++) {
    queue.push(dataTransferItemList[i].webkitGetAsEntry());
  }
  while (queue.length > 0) {
    let entry = queue.shift();
    if (entry.isFile) {
      fileEntries.push(entry);
    } else if (entry.isDirectory) {
      let reader = entry.createReader();
      queue.push(...await readAllDirectoryEntries(reader));
    }
  }
  return fileEntries;
}
// Get all the entries (files or sub-directories) in a directory by calling readEntries until it returns empty array
async function readAllDirectoryEntries(directoryReader) {
  let entries = [];
  let readEntries = await readEntriesPromise(directoryReader);
  while (readEntries.length > 0) {
    entries.push(...readEntries);
    readEntries = await readEntriesPromise(directoryReader);
  }
  return entries;
}
// Wrap readEntries in a promise to make working with readEntries easier
async function readEntriesPromise(directoryReader) {
  try {
    return await new Promise((resolve, reject) => {
      directoryReader.readEntries(resolve, reject);
    });
  } catch (err) {
    console.log(err);
  }
}

var lastTarget;
// Change style when hover files
window.addEventListener('dragenter', function(ev) {
  lastTarget = ev.target;
  $('#dropzone').css({'visibility':'','opacity':1});
});

// Change style when leave hover files
window.addEventListener("dragleave", function(ev) {
  if(ev.target == lastTarget || ev.target == document) {
    $('#dropzone').css({'visibility':'hidden','opacity':0});
  }
});

// Disabled default drag and drop
function allowDrop(ev) {
  ev.preventDefault();
}

// Delete file or folder
async function deleter(item) {
  let directory = $('#filebrowser').data('directory');
  item = item.replace("|","'"); 
  if (!confirm('Delete "' + item + '"? This cannot be undone.')) {
    return;
  }
  if (fs.lstatSync(item).isDirectory()) {
    await rmDir(item);
  } else {
    fs.unlinkSync(item);
  }
  renderFiles(directory);
}

// Download a full backup of all files
async function downloadBackup() {
  let zip = new JSZip();
  let items = await fs.readdirSync('/');
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
      let zipPath = item.replace(/^\//,'');
      zip.file(zipPath, data);
    }
    return ''
  }
  for await (let item of items) {
    await addToZip(item);
  }
  zip.generateAsync({type:"blob"}).then(function callback(blob) {
    let url = window.URL || window.webkitURL;
    link = url.createObjectURL(blob);
    let a = $("<a />");
    a.attr("download", storeName + '.zip');
    a.attr("href", link);
    $("body").append(a);
    a[0].click();
    $("body").remove(a);    
  });
}

// Full delete directory
async function rmDir(dirPath) {
  try {
  let files = fs.readdirSync(dirPath);
  if (files.length > 0) {
    for await (let file of files) {
      var filePath = dirPath + '/' + file;
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      } else {
        await rmDir(filePath);
      }
    }
  }
  if (dirPath !== '/') {
    fs.rmdirSync(dirPath);
  }
  if (fs.readdirSync(dirPath).length !== 0) {
    rmDir(dirPath);
    return '';
  }
  } catch (e) {
    return '';
  }
  return '';
}


// Upload a full backup
async function uploadBackup(input) {
  if (input.files && input.files[0]) {
    $('#filebrowser').empty();
    $('#filebrowser').append($('<div>').attr('id','loading'));
    let reader = new FileReader();
    reader.onload = async function(e) {
      let data = e.target.result;
      let zip = new JSZip();
      // Load zip from data
      zip.loadAsync(data).then(async function(contents) {
        // Purge current storage
        await rmDir('/');
        // Unzip the files to the FS by name
        for await (let fileName of Object.keys(contents.files)) {
          if (fileName.endsWith('/')) {
            if (! fs.existsSync('/' + fileName)) {
              fs.mkdirSync('/' + fileName);
            }
          }
        }
        for await (let fileName of Object.keys(contents.files)) {
          if (! fileName.endsWith('/')) {
            zip.file(fileName).async('arraybuffer').then(function(content) {
              fs.writeFileSync('/' + fileName, Buffer.from(content));
            });
          }
	}
        await new Promise(resolve => setTimeout(resolve, 2000));
        window.location.reload();
      });
    }
    reader.readAsArrayBuffer(input.files[0]);
  }
}

// Render profile
async function loadProfile() {
  let res = await fetch(endPoint);
  let ping = await res.text();
  if (ping == 'pong') {
    $('#profile').removeClass('hidden');
  }
  if (await refreshBootstrapState()) {
    return;
  }
  if ((localStorage.getItem('user')) && (localStorage.getItem('pass'))) {
    await verifyLogin();
  }
}

function setBootstrapStatus(message, isError) {
  $('#bootstrapStatus').text(message || '').toggleClass('is-error', !!isError);
}

async function refreshBootstrapState() {
  try {
    let settings = Object.assign({}, postSettings);
    settings.body = JSON.stringify({type:'publicsettings'});
    let res = await fetch(endPoint, settings);
    let json = await res.json();
    if (json.status == 'success' && json.setupRequired === true) {
      localStorage.removeItem('user');
      localStorage.removeItem('pass');
      localStorage.removeItem('role');
      $('#loginEntry').addClass('hidden');
      $('#defaultPull').addClass('hidden');
      $('#logout').addClass('hidden');
      $('#syncButtons').addClass('hidden');
      $('#adminGate').addClass('hidden');
      $('#adminContent').addClass('hidden');
      $('#bootstrapAdmin').removeClass('hidden');
      window.setTimeout(function() {
        $('#bootstrapUser').trigger('focus');
      }, 50);
      return true;
    }
  } catch(e) {
    console.log(e);
  }
  $('#bootstrapAdmin').addClass('hidden');
  return false;
}

async function createBootstrapAdmin() {
  let user = $('#bootstrapUser').val();
  let pass = $('#bootstrapPass').val();
  let confirm = $('#bootstrapPassConfirm').val();
  if (!user || !pass) {
    setBootstrapStatus('Enter a username and password.', true);
    return;
  }
  if (pass.length < 10) {
    setBootstrapStatus('Password must be at least 10 characters.', true);
    return;
  }
  if (pass !== confirm) {
    setBootstrapStatus('Passwords do not match.', true);
    return;
  }
  setBootstrapStatus('Creating admin profile...');
  try {
    let settings = Object.assign({}, postSettings);
    settings.body = JSON.stringify({type:'bootstrapadmin', user:user, pass:pass});
    let res = await fetch(endPoint, settings);
    let json = await res.json();
    if (json.status != 'success') {
      setBootstrapStatus('Unable to create admin profile.', true);
      return;
    }
    localStorage.setItem('user', json.user || user);
    localStorage.setItem('pass', pass);
    localStorage.setItem('role', json.role || 'admin');
    $('#bootstrapPass').val('');
    $('#bootstrapPassConfirm').val('');
    $('#bootstrapAdmin').addClass('hidden');
    loggedIn();
  } catch(e) {
    console.log(e);
    setBootstrapStatus('Unable to reach setup service.', true);
  }
}

async function verifyLogin() {
  try {
    let loginSettings = postSettings;
    loginSettings.body = JSON.stringify({user:localStorage.getItem('user'),pass:localStorage.getItem('pass'),type:'login',source:'filebrowser-verify',silent:true});
    let res = await fetch(endPoint,loginSettings);
    let json = await res.json();
    if (json.status == 'success') {
      localStorage.setItem('role', json.role || 'user');
      loggedIn();
    } else {
      loggedOut();
    }
  } catch(e) {
    console.log(e);
    loggedOut();
  }
}

// Login
async function login() {
  try {
    let user = $('#user').val();
    let pass = $('#pass').val();
    $('#user').val('');
    $('#pass').val('');
    let loginSettings = postSettings;
    loginSettings.body = JSON.stringify({user:user,pass:pass,type:'login',source:'filebrowser'});
    let res = await fetch(endPoint,loginSettings);
    let json = await res.json();
    if (json.status == 'success') {
      localStorage.setItem('user',json.user);
      localStorage.setItem('pass',pass);
      localStorage.setItem('role',json.role || 'user');
      loggedIn();
    } else {
      alert('Bad login'); 
    }
  } catch (e) {
    console.log(e)
  }
}

async function forgotPassword(source) {
  let user = $('#user').val() || localStorage.getItem('user') || '';
  if (!user) {
    alert('Enter your username first.');
    $('#user').trigger('focus');
    return;
  }
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify({type:'forgotpassword', user:user, source:source || 'filebrowser'});
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  alert(json.status == 'success' ? 'The admin has been notified.' : 'Password reset notification is not configured.');
}

// Logout
function logout() {
  localStorage.removeItem('user');
  localStorage.removeItem('pass');
  localStorage.removeItem('role');
  loggedOut();
}

// Render as logged in
function loggedIn() {
  let user = localStorage.getItem('user');
  let role = localStorage.getItem('role') || 'user';
  $('#loginEntry').addClass('hidden');
  $('#bootstrapAdmin').addClass('hidden');
  $('#defaultPull').addClass('hidden');
  $('#logout').removeClass('hidden');
  $('#username').text(user + ' (' + role + ')');
  if (role == 'admin') {
    $('#syncButtons').removeClass('hidden');
    $('#adminGate').addClass('hidden');
    $('#adminContent').removeClass('hidden');
    setupFileSystem();
    loadTouchInput();
    loadUsers();
    loadAdminSettings();
  } else {
    $('#syncButtons').addClass('hidden');
    $('#adminContent').addClass('hidden');
    $('#adminGate').removeClass('hidden');
    $('#adminGate').find('p').text('Your profile is logged in, but only admin profiles can use the file browser.');
  }
}

// Render as logged out
function loggedOut() {
  $('#username').empty();
  $('#syncButtons').addClass('hidden');
  $('#logout').addClass('hidden');
  $('#defaultPull').removeClass('hidden');
  $('#loginEntry').removeClass('hidden');
  $('#bootstrapAdmin').addClass('hidden');
  $('#adminContent').addClass('hidden');
  $('#adminGate').removeClass('hidden');
  $('#adminGate').find('p').text('Log in with an admin profile to use the file browser and user management.');
}

function adminProfileBody(type, extra) {
  let body = Object.assign({
    user: localStorage.getItem('user'),
    pass: localStorage.getItem('pass'),
    type: type
  }, extra || {});
  return body;
}

async function loadUsers() {
  if (localStorage.getItem('role') !== 'admin') {
    return;
  }
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('listusers'));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  $('#usersList').empty();
  if (json.status !== 'success') {
    $('#usersList').text('Unable to load users.');
    return;
  }
  let table = $('<table>').addClass('fileTable');
  let header = $('<tr>');
  let columns = [
    {label: 'Username'},
    {label: 'Role'},
    {label: 'Password'},
    {label: 'Selectors', title: userOverrideHelp.selectorStyle},
    {label: 'Launch', title: userOverrideHelp.launchErrorDebug},
    {label: 'Action'}
  ];
  for await (let column of columns) {
    let cell = $('<th>').text(column.label);
    if (column.title) {
      cell.attr('title', column.title);
    }
    header.append(cell);
  }
  table.append(header);
  for await (let user of json.users) {
    let row = $('<tr>');
    let roleSelect = $('<select>').attr('data-user', user.username).append($('<option>').attr('value','user').text('User'), $('<option>').attr('value','admin').text('Admin')).val(user.role);
    let passInput = $('<input>').attr({type:'password', placeholder:'New password'});
    let passButton = $('<button>').text('Update Password').on('click', async function() {
      await adminChangePassword(user.username, passInput.val());
      passInput.val('');
    });
    let overrides = user.settingsOverrides || {};
    let selectorSelect = selectorOverrideSelect(overrides.selectorStyle, userOverrideHelp.selectorStyle);
    let launchSelect = booleanOverrideSelect(overrides.launchErrorDebug, userOverrideHelp.launchErrorDebug);
    let save = $('<button>').text('Save User').attr('title', 'Save role and override settings').on('click', async function() {
      await saveUserSettings(user.username, {
        role: roleSelect.val(),
        settingsOverrides: {
          selectorStyle: selectorSelect.val() || null,
          launchErrorDebug: readBooleanOverrideValue(launchSelect.val())
        }
      });
    });
    row.append(
      $('<td>').text(user.username),
      $('<td>').append(roleSelect),
      $('<td>').append(passInput, passButton),
      $('<td>').append(selectorSelect),
      $('<td>').append(launchSelect),
      $('<td>').append(save)
    );
    table.append(row);
  }
  $('#usersList').append(table);
}

function loadUserManagementTab() {
  loadAdminSettings();
  loadUsers();
}

async function saveUserSettings(target, payload) {
  let roleSettings = postSettings;
  roleSettings.body = JSON.stringify(adminProfileBody('setrole', {target: target, role: payload.role}));
  let roleRes = await fetch(endPoint, roleSettings);
  let roleJson = await roleRes.json();
  if (roleJson.status !== 'success') {
    alert('Unable to update user settings');
    return;
  }
  let overrideSettings = postSettings;
  overrideSettings.body = JSON.stringify(adminProfileBody('setuseroverrides', {
    target: target,
    settingsOverrides: payload.settingsOverrides
  }));
  let overrideRes = await fetch(endPoint, overrideSettings);
  let overrideJson = await overrideRes.json();
  if (overrideJson.status !== 'success') {
    alert('Unable to update user settings');
    return;
  }
  loadUsers();
}

async function createManagedUser() {
  let newUser = $('#newUser').val();
  let newPass = $('#newPass').val();
  let role = $('#newRole').val();
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('createsimpleuser', {newUser: newUser, newPass: newPass, role: role}));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  if (json.status == 'success') {
    $('#newUser').val('');
    $('#newPass').val('');
    loadUsers();
  } else {
    alert('Unable to create user');
  }
}

async function adminChangePassword(target, newPass) {
  if (!newPass) {
    alert('Enter a new password');
    return;
  }
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('adminchangepassword', {target: target, newPass: newPass}));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  alert(json.status == 'success' ? 'Password updated' : 'Unable to update password');
}

function showUserManagement() {
  if (localStorage.getItem('role') !== 'admin') {
    return;
  }
  showFilebrowserTab('users');
  loadUsers();
  window.setTimeout(function() {
    $('#newUser').trigger('focus');
  }, 50);
}

function closeUserManagement() {
  $('body').removeClass('modal-open');
}

function handleUserManagementBackdrop(event) {
  return event;
}

async function loadAdminSettings() {
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('getsettings'));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  if (json.status == 'success') {
    $('#requireMainLogin').prop('checked', json.requireLogin === true);
    $('#usePopupSelectors').prop('checked', json.selectorStyle === 'popup');
    $('#launchErrorDebug').prop('checked', json.launchErrorDebug === true);
    $('#passwordResetWebhook').val(json.passwordResetWebhook || '');
  }
}

async function saveAdminSettings() {
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('setsettings', {
    requireLogin: $('#requireMainLogin').prop('checked'),
    selectorStyle: $('#usePopupSelectors').prop('checked') ? 'popup' : 'menu',
    launchErrorDebug: $('#launchErrorDebug').prop('checked'),
    passwordResetWebhook: $('#passwordResetWebhook').val()
  }));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  alert(json.status == 'success' ? 'Settings saved' : 'Unable to save settings');
}

async function testPasswordResetWebhook() {
  await saveAdminSettings();
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('testpasswordresetwebhook'));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  alert(json.status == 'success' ? 'Test payload sent' : 'Unable to send test payload');
}

// Pull profile from server
async function pullProfile() {
  $('#filebrowser').empty();
  $('#filebrowser').append($('<div>').attr('id','loading'));
  let user = localStorage.getItem('user');
  let pass = localStorage.getItem('pass');
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify({user:user,pass:pass,type:'pull'});
  let res = await fetch(endPoint,loginSettings);
  let json = await res.json();
  if (json.status == 'success') {
    let zip = new JSZip();
    // Purge current storage
    await rmDir('/');
    let baseData = json.data;
    // Load zip from data
    zip.loadAsync(baseData, {base64: true}).then(async function(contents) {
      let pulledFavorites = null;
      let pulledFavoritesSync = null;
      // Unzip the files to the FS by name
      for await (let fileName of Object.keys(contents.files)) {
        if (fileName.endsWith('/')) {
          if (! fs.existsSync('/' + fileName)) {
            fs.mkdirSync('/' + fileName);
          }
        }
      }
      for await (let fileName of Object.keys(contents.files)) {
        if (! fileName.endsWith('/')) {
          if (fileName === favoritesProfileFile) {
            pulledFavorites = await zip.file(fileName).async('string');
          } else if (fileName === favoritesSyncProfileFile) {
            pulledFavoritesSync = await zip.file(fileName).async('string');
          } else {
          zip.file(fileName).async('arraybuffer').then(function(content) {
            fs.writeFileSync('/' + fileName, Buffer.from(content));
          });
          }
        }
      }
      if (pulledFavorites !== null || pulledFavoritesSync !== null) {
        restoreFavoritesFromProfile(pulledFavorites, pulledFavoritesSync);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      window.location.reload();
    });
  } else {
    alert('Error pulling profile');
  } 
}

async function defaultProfile() {
  $('#filebrowser').empty();
  $('#filebrowser').append($('<div>').attr('id','loading'));
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify({type:'default'});
  let res = await fetch(endPoint,loginSettings);
  let json = await res.json();
  if (json.status == 'success') {
    let zip = new JSZip();
    // Purge current storage
    await rmDir('/');
    let baseData = json.data;
    // Load zip from data
    zip.loadAsync(baseData, {base64: true}).then(async function(contents) {
      let pulledFavorites = null;
      let pulledFavoritesSync = null;
      // Unzip the files to the FS by name
      for await (let fileName of Object.keys(contents.files)) {
        if (fileName.endsWith('/')) {
          if (! fs.existsSync('/' + fileName)) {
            fs.mkdirSync('/' + fileName);
          }
        }
      }
      for await (let fileName of Object.keys(contents.files)) {
        if (! fileName.endsWith('/')) {
          if (fileName === favoritesProfileFile) {
            pulledFavorites = await zip.file(fileName).async('string');
          } else if (fileName === favoritesSyncProfileFile) {
            pulledFavoritesSync = await zip.file(fileName).async('string');
          } else {
          zip.file(fileName).async('arraybuffer').then(function(content) {
            fs.writeFileSync('/' + fileName, Buffer.from(content));
          });
          }
        }
      }
      if (pulledFavorites !== null || pulledFavoritesSync !== null) {
        restoreFavoritesFromProfile(pulledFavorites, pulledFavoritesSync);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      window.location.reload();
    });
  } else {
    alert('Error pulling profile');
  }
}

// Push profile to server
async function pushProfile() {
  $('#filebrowser').empty();
  $('#filebrowser').append($('<div>').attr('id','loading'));
  let zip = new JSZip();
  let items = await fs.readdirSync('/');
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
      let zipPath = item.replace(/^\//,'');
      zip.file(zipPath, data);
    }
    return ''
  }
  for await (let item of items) {
    await addToZip(item);
  }
  zip.file(favoritesProfileFile, getFavoritesForProfile());
  zip.file(favoritesSyncProfileFile, getFavoritesSyncForProfile());
  zip.generateAsync({type:"base64"}).then(async function callback(base64) {
    try {
      let user = localStorage.getItem('user');
      let pass = localStorage.getItem('pass');
      let loginSettings = postSettings;
      loginSettings.body = JSON.stringify({user:user,pass:pass,type:'push',data:base64});
      let res = await fetch(endPoint,loginSettings);
      let json = await res.json();
      if (json.status == 'success') {
        window.location.reload();
      } else {
        alert('Error uploading profile');
      }
    } catch (e) {
      alert('Error uploading profile');
      console.log(e);
    }
  });
}

// Load and show touch input options on touch devices
function loadTouchInput() {
  if (window.orientation !== undefined) {
    $('#touchpad').removeClass('hidden');
    if (localStorage.getItem('touchpad') !== null) {
      if (localStorage.getItem('touchpad') == 'false') {
        $('#touch').val('false');
      } else if (localStorage.getItem('touchpad') == 'default') {
        $('#touch').val('default');
      } else if (localStorage.getItem('touchpad') == 'simple') {
        $('#touch').val('simple');
      } else if (localStorage.getItem('touchpad') == 'modern') {
        $('#touch').val('modern');
      }
    }
  }
}
// Save touch input option
function touchSave() {
  let option = $('#touch').val();
  if (option == 'auto') {
    localStorage.removeItem('touchpad'); 
  } else {
    localStorage.setItem('touchpad',option);
  }
  window.location.reload(); 
}

// Create Async filestore
async function setupFileSystem() {
  if (afs) {
    renderFiles($('#filebrowser').data('directory') || '/');
    return;
  }
  var imfs = new BrowserFS.FileSystem.InMemory();
  afs = new BrowserFS.FileSystem.AsyncMirror(imfs,
    new BrowserFS.FileSystem.IndexedDB(async function(e, fs) {
      afs.initialize(async function(e) {
        console.log('IndexedDB setup successful');
        setupMounts();
      });
    },
  storeName));
};

// Setup mounts
async function setupMounts() {
  mfs.mount('/', afs);
  BrowserFS.initialize(mfs);
  renderFiles('/');
}

// On page load
window.onload = function() {
  updateThemeToggle();
  loadProfile();
}
