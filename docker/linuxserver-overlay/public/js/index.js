var host = window.location.hostname;
var port = window.location.port;
var protocol = window.location.protocol;
var path = window.location.pathname;
function adminSocketPath() {
  return (path.endsWith('/') ? path : path + '/') + 'socket.io';
}
var adminSocketPaths = Array.from(new Set([adminSocketPath(), '/socket.io']));
var adminSocketPathIndex = 0;
var socket = io({
  path: adminSocketPaths[adminSocketPathIndex],
  withCredentials: true,
  transports: ['websocket']
});
var adminReady = false;
var logFilters = {sinceDays: '7', eventType: 'all', status: 'all', username: '', search: '', limit: 200};
var logTimezoneStorageKey = 'ejs-admin-log-timezone';
var browserTimezone = (Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
var logTimezone = localStorage.getItem(logTimezoneStorageKey) || browserTimezone;
var scanJobsState = [];
var scanHistoryState = [];
var scanSettingsState = {};
var activeScanJobId = '';
var scanLauncherConfig = null;

function getLogTimezoneOptions() {
  var options = ['UTC'];
  if (browserTimezone && options.indexOf(browserTimezone) === -1) {
    options.unshift(browserTimezone);
  }
  var commonZones = [
    'America/Denver',
    'America/Los_Angeles',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Australia/Sydney'
  ];
  commonZones.forEach(function(zone) {
    if (options.indexOf(zone) === -1) {
      options.push(zone);
    }
  });
  if (Intl && typeof Intl.supportedValuesOf === 'function') {
    Intl.supportedValuesOf('timeZone').forEach(function(zone) {
      if (options.indexOf(zone) === -1) {
        options.push(zone);
      }
    });
  }
  return options;
}

function formatLogTimestamp(value, timezone) {
  if (!value) {
    return '-';
  }
  var date = new Date(value);
  if (isNaN(date.getTime())) {
    return value;
  }
  var zone = timezone || browserTimezone || 'UTC';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone: zone,
      timeZoneName: 'short'
    }).format(date);
  } catch (e) {
    return date.toLocaleString();
  }
}

function formatLogIp(entry) {
  var publicIp = entry.publicIp || entry.ip || '';
  var localIp = entry.localIp || '';
  var cell = $('<div>').addClass('logs-ip-cell');
  cell.append($('<div>').text(publicIp || '-'));
  if (localIp && localIp !== publicIp) {
    cell.append($('<div>').addClass('logs-cell-subtle').text('Local: ' + localIp));
  }
  return cell;
}

function formatLogLocation(entry) {
  var summary = entry.geoSummary || entry.geo_summary || '';
  if (!summary && entry.details) {
    summary = entry.details.geoSummary || '';
  }
  var timezone = entry.geoTimezone || entry.geo_timezone || (entry.details && entry.details.geoTimezone) || '';
  var postal = entry.geoPostalCode || entry.geo_postal_code || (entry.details && entry.details.geoPostalCode) || '';
  var cell = $('<div>').addClass('logs-location-cell');
  cell.append($('<div>').text(summary || (entry.localIp || entry.ip ? 'Local network' : '-')));
  var extra = [];
  if (timezone) {
    extra.push(timezone);
  }
  if (postal) {
    extra.push(postal);
  }
  if (extra.length) {
    cell.append($('<div>').addClass('logs-cell-subtle').text(extra.join(' | ')));
  }
  return cell;
}

function changeLogTimezone() {
  var selected = $('#logTimezone').val() || browserTimezone || 'UTC';
  logTimezone = selected;
  localStorage.setItem(logTimezoneStorageKey, selected);
  socket.emit('renderlogs', logFilters);
}

function adminEndpoint(name) {
  var basePath = path.endsWith('/') ? path : path + '/';
  return basePath + name;
}

function syncAdminSession(silent) {
  if (localStorage.getItem('role') !== 'admin') {
    return;
  }
  if (!silent) {
    setAdminStatus('Restoring admin session...');
  }
  socket.emit('adminsession');
}

function advanceAdminSocketPath() {
  if (adminSocketPathIndex >= adminSocketPaths.length - 1) {
    return false;
  }
  adminSocketPathIndex += 1;
  var nextPath = adminSocketPaths[adminSocketPathIndex];
  if (socket.io && socket.io.opts) {
    socket.io.opts.path = nextPath;
  }
  socket.disconnect();
  socket.connect();
  return true;
}

function preferredRegionKey(folder) {
  return 'ejs-scan-region-' + folder;
}

function getPreferredRegion(folder) {
  return localStorage.getItem(preferredRegionKey(folder)) || '';
}

function setPreferredRegion(folder, value) {
  localStorage.setItem(preferredRegionKey(folder), value || '');
}

function setAdminStatus(message, isError) {
  $('#admin-login-status').text(message || '').toggleClass('is-error', !!isError);
}

async function authenticateAdmin(user, pass, silent) {
  if (!user || !pass) {
    if (!silent) {
      setAdminStatus('Enter an admin username and password.', true);
    }
    return;
  }
  setAdminStatus(silent ? 'Checking saved login...' : 'Logging in...');
  try {
    var response = await fetch(adminEndpoint('adminauth'), {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      body: JSON.stringify({user: user, pass: pass})
    });
    var result = await response.json();
    if (!response.ok || result.status !== 'success' || result.role !== 'admin') {
      localStorage.removeItem('role');
      if (!silent) {
        setAdminStatus('Admin login required.', true);
      } else {
        setAdminStatus('');
      }
      return;
    }
    localStorage.setItem('user', user);
    localStorage.setItem('role', result.role);
    socket.emit('adminauth', {user: user, pass: pass});
  } catch(e) {
    console.log(e);
    if (!silent) {
      setAdminStatus('Unable to reach the admin login service.', true);
    }
  }
}

async function forgotAdminPassword() {
  var user = $('#admin-login-user').val() || localStorage.getItem('user') || '';
  if (!user) {
    setAdminStatus('Enter your username first.', true);
    $('#admin-login-user').trigger('focus');
    return;
  }
  setAdminStatus('Notifying admin...');
  try {
    var response = await fetch(adminEndpoint('profileapi'), {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      body: JSON.stringify({type:'forgotpassword', user:user, source:'admin-manager'})
    });
    var result = await response.json();
    setAdminStatus(result.status === 'success' ? 'The admin has been notified.' : 'Password reset notification is not configured.', result.status !== 'success');
  } catch(e) {
    console.log(e);
    setAdminStatus('Unable to notify admin.', true);
  }
}

function adminLogout() {
  adminReady = false;
  fetch(adminEndpoint('adminlogout'), {method: 'POST'}).catch(function() {});
  localStorage.removeItem('user');
  localStorage.removeItem('role');
  $('body').addClass('admin-locked');
  $('#side').empty();
  $('#main').empty();
  $('#admin-session').empty();
  $('#nav-buttons').empty();
  setAdminStatus('Logged out.');
}

$(function() {
  var $toggle = $('#theme-toggle');

  function setTheme(theme) {
    $('html').attr('data-theme', theme);
    localStorage.setItem('ejs-admin-theme', theme);
    $toggle.text(theme === 'dark' ? 'Light mode' : 'Dark mode');
    $toggle.attr('aria-pressed', theme === 'dark');
  }

  setTheme($('html').attr('data-theme') || 'light');
  $toggle.on('click', function() {
    setTheme($('html').attr('data-theme') === 'dark' ? 'light' : 'dark');
  });
  $('#admin-login-form').on('submit', function(event) {
    event.preventDefault();
    authenticateAdmin($('#admin-login-user').val(), $('#admin-login-pass').val(), false);
  });
  $('#admin-login-user').val(localStorage.getItem('user') || '');
  syncAdminSession(true);
});

socket.on('connect', function() {
  syncAdminSession(true);
});

socket.on('disconnect', function() {
  if (adminReady) {
    setAdminStatus('Connection lost. Reconnecting...', true);
  }
});

socket.on('connect_error', function(error) {
  var message = error && error.message ? String(error.message) : '';
  if (advanceAdminSocketPath()) {
    setAdminStatus('Retrying admin connection...', true);
    console.log('Retrying admin socket with fallback path:', adminSocketPaths[adminSocketPathIndex], message);
    return;
  }
  if (adminReady) {
    setAdminStatus('Admin connection error. Retrying...', true);
  }
  console.log('Admin socket connection error:', message || error);
});

//// Socket recieves ////
socket.on('adminauth', function(result) {
  if (result.status === 'success' && result.role === 'admin') {
    adminReady = true;
    $('body').removeClass('admin-locked');
    setAdminStatus('');
    $('#admin-session').empty().append($('<span>').addClass('admin-user').text(result.user + ' (admin)'));
    $('#admin-session').append($('<button>').addClass('button hover').attr('type', 'button').on('click', adminLogout).text('Logout'));
  } else if (!adminReady) {
    $('body').addClass('admin-locked');
    setAdminStatus('Admin login required.', true);
  } else {
    setAdminStatus('Admin session unavailable. Trying to reconnect...', true);
  }
});
socket.on('scanhistoryupdated', function() {
  if ($('#main').data('view') === 'scans') {
    socket.emit('renderscans');
  }
});
// Render config
socket.on('renderconfig', renderConfig);
// Render rom
socket.on('renderrom', renderRom);
// Render configs
socket.on('renderconfigs', renderConfigs);
// Render roms directories
socket.on('renderromsdir', renderRomsDir);
// Render roms scanners
socket.on('renderromslanding', renderRomsLanding);
// Render Landing
socket.on('renderlanding', renderLanding);
// Render modal data
socket.on('modaldata', modalData);
// Empty modal
socket.on('emptymodal', emptyModal);
// Render file directories
socket.on('renderfiledirs', renderFileDirs);
// Render file directories
socket.on('renderprofiles', renderProfiles);
socket.on('renderlogs', renderLogsPage);
socket.on('renderscans', function(payload) {
  renderScansPage(payload);
});
socket.on('scanjobs', function(jobs) {
  scanJobsState = Array.isArray(jobs) ? jobs : [];
  if ($('#main').data('view') === 'scans') {
    renderScansPage({
      jobs: scanJobsState,
      scans: scanHistoryState,
      total: scanHistoryState.length,
      settings: scanSettingsState
    });
  }
  if (activeScanJobId && $('#modal').css('display') !== 'none' && $('#modal').data('modalType') === 'scan-job') {
    var activeJob = getScanJob(activeScanJobId);
    if (activeJob) {
      renderScanJobModal(activeJob, {preserveScroll: true});
    }
  }
});
socket.on('scanjobstarted', function(payload) {
  payload = payload || {};
  if (payload.job && payload.job.id) {
    activeScanJobId = payload.job.id;
    openScanJobModal(payload.job.id);
  }
  if (payload.message) {
    $('#logs-status').text(payload.message);
  }
});
socket.on('influxtest', function(result) {
  var ok = result && result.status === 'success';
  $('#logs-status').text(ok ? 'Influx test event sent.' : 'Influx test failed.');
  var lines = [
    ok ? 'Influx Test Succeeded' : 'Influx Test Failed',
    result && result.message ? result.message : (ok ? 'Influx accepted the test event.' : 'Influx did not accept the test event.')
  ];
  if (result && result.statusCode) {
    lines.push('HTTP Status: ' + result.statusCode);
  }
  if (result && result.influxUrl) {
    lines.push('Influx URL: ' + result.influxUrl);
  }
  if (result && result.influxOrg) {
    lines.push('Org: ' + result.influxOrg);
  }
  if (result && result.influxBucket) {
    lines.push('Bucket: ' + result.influxBucket);
  }
  if (result && result.requestPath) {
    lines.push('Write Path: ' + result.requestPath);
  }
  if (result && result.responseBody) {
    lines.push('');
    lines.push('Influx Response:');
    lines.push(result.responseBody);
  }
  $('#logs-influx-result')
    .removeClass('is-success is-error')
    .addClass(ok ? 'is-success' : 'is-error')
    .text(lines.join('\n'))
    .show();
});
// Render in rom data
socket.on('romdata', renderRomData);
// Render in custom metadata page
socket.on('rendermeta', renderMetaPage);
// Render meta JSON
socket.on('rendermetajson', renderMetaJSON);
socket.on('scanflagcleared', function() {
  $('.clear-scan-flag-button').prop('disabled', true).text('Rescan Queued');
});

//// Functions ////
// Grab a json file from the server
function getConfig(file) {
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  $('#main').data('name', file);
  socket.emit('getconfig', file);
}

// Grab a json file from the server
function getMeta(file) {
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  $('#main').data('name', file);
  socket.emit('getmeta', file);
}

// Get list of rom shas to process
function getRomShas(dir) {
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  $('#main').data('name', dir);
  socket.emit('getroms', dir);
}

// Render configs page
function renderConfigss() {
  socket.emit('renderconfigs');
}

// Render meta page
function renderMeta() {
  socket.emit('rendermeta');
}

// Render profiles page
function renderProfile() {
  socket.emit('renderprofiles');
}

function renderLogsView() {
  $('#main').data('view', 'logs');
  socket.emit('renderlogs', logFilters);
}

function renderScansView() {
  $('#main').data('view', 'scans');
  clearInlineScanLauncher();
  renderScansPage(scanJobsState);
  socket.emit('renderscans');
}

function clearInlineScanLauncher() {
  $('#scan-inline-launcher').remove();
}

function showInlineScanLauncher(card) {
  clearInlineScanLauncher();
  var wrapper = $('<div>').attr('id', 'scan-inline-launcher').addClass('card logs-card scan-inline-launcher');
  wrapper.append(card);
  $('#main').prepend(wrapper);
}

function getScanJob(scanId) {
  for (var job of scanJobsState) {
    if (String(job.id) === String(scanId)) {
      return job;
    }
  }
  return null;
}

function scanTypeLabel(type) {
  if (type === 'rom-scan') {
    return 'ROM Scan';
  }
  if (type === 'art-download') {
    return 'Download Art';
  }
  if (type === 'default-files') {
    return 'Default Files';
  }
  return type || 'Scan';
}

function scanModeLabel(mode) {
  if (mode === 'all') {
    return 'All items';
  }
  if (mode === 'new') {
    return 'New items only';
  }
  if (mode === 'update') {
    return 'Update';
  }
  return mode || 'Default';
}

function scanStatusLabel(status) {
  if (status === 'running') {
    return 'Running';
  }
  if (status === 'canceling') {
    return 'Canceling';
  }
  if (status === 'completed') {
    return 'Completed';
  }
  if (status === 'canceled') {
    return 'Canceled';
  }
  if (status === 'failed') {
    return 'Failed';
  }
  return status || 'Pending';
}

function openScanLauncher(config) {
  scanLauncherConfig = config || null;
  activeScanJobId = '';
  $('#modal').data('modalType', 'scan-launcher');
  emptyModal();
  var card = $('<div>').addClass('scan-modal');
  card.append($('<h2>').text(config.title || 'Start Scan'));
  if (config.description) {
    card.append($('<p>').addClass('scan-modal-copy').text(config.description));
  }
  if (config.dir) {
    card.append($('<p>').addClass('scan-modal-copy').text('Target: ' + config.dir));
  }
  if (config.type === 'rom-scan' && config.preferredRegion) {
    card.append($('<p>').addClass('scan-modal-copy').text('Preferred region: ' + config.preferredRegion));
  }
  var actions = $('<div>').addClass('scan-modal-actions');
  if (config.allowModes) {
    actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
      startScanJob(config.defaultMode === 'all' ? 'all' : 'new');
    }).text(config.primaryLabel || 'Scan New Items'));
    actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
      startScanJob('all');
    }).text(config.secondaryLabel || 'Scan All Items'));
  } else {
    actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
      startScanJob(config.mode || 'update');
    }).text(config.primaryLabel || 'Start'));
  }
  actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', closeModal).text('Close'));
  card.append(actions);
  $('#modal-content').append(card);
  showModal();
  clearInlineScanLauncher();
  if ($('#modal').css('display') === 'none') {
    showInlineScanLauncher(card.clone(true, true));
  }
}

function startScanJob(mode) {
  if (!scanLauncherConfig) {
    return;
  }
  var payload = {
    type: scanLauncherConfig.type,
    dir: scanLauncherConfig.dir || '',
    mode: mode || scanLauncherConfig.mode || '',
    preferredRegion: scanLauncherConfig.preferredRegion || ''
  };
  $('#modal-content').empty().append($('<div>').addClass('loader'));
  if ($('#scan-inline-launcher').length) {
    $('#scan-inline-launcher').empty().append($('<div>').addClass('loader'));
  }
  socket.emit('startscanjob', payload);
}

function renderScanJobModal(job, options) {
  if (!job) {
    return;
  }
  options = options || {};
  activeScanJobId = job.id;
  $('#modal').data('modalType', 'scan-job');
  var modal = $('#modal');
  var modalScrollTop = options.preserveScroll ? modal.scrollTop() : 0;
  var pageScrollTop = options.preserveScroll ? $(window).scrollTop() : 0;
  var logPane = modal.find('.scan-job-log');
  var logScrollTop = options.preserveScroll && logPane.length ? logPane.scrollTop() : 0;
  emptyModal();
  var card = $('<div>').addClass('scan-modal');
  card.append($('<h2>').text(job.label || scanTypeLabel(job.type)));
  var summary = $('<div>').addClass('scan-job-summary');
  summary.append($('<div>').append($('<strong>').text('Status')).append($('<span>').text(scanStatusLabel(job.status))));
  summary.append($('<div>').append($('<strong>').text('Mode')).append($('<span>').text(scanModeLabel(job.mode))));
  summary.append($('<div>').append($('<strong>').text('Started')).append($('<span>').text(formatLogTimestamp(job.startedAt, logTimezone))));
  if (job.endedAt) {
    summary.append($('<div>').append($('<strong>').text('Ended')).append($('<span>').text(formatLogTimestamp(job.endedAt, logTimezone))));
  }
  var result = job.result || {};
  if (result.totalItems) {
    summary.append($('<div>').append($('<strong>').text('Total')).append($('<span>').text(result.totalItems)));
  }
  if (result.newItems) {
    summary.append($('<div>').append($('<strong>').text('New')).append($('<span>').text(result.newItems)));
  }
  if (result.changedItems) {
    summary.append($('<div>').append($('<strong>').text('Changed')).append($('<span>').text(result.changedItems)));
  }
  if (result.downloadedItems) {
    summary.append($('<div>').append($('<strong>').text('Downloaded')).append($('<span>').text(result.downloadedItems)));
  }
  if (result.skippedItems) {
    summary.append($('<div>').append($('<strong>').text('Skipped')).append($('<span>').text(result.skippedItems)));
  }
  if (result.failedItems) {
    summary.append($('<div>').append($('<strong>').text('Failed')).append($('<span>').text(result.failedItems)));
  }
  card.append(summary);
  if (job.error) {
    card.append($('<div>').addClass('scan-job-error').text(job.error));
  }
  var actions = $('<div>').addClass('scan-modal-actions');
  actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
    renderScansView();
  }).text('View All Scans'));
  if (job.status === 'running' || job.status === 'canceling') {
    actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
      cancelScanJob(job.id);
    }).text('Cancel Scan'));
  }
  actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', closeModal).text('Close'));
  card.append(actions);
  card.append($('<pre>').addClass('scan-job-log').text((job.logs || []).join('\n') || 'No output yet.'));
  $('#modal-content').append(card);
  showModal();
  if (options.preserveScroll) {
    modal.scrollTop(modalScrollTop);
    $(window).scrollTop(pageScrollTop);
    modal.find('.scan-job-log').scrollTop(logScrollTop);
  }
  clearInlineScanLauncher();
  if ($('#modal').css('display') === 'none') {
    showInlineScanLauncher(card.clone(true, true));
  }
}

function openScanJobModal(scanId) {
  var job = getScanJob(scanId);
  if (!job) {
    return;
  }
  renderScanJobModal(job);
}

function cancelScanJob(scanId) {
  socket.emit('cancelscanjob', scanId);
}

function renderScansPage(payload) {
  payload = payload || {};
  if (Array.isArray(payload)) {
    payload = {jobs: payload, scans: scanHistoryState, total: scanHistoryState.length, settings: scanSettingsState};
  }
  var jobs = Array.isArray(payload.jobs) ? payload.jobs : scanJobsState;
  var scans = Array.isArray(payload.scans) ? payload.scans : scanHistoryState;
  var settings = payload.settings || scanSettingsState || {};
  scanJobsState = jobs;
  scanHistoryState = scans;
  scanSettingsState = settings;
  $('#main').data('view', 'scans');
  $('#main').empty();
  $('#side').empty();
  $('#nav-buttons').empty();
  var wrapper = $('<div>').addClass('logs-page');
  wrapper.append($('<div>').addClass('logs-header')
    .append($('<div>').append($('<h1>').text('Scans')).append($('<p>').addClass('logs-subtitle').text('View active scans, saved scan history, and where items changed.')))
    .append($('<div>').attr('id', 'scans-status').addClass('logs-status').text(jobs.filter(function(job) {
      return job.status === 'running' || job.status === 'canceling';
    }).length + ' active | ' + scans.length + ' stored of ' + (payload.total || scans.length))));

  var settingsCard = $('<div>').addClass('card logs-card');
  settingsCard.append($('<h3>').text('Storage & Retention'));
  var settingsGrid = $('<div>').addClass('logs-filter-grid logs-settings-grid');
  settingsGrid.append($('<label>').text('Local scan history enabled').append($('<input>').attr({id: 'localScansEnabled', type: 'checkbox'}).prop('checked', settings.localScansEnabled !== false)));
  settingsGrid.append($('<label>').text('Retention (days)').append($('<input>').attr({id: 'localScanRetentionDays', type: 'number', min: 1, max: 3650}).val(settings.localScanRetentionDays || 90)));
  settingsCard.append(settingsGrid);
  settingsCard.append($('<div>').addClass('logs-inline-note').text('Webhook and Influx forwarding reuse the Activity Logs settings. Webhook: ' + (settings.webhookConfigured ? 'configured' : 'not configured') + '. Influx: ' + (settings.influxConfigured ? 'configured' : (settings.influxEnabled ? 'enabled but incomplete' : 'disabled')) + '.'));
  settingsCard.append($('<div>').addClass('logs-button-row')
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', saveScanSettings).text('Save Scan Settings'))
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', renderLogsView).text('Open Activity Log Settings')));
  wrapper.append(settingsCard);

  var activeCard = $('<div>').addClass('card logs-card');
  activeCard.append($('<h3>').text('Active / Recent Jobs'));
  if (!jobs.length) {
    activeCard.append($('<p>').addClass('logs-empty').text('No scan jobs are active right now.'));
  } else {
    var tableWrap = $('<div>').addClass('logs-table-wrap');
    var table = $('<table>').addClass('logs-table');
    table.append($('<thead>').append($('<tr>')
      .append($('<th>').text('When'))
      .append($('<th>').text('Type'))
      .append($('<th>').text('Target'))
      .append($('<th>').text('Mode'))
      .append($('<th>').text('Status'))
      .append($('<th>').text('Summary'))
      .append($('<th>').text('Actions'))));
    var body = $('<tbody>');
    jobs.forEach(function(job) {
      var row = $('<tr>');
      var result = job.result || {};
      var summaryBits = [];
      if (result.totalItems) summaryBits.push('Total: ' + result.totalItems);
      if (result.newItems) summaryBits.push('New: ' + result.newItems);
      if (result.changedItems) summaryBits.push('Changed: ' + result.changedItems);
      if (result.downloadedItems) summaryBits.push('Downloaded: ' + result.downloadedItems);
      if (result.failedItems) summaryBits.push('Failed: ' + result.failedItems);
      row.append($('<td>').text(formatLogTimestamp(job.startedAt, logTimezone)));
      row.append($('<td>').text(scanTypeLabel(job.type)));
      row.append($('<td>').text(job.dir || 'default'));
      row.append($('<td>').text(scanModeLabel(job.mode)));
      row.append($('<td>').text(scanStatusLabel(job.status)));
      row.append($('<td>').text(summaryBits.join(' | ') || '-'));
      var actions = $('<div>').addClass('logs-button-row');
      actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
        openScanJobModal(job.id);
      }).text('Open'));
      if (job.status === 'running' || job.status === 'canceling') {
        actions.append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
          cancelScanJob(job.id);
        }).text('Cancel'));
      }
      row.append($('<td>').append(actions));
      body.append(row);
    });
    table.append(body);
    tableWrap.append(table);
    activeCard.append(tableWrap);
  }
  wrapper.append(activeCard);

  var historyCard = $('<div>').addClass('card logs-card');
  historyCard.append($('<h3>').text('Stored Scan History'));
  if (!scans.length) {
    historyCard.append($('<p>').addClass('logs-empty').text('No completed scan history has been stored yet.'));
  } else {
    var historyWrap = $('<div>').addClass('logs-table-wrap');
    var historyTable = $('<table>').addClass('logs-table');
    historyTable.append($('<thead>').append($('<tr>')
      .append($('<th>').text('When'))
      .append($('<th>').text('Type'))
      .append($('<th>').text('Target'))
      .append($('<th>').text('Mode'))
      .append($('<th>').text('Status'))
      .append($('<th>').text('Summary'))));
    var historyBody = $('<tbody>');
    scans.forEach(function(scan) {
      var summaryBits = [];
      if (scan.total_items) summaryBits.push('Total: ' + scan.total_items);
      if (scan.new_items) summaryBits.push('New: ' + scan.new_items);
      if (scan.changed_items) summaryBits.push('Changed: ' + scan.changed_items);
      if (scan.downloaded_items) summaryBits.push('Downloaded: ' + scan.downloaded_items);
      if (scan.skipped_items) summaryBits.push('Skipped: ' + scan.skipped_items);
      if (scan.failed_items) summaryBits.push('Failed: ' + scan.failed_items);
      historyBody.append($('<tr>')
        .append($('<td>').text(formatLogTimestamp(scan.timestamp, logTimezone)))
        .append($('<td>').text(scanTypeLabel(scan.scan_type)))
        .append($('<td>').text(scan.target || 'default'))
        .append($('<td>').text(scanModeLabel(scan.mode)))
        .append($('<td>').text(scanStatusLabel(scan.status)))
        .append($('<td>').text(summaryBits.join(' | ') || '-')));
    });
    historyTable.append(historyBody);
    historyWrap.append(historyTable);
    historyCard.append(historyWrap);
  }
  wrapper.append(historyCard);
  $('#main').append(wrapper);
}

// Render roms landing page
async function renderRomsLanding(counts) {
  $('#main').empty();
  var scanRendered = false;
  var cardContainer = $('<div>').addClass('cardcontainer');
  for await (var emu of Object.keys(counts)) {
    if (counts[emu].roms > 0) {
      var card = $('<div>').addClass('card');
      card.append($('<h2>').text(emu));
      card.append($('<p>').text('Roms: ' + counts[emu].roms));
      card.append($('<p>').text('Scanned: ' + counts[emu].hashes));
      var button = $('<button>').addClass('scanbutton hover').text('Scan');
      button.on('click', function(folder) {
        return function() {
          scanRoms(folder);
        };
      }(emu));
      card.append(button);
      $(cardContainer).append(card);
      var scanRendered = true;
    } else if (emu == 'default') {
      var card = $('<div>').addClass('card');
      card.append($('<h2>').text('Default'));
      card.append($('<p>').text('Available: ' + counts[emu].available));
      card.append($('<p>').text('Downloaded: ' + counts[emu].downloaded));
      var button = $('<button>').addClass('scanbutton hover').text('DL/Update');
      button.on('click', dlDefaultFiles);
      card.append(button);
      $(cardContainer).append(card);
    };
  };
  if (! scanRendered) {
    var scanWarning = $('<h1>').text('No roms found please add some to continue');
    $(cardContainer).append(scanWarning);
  };
  $('#main').append(cardContainer, $('#rominfo').html());
}

// Render roms page
function renderRoms() {
  socket.emit('renderroms');
}

// Scan in a roms directory
function scanRoms(folder) {
  openScanLauncher({
    type: 'rom-scan',
    dir: folder,
    title: 'Scan ROMs',
    description: 'Choose whether to scan every ROM in this system or only items that have not been scanned yet.',
    allowModes: true,
    primaryLabel: 'Scan New Items',
    secondaryLabel: 'Scan All Items',
    preferredRegion: getPreferredRegion(folder)
  });
}

// Scan in a roms directory
function newScan(folder) {
  openScanLauncher({
    type: 'rom-scan',
    dir: folder,
    title: 'Scan ROMs',
    description: 'This will focus on new or rescanned items by default. You can still choose a full scan if you want.',
    allowModes: true,
    primaryLabel: 'Scan New Items',
    secondaryLabel: 'Scan All Items',
    defaultMode: 'new',
    preferredRegion: getPreferredRegion(folder)
  });
}

// Link metadata for selected rom
function setMeta() {
  var linkHash = $('#gameselection').val();
  if (!linkHash) {
    alert('Choose a ROM metadata match first.');
    return;
  }
  var hash = $('#modal').data('hash');
  var dir = $('#main').data('name');
  closeModal();
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('usermeta', [hash, linkHash, dir]);
}

// Send output to modal
function modalData(data) {
  $('#modal-content').prepend('<p>' + data + '</p>');
}

// Empty modal
function emptyModal() {
  $('#modal-content').empty();
}

function showModal() {
  $('body').addClass('modal-open');
  $('#modal').css({'display': 'block', 'z-index': 100000});
}

// Close modal
function closeModal() {
  scanLauncherConfig = null;
  activeScanJobId = '';
  $('#modal').removeData('modalType');
  emptyModal();
  clearInlineScanLauncher();
  $('body').removeClass('modal-open');
  $('#modal').css('display', 'none');
}

// Render config file list
function renderConfigs(files) {
  $('#main').empty();
  $('#side').empty();
  $('#nav-buttons').empty();
  $.each(files, function(index, file) {
    var file = file.replace('.json','');
    var sideLink = $('<div>').addClass('sideitem hover').attr('onclick', "getConfig('" + file + "')").text(file);
    $('#side').append(sideLink);
  });
  $('#main').append($('<h1>').addClass('readme').text('Open a config to edit (main for landing page)'));
}

// Render meta file list
function renderMetaPage(files) {
  $('#main').empty();
  $('#main').append($('#metainfo').html());
  $('#side').empty();
  $('#nav-buttons').empty();
  $.each(files, function(index, file) {
    var file = file.replace('.json','');
    var sideLink = $('<div>').addClass('sideitem hover').attr('onclick', "getMeta('" + file + "')").text(file);
    $('#side').append(sideLink);
  });
}

// Render Roms file list
function renderRomsDir(dirs) {
  $('#side').empty();
  $('#nav-buttons').empty();
  $.each(dirs, function(index, dir) {
    var sideLink = $('<div>').addClass('sideitem hover').attr('onclick', "getRomShas('" + dir + "')").text(dir);
    $('#side').append(sideLink);
  });
}

// Save modified config
async function saveConfig() {
  var name = $('#main').data('name');
  var editor = ace.edit("editor");
  var json = editor.getValue();
  var config = JSON.parse(json);
  socket.emit('saveconfig', {'config': config, 'name': name});
  socket.emit('renderconfigs');
}

// Save romlist to config file
function addToConfig(name) {
  if (!confirm('Add all identified ROMs to the ' + name + ' config? This will rewrite the generated items list.')) {
    return;
  }
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('addtoconfig', name);
}

// Remove roms with no art from config
function purgeNoArt(name) {
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('purgenoart', name);
}

// Download art for all identified roms
function downloadArt(name) {
  openScanLauncher({
    type: 'art-download',
    dir: name,
    title: 'Download Available Art',
    description: 'Choose whether to process everything or only new items. Existing downloads and prior failures are skipped during new-only runs.',
    allowModes: true,
    primaryLabel: 'Download New Items',
    secondaryLabel: 'Download All Items',
    defaultMode: 'new'
  });
}

// Tell server to download the default file set
function dlDefaultFiles() {
  openScanLauncher({
    type: 'default-files',
    dir: 'default',
    title: 'Download / Update Default Files',
    description: 'This updates the shared default fileset and refreshes generated configs for systems that already have scanned ROMs.',
    allowModes: false,
    primaryLabel: 'Start Update',
    mode: 'update'
  });
}

// Render in a config file
async function renderConfig(config) {
  // Save button
  $('#nav-buttons').empty();
  var save = $('<button>').addClass('button hover').attr('onclick', 'saveConfig()').text('Save');
  $('#nav-buttons').append(save);
  // Main edit window
  $('#main').empty();
  $('#main').append($('<div>').attr('id', 'editor'));
  editor = ace.edit('editor');
  editor.setTheme('ace/theme/chrome');
  editor.session.setMode('ace/mode/json');
  editor.$blockScrolling = Infinity;
  editor.setOptions({
    readOnly: false,
  });
  var json = JSON.stringify(config, null, 2);
  editor.setValue(json, -1);
}

// Render in a config file
async function renderMetaJSON(meta) {
  // Main edit window
  $('#main').empty();
  $('#main').append($('<div>').attr('id', 'editor'));
  editor = ace.edit('editor');
  editor.setTheme('ace/theme/chrome');
  editor.session.setMode('ace/mode/json');
  editor.$blockScrolling = Infinity;
  editor.setOptions({
    readOnly: false,
  });
  var json = JSON.stringify(meta, null, 2);
  editor.setValue(json, -1);
}

// Render in roms data
async function renderRom(data) {
  $('#main').empty();
  $('#main').data('unidentified', data[1]);
  $('#main').data('metadata', data[2]);
  $('#side').empty();
  // Render Legend
  let container = $('<div>').addClass('wrapper');
  $('#main').append(container);
  let identified = $('<div>').attr('id','left').append('<h3>Identified Roms:</h3>');
  let unidentified = $('<div>').attr('id','right').append('<h3>Unidentified Roms:</h3>');
  container.append(identified,unidentified);
  // Process buttons
  let folderName = $('#main').data('name');
  let regionControls = $('<div>').addClass('scan-region-controls');
  let regionSelect = $('<select>').attr('id', 'preferredScanRegion');
  for (let region of ['', 'USA', 'Europe', 'Japan', 'World']) {
    regionSelect.append($('<option>').attr('value', region).text(region || 'No preferred scan region'));
  }
  regionSelect.val(getPreferredRegion(folderName));
  regionSelect.on('change', function() {
    setPreferredRegion(folderName, $(this).val());
  });
  regionControls.append($('<label>').attr('for', 'preferredScanRegion').text('Preferred scan region'), regionSelect);
  $('#side').append(regionControls);
  let downloadArtButton = $('<button>').addClass('button hover').text('Download All Available Art');
  downloadArtButton.on('click', function() {
    downloadArt(folderName);
  });
  $('#side').append($('<p>').text('Step 1:'));
  $('#side').append(downloadArtButton);
  let configButton = $('<button>').addClass('button hover').attr('onclick', 'addToConfig(\'' + folderName + '\');').text('Add All Roms to Config');
  $('#side').append($('<p>').text('Step 2:'));
  $('#side').append(configButton);
  $('#side').append($('<p>').text('Optional:'));
  let noArtButton = $('<button>').addClass('button hover').attr('onclick', 'purgeNoArt(\'' + folderName + '\');').text('Remove Roms with No Art');
  $('#side').append(noArtButton);
  let newScanButton = $('<button>').addClass('button hover').text('Scan for New Items');
  newScanButton.on('click', function() {
    newScan(folderName);
  });
  $('#side').append(newScanButton);
  // Render items
  for await (var idItem of Object.keys(data[0])) {
    if (data[0][idItem].has_art == true) {
      var color = 'var(--success-bg)';
    } else if (data[0][idItem].has_art == false) {
      var color = 'var(--danger-bg)';
    } else if (data[0][idItem].has_art == 'none') {
      var color = 'var(--muted-bg)';
    };
    var item = $('<div>').addClass('itemwrapper').css('background-color', color).html($('<p>').addClass('item').text(idItem)).attr('onclick', 'romMenu(\'' + idItem.replaceAll("'","|") + '\')');
    identified.append(item)
  };
  for await (var noIdItem of Object.keys(data[1])) {
    var item = $('<div>').addClass('itemwrapper').css('background-color', 'var(--muted-bg)').html($('<p>').addClass('item').text(noIdItem)).attr('onclick', 'romMenu(\'' + noIdItem.replaceAll("'","|") + '\')');
    unidentified.append(item)
  };
}

// Render rom menu modal
function romMenu(cleanName) {
  let dir = $('#main').data('name');
  name = cleanName.replaceAll("|","'");
  $('#modal').data('name', name);
  emptyModal();
  $('#modal-content').append('<div class="loader"></div>');
  showModal();
  socket.emit('getromdata', [dir, name]);
}

// Render rom data we get
async function renderRomData(data) {
  $('#modal').data('hash', data.hash);
  let metaVars = ['back','corner','logo','vid'];
  let dir = $('#main').data('name');
  let basePath = 'frontend/user/';
  emptyModal();
  previewFrame = $('<iframe>').attr({src: 'frontend/index.html#preview', id: 'preview-iframe'});
  $('#modal-content').append(previewFrame);
  let manage = $('<div>').attr('id', 'rom-manage');
  let fileLink = $('<a>').attr('href', basePath + dir + '/roms/' + data.file).text(data.file);
  let fileName = $('<p>').text('Rom File: ').append(fileLink);
  manage.append(fileName);
  if (data.variantInfo) {
    if (data.variantInfo.title && data.variantInfo.title !== data.file) {
      manage.append($('<p>').text('Parsed Title: ' + data.variantInfo.title));
    }
    if (data.variantInfo.region) {
      manage.append($('<p>').text('Region: ' + data.variantInfo.region));
    }
    if (data.variantInfo.version) {
      manage.append($('<p>').text('Version: ' + data.variantInfo.version));
    }
    if (Array.isArray(data.variantInfo.codeTooltips) && data.variantInfo.codeTooltips.length) {
      let list = $('<ul>').addClass('variant-code-list');
      data.variantInfo.codeTooltips.forEach(function(code) {
        list.append($('<li>').text(code.code + ': ' + code.description));
      });
      manage.append($('<div>').append($('<p>').text('GoodTools codes:')).append(list));
    }
  }
  if (data.metadata.hasOwnProperty('name')) {
    let name = $('<p>').text('Meta Name: ' + data.metadata.name);
    manage.append(name);
  } else {
    let name = $('<p>').text('Meta Name: Unidentified or NA');
    manage.append(name);
  }
  let hash = $('<p>').text('Scanned Hash: ' + data.hash);
  manage.append(hash);
  for await (let asset of metaVars) {
    if (data[asset]) {
      let link = $('<a>').attr('href', basePath + data[asset]).text(data[asset]);
      let text = $('<p>').text(asset + ': ').append(link);
      manage.append(text);
    } else {
      let text = $('<p>').text(asset + ': Default or not found');
      manage.append(text);
    }
  }
  if (data.metadata.hasOwnProperty('video_position')) {
    var vidPos = data.metadata.video_position;
  } else {
    var vidPos = '';
  }
  if (data.vid) {
    let vidInput = $('<p>').text('Video Position: ');
    let posInput = $('<input>').attr({id: 'vidPos', type: 'text', value: vidPos});
    let posButton = $('<button>').addClass('button hover').text('Update').attr('onclick', 'updateVidPos()');
    vidInput.append(posInput,posButton);
    manage.append(vidInput);
  }
  let buttonWrapper = $('<div>').attr('id', 'manage-buttons');
  if (data.metadata) {
    for await (let upload of metaVars) {
      let uploadButton = $('<button>').addClass('manage-button').text('Upload ' + upload);
      uploadButton.attr('onclick',"$('#" + upload + "').trigger('click')");
      let uploadInput = $('<input>').addClass('hidden').attr({id: upload, type: 'file', onchange: 'upload(this)'});
      buttonWrapper.append(uploadButton,uploadInput);
    }
    let unIdentifyButton = $('<button>').addClass('manage-button').text('Purge Art/Metadata');
    buttonWrapper.append(unIdentifyButton.attr('onclick','unIdentify(false)'));
  } else {
    let identifyButton = $('<button>').addClass('manage-button').text('Identify Rom');
    buttonWrapper.append(identifyButton.attr('onclick','identify()'));
  }
  let deleteButton = $('<button>').addClass('manage-button').text('Delete Everything');
  buttonWrapper.append(deleteButton.attr('onclick','unIdentify(true)'));
  if (data.scanFlag) {
    let rescanButton = $('<button>').addClass('manage-button clear-scan-flag-button').text('Clear Scan Flag');
    buttonWrapper.append(rescanButton.attr('onclick','clearScanFlag()'));
  }
  manage.append(buttonWrapper);
  $('#modal-content').append(manage);
}

// Prompt user to identify rom
async function identify() {
  let file = $('#modal').data('name');
  $('#rom-manage').empty();
  $('#rom-manage').append('<p>Identify: ' + file + '</p>');
  var metaData = $('#main').data('metadata');
  var options = [];
  for await (sha of Object.keys(metaData)) {
    if (metaData[sha].hasOwnProperty('name')) {
      options.push({'sha': sha, 'name': metaData[sha].name});
    }
  };

  var sel = $('<select>').attr('id', 'gameselection');
  var filter = $('<input>').attr({id: 'gameSelectionFilter', type: 'search', placeholder: 'Search metadata options'});

  var sorted = options.sort((a,b) => (a.name > b.name) ? 1 : -1);
  function optionRank(option) {
    return file.startsWith(option.name) ? 0 : 1;
  }
  function renderGameSelection(term) {
    var normalized = (term || '').toLowerCase().trim();
    var filtered = sorted.filter(function(option) {
      return !normalized || option.name.toLowerCase().indexOf(normalized) !== -1;
    });
    filtered.sort(function(a, b) {
      var rank = optionRank(a) - optionRank(b);
      if (rank !== 0) {
        return rank;
      }
      return a.name.localeCompare(b.name);
    });
    sel.empty();
    if (filtered.length === 0) {
      sel.append($("<option>").attr('value','').text('No matches'));
      return;
    }
    for (var option of filtered.slice(0, 300)) {
      sel.append($("<option>").attr('value',option.sha).text(option.name));
    }
  }
  filter.on('input', function() {
    renderGameSelection($(this).val());
  });
  renderGameSelection('');
  $('#rom-manage').append($('<div>').addClass('identify-combo').append(filter, sel));
  var setMetaButton = $('<button>').addClass('button hover').attr('onclick', 'setMeta()').text('Link Item');
  $('#rom-manage').append(setMetaButton);
  $('#rom-manage').append($('<h3>').text('Rom not found?:'));
  let idInput = $('<p>').text('Custom Rom: ');
  let nameInput = $('<input>').attr({id: 'customName', type: 'text', placeholder: 'Enter a custom name'});
  let idButton = $('<button>').addClass('button hover').text('Identify').attr('onclick', 'setCustomMeta()');
  idInput.append(nameInput,idButton);
  $('#rom-manage').append(idInput);
}

// Remove identified roms link if it exists
function unIdentify(purge) {
  if (purge && !confirm('Delete this ROM, hash, and any downloaded art? This cannot be undone.')) {
    return;
  }
  let hash = $('#modal').data('hash');
  let dir = $('#main').data('name');
  let file = $('#modal').data('name');
  closeModal();
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('removemeta', [hash, dir, file, purge]);
}

function clearScanFlag() {
  if (!confirm('Clear this ROM scan flag? It will be rescanned the next time you scan only new items.')) {
    return;
  }
  let dir = $('#main').data('name');
  let file = $('#modal').data('name');
  socket.emit('clearromscan', [dir, file]);
  $('.clear-scan-flag-button').prop('disabled', true).text('Rescan Queued');
}

// Set custom metadata for a rom
function setCustomMeta() {
  let hash = $('#modal').data('hash');
  let dir = $('#main').data('name');
  let name = $('#customName').val();
  closeModal();
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('custommeta', [hash, dir, name]);
}

// Handle art uploads
async function upload(input) {
  let fileType = $(input).attr('id');
  let dir = $('#main').data('name');
  let file = $('#modal').data('name');
  let hash = $('#modal').data('hash');
  if (input.files && input.files[0]) {
    emptyModal();
    $('#modal-content').append('<div class="loader"></div>');
    let reader = new FileReader();
    reader.onload = async function(e) {
      if (e.total < 100000000) {
        let data = e.target.result;
        socket.emit('uploadart', [fileType, dir, file, hash, data]);
      } else {
        emptyModal();
        $('#modal-content').append($('<h2>').text('File too big'));
        await new Promise(resolve => setTimeout(resolve, 2000));
        socket.emit('getromdata', [dir, name]);
      }
    }
    reader.readAsArrayBuffer(input.files[0]);
  }
}

// Handle request to change video position
function updateVidPos() {
  let dir = $('#main').data('name');
  let file = $('#modal').data('name');
  let hash = $('#modal').data('hash');
  let position = $('#vidPos').val();
  emptyModal();
  $('#modal-content').append('<div class="loader"></div>');
  socket.emit('updatevidposition', [dir, file, hash, position]);
}

// Render in landing
function renderLanding() {
  // Clear page
  $('#main').empty();
  $('#side').empty();
  $('#main').append($('#landing').html());
}

function closeExpandedLogDetails(exceptEventId) {
  $('.logs-detail-row.is-open').each(function() {
    var detailRow = $(this);
    var eventId = detailRow.data('eventId');
    if (String(eventId) === String(exceptEventId)) {
      return;
    }
    detailRow.removeClass('is-open');
    $('#log-details-button-' + eventId).text('Details').attr('aria-expanded', 'false');
  });
}

function openLogDetails(eventId) {
  var detailRow = $('#log-detail-row-' + eventId);
  var button = $('#log-details-button-' + eventId);
  if (!detailRow.length || !button.length) {
    return;
  }
  var isOpen = detailRow.hasClass('is-open');
  closeExpandedLogDetails(eventId);
  if (isOpen) {
    detailRow.removeClass('is-open');
    button.text('Details').attr('aria-expanded', 'false');
    return;
  }
  detailRow.addClass('is-open');
  button.text('Hide Details').attr('aria-expanded', 'true');
}

function saveLogSettings() {
  socket.emit('savelogsettings', {
    localLogsEnabled: $('#localLogsEnabled').is(':checked'),
    localLogRetentionDays: $('#localLogRetentionDays').val(),
    influxEnabled: $('#influxEnabled').is(':checked'),
    influxUrl: $('#influxUrl').val(),
    influxOrg: $('#influxOrg').val(),
    influxBucket: $('#influxBucket').val(),
    influxToken: $('#influxToken').val(),
    clearInfluxToken: $('#clearInfluxToken').is(':checked'),
    filters: logFilters
  });
}

function saveScanSettings() {
  socket.emit('savescansettings', {
    localScansEnabled: $('#localScansEnabled').is(':checked'),
    localScanRetentionDays: $('#localScanRetentionDays').val()
  });
}

function testInfluxSettings() {
  $('#logs-status').text('Testing Influx...');
  socket.emit('testlogsinflux', {
    influxEnabled: $('#influxEnabled').is(':checked'),
    influxUrl: $('#influxUrl').val(),
    influxOrg: $('#influxOrg').val(),
    influxBucket: $('#influxBucket').val(),
    influxToken: $('#influxToken').val()
  });
}

function applyLogFilters() {
  logFilters = {
    sinceDays: $('#logSinceDays').val(),
    eventType: $('#logEventType').val(),
    status: $('#logStatus').val(),
    username: $('#logUsername').val(),
    search: $('#logSearch').val(),
    limit: 200
  };
  socket.emit('renderlogs', logFilters);
}

function renderLogsPage(payload) {
  payload = payload || {};
  logFilters = Object.assign({}, logFilters, payload.filters || {});
  var settings = payload.settings || {};
  var events = payload.events || [];
  $('#main').empty();
  $('#side').empty();
  $('#nav-buttons').empty();

  var wrapper = $('<div>').addClass('logs-page');
  var heading = $('<div>').addClass('logs-header');
  heading.append($('<div>').append($('<h1>').text('Activity Logs')).append($('<p>').addClass('logs-subtitle').text('Readable local logs with optional Influx forwarding.')));
  heading.append($('<div>').attr('id', 'logs-status').addClass('logs-status').text('Showing ' + events.length + ' of ' + (payload.total || 0) + ' events.'));
  wrapper.append(heading);

  var filterCard = $('<div>').addClass('card logs-card');
  filterCard.append($('<h3>').text('Filters'));
  var filterGrid = $('<div>').addClass('logs-filter-grid');
  filterGrid.append($('<label>').text('Last').append($('<select>').attr('id', 'logSinceDays')
    .append($('<option>').attr('value', '1').text('24 hours'))
    .append($('<option>').attr('value', '7').text('7 days'))
    .append($('<option>').attr('value', '30').text('30 days'))
    .append($('<option>').attr('value', '90').text('90 days'))
    .append($('<option>').attr('value', 'all').text('All time')).val(String(logFilters.sinceDays || '7'))));
  filterGrid.append($('<label>').text('Event').append($('<select>').attr('id', 'logEventType')
    .append($('<option>').attr('value', 'all').text('All events'))
    .append($('<option>').attr('value', 'login_success').text('Login success'))
    .append($('<option>').attr('value', 'login_failed').text('Login failed'))
    .append($('<option>').attr('value', 'login_throttled').text('Login throttled'))
    .append($('<option>').attr('value', 'admin_login_success').text('Admin login success'))
    .append($('<option>').attr('value', 'admin_login_failed').text('Admin login failed'))
    .append($('<option>').attr('value', 'admin_login_throttled').text('Admin login throttled'))
    .append($('<option>').attr('value', 'game_started').text('Game started'))
    .append($('<option>').attr('value', 'password_reset_requested').text('Password reset'))
    .append($('<option>').attr('value', 'influx_test').text('Influx test')).val(logFilters.eventType || 'all')));
  filterGrid.append($('<label>').text('Status').append($('<select>').attr('id', 'logStatus')
    .append($('<option>').attr('value', 'all').text('All statuses'))
    .append($('<option>').attr('value', 'success').text('Success'))
    .append($('<option>').attr('value', 'failed').text('Failed'))
    .append($('<option>').attr('value', 'blocked').text('Blocked')).val(logFilters.status || 'all')));
  filterGrid.append($('<label>').text('Username').append($('<input>').attr({id: 'logUsername', type: 'text', placeholder: 'eugene'}).val(logFilters.username || '')));
  filterGrid.append($('<label>').text('Search').append($('<input>').attr({id: 'logSearch', type: 'text', placeholder: 'game, IP, console...'}).val(logFilters.search || '')));
  filterCard.append(filterGrid);
  filterCard.append($('<div>').addClass('logs-button-row')
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', applyLogFilters).text('Apply Filters'))
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() {
      logFilters = {sinceDays: '7', eventType: 'all', status: 'all', username: '', search: '', limit: 200};
      socket.emit('renderlogs', logFilters);
    }).text('Reset')));
  var settingsCard = $('<div>').addClass('card logs-card');
  settingsCard.append($('<h3>').text('Storage & Forwarding'));
  var settingsGrid = $('<div>').addClass('logs-filter-grid logs-settings-grid');
  settingsGrid.append($('<label>').text('Local logs enabled').append($('<input>').attr({id: 'localLogsEnabled', type: 'checkbox'}).prop('checked', settings.localLogsEnabled !== false)));
  settingsGrid.append($('<label>').text('Retention (days)').append($('<input>').attr({id: 'localLogRetentionDays', type: 'number', min: 1, max: 3650}).val(settings.localLogRetentionDays || 90)));
  settingsGrid.append($('<label>').text('Influx enabled').append($('<input>').attr({id: 'influxEnabled', type: 'checkbox'}).prop('checked', settings.influxEnabled === true)));
  settingsGrid.append($('<label>').text('Influx URL').append($('<input>').attr({id: 'influxUrl', type: 'text', placeholder: 'https://influx.example.com'}).val(settings.influxUrl || '')));
  settingsGrid.append($('<label>').text('Influx Org').append($('<input>').attr({id: 'influxOrg', type: 'text', placeholder: 'home'}).val(settings.influxOrg || '')));
  settingsGrid.append($('<label>').text('Influx Bucket').append($('<input>').attr({id: 'influxBucket', type: 'text', placeholder: 'emulatorjs'}).val(settings.influxBucket || '')));
  settingsGrid.append($('<label>').text('Influx Token').append($('<input>').attr({id: 'influxToken', type: 'password', placeholder: settings.influxTokenConfigured ? 'Token configured - leave blank to keep' : 'Paste new token'})));
  settingsGrid.append($('<label>').text('Clear saved token').append($('<input>').attr({id: 'clearInfluxToken', type: 'checkbox'}).prop('checked', false)));
  settingsCard.append(settingsGrid);
  settingsCard.append($('<pre>').attr('id', 'logs-influx-result').addClass('logs-influx-result').hide());
  settingsCard.append($('<div>').addClass('logs-inline-note').text('Webhook destination: ' + (settings.webhookConfigured ? 'configured' : 'not configured') + '. Influx token stays on the server unless you save a new one.'));
  settingsCard.append($('<div>').addClass('logs-button-row')
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', saveLogSettings).text('Save Log Settings'))
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', testInfluxSettings).text('Test Influx')));
  wrapper.append(settingsCard);
  wrapper.append(filterCard);

  var tableCard = $('<div>').addClass('card logs-card');
  var tableHeader = $('<div>').addClass('logs-table-header');
  tableHeader.append($('<h3>').text('Recent Events'));
  var timezoneLabel = $('<label>').addClass('logs-timezone-picker').text('Timezone');
  var timezoneSelect = $('<select>').attr('id', 'logTimezone');
  getLogTimezoneOptions().forEach(function(zone) {
    timezoneSelect.append($('<option>').attr('value', zone).text(zone));
  });
  timezoneSelect.val(logTimezone);
  timezoneSelect.on('change', changeLogTimezone);
  timezoneLabel.append(timezoneSelect);
  tableHeader.append(timezoneLabel);
  tableCard.append(tableHeader);
  var tableWrap = $('<div>').addClass('logs-table-wrap');
  var table = $('<table>').addClass('logs-table');
  table.append($('<thead>').append($('<tr>')
    .append($('<th>').text('When'))
    .append($('<th>').text('Event'))
    .append($('<th>').text('User'))
    .append($('<th>').text('Source'))
    .append($('<th>').text('IP'))
    .append($('<th>').text('Location'))
    .append($('<th>').text('Game / Details'))
    .append($('<th>').text('View'))));
  var body = $('<tbody>');
  if (!events.length) {
    body.append($('<tr>').append($('<td>').attr('colspan', 8).addClass('logs-empty').text('No events matched the current filters.')));
  } else {
    $.each(events, function(index, entry) {
      var row = $('<tr>').attr('id', 'log-row-' + entry.id);
      row.append($('<td>').text(formatLogTimestamp(entry.timestamp, logTimezone)));
      row.append($('<td>').text((entry.title || entry.event_type || 'Event') + (entry.status ? ' (' + entry.status + ')' : '')));
      row.append($('<td>').text(entry.username || '-'));
      row.append($('<td>').text(entry.source || '-'));
      row.append($('<td>').append(formatLogIp(entry)));
      row.append($('<td>').append(formatLogLocation(entry)));
      row.append($('<td>').text(entry.game_name ? entry.game_name + (entry.console_title ? ' - ' + entry.console_title : '') : (entry.host || '-')));
      row.append($('<td>').append($('<button>').addClass('button hover').attr({id: 'log-details-button-' + entry.id, type: 'button', 'aria-expanded': 'false'}).on('click', function() { openLogDetails(entry.id); }).text('Details')));
      body.append(row);
      body.append(
        $('<tr>')
          .attr('id', 'log-detail-row-' + entry.id)
          .addClass('logs-detail-row')
          .data('eventId', entry.id)
          .append(
            $('<td>')
              .attr('colspan', 8)
              .append(
                $('<div>')
                  .addClass('logs-detail-box')
                  .append($('<div>').addClass('logs-detail-title').text('Event Details'))
                  .append($('<pre>').addClass('log-details-json').text(JSON.stringify(entry.details || {}, null, 2)))
              )
          )
      );
    });
  }
  table.append(body);
  tableWrap.append(table);
  tableCard.append(tableWrap);
  wrapper.append(tableCard);
  $('#main').append(wrapper);
}

// Render file management
function renderFiles() {
  $('#main').empty();
  $('#side').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('renderfiles');
}

// Render file directories
function renderFileDirs(dirs) {
  $('#side').empty();
  $('#main').empty();
  $('#main').append($('#filelanding').html());
  $('#nav-buttons').empty();
  $.each(dirs, function(index, dir) {
    var sideLink = $('<div>').addClass('sideitem hover').attr('onclick', "renderFileBrowser('" + dir + "')").text(dir);
    $('#side').append(sideLink);
  });
}

// Tell server to configure a file browser
function renderFileBrowser(dir) {
  $('#main').empty();
  var url = window.location.href;
  if (! url.endsWith('/')) {
    var url = url + '/';
  };
  var browser = $('<iframe>').attr('src', url + 'files/fs/' + dir).addClass('browser');
  $('#main').append(browser);
}

// Render profiles
function renderProfiles(profiles) {
  $('#side').empty();
  $('#main').empty();
  $('#nav-buttons').empty();
  $('#main').append($('<h1>').addClass('readme').text('Choose a Profile or Create one:'));
  let userForm = $('<span>').addClass('readme');
  userForm.append($('<input>').attr({id:'user',type:'text',placeholder:'username'}));
  userForm.append($('<input>').attr({id:'pass',type:'password',placeholder:'password'}));
  userForm.append($('<button>').addClass('button hover').attr('onclick','createProfile()').text('Create Profile'));
  $('#main').append(userForm);
  profiles.push('default');
  profiles.sort();
  $.each(profiles, function(index, profile) {
    var sideLink = $('<div>').addClass('sideitem hover').attr('onclick', "renderUserProfile('" + profile + "')").text(profile);
    $('#side').append(sideLink);
  });
}

// Render a profile
function renderUserProfile(dir) {
  $('#main').empty();
  $('#nav-buttons').empty();
  var url = window.location.href;
  if (! url.endsWith('/')) {
    var url = url + '/';
  };
  var browser = $('<iframe>').attr('src', url + 'profile/fs/' + dir).addClass('browser');
  $('#main').append(browser);
  // Delete Button
  if (dir !== 'default') {
    var deleteButton = $('<button>').addClass('button hover').attr('onclick', 'deleteProfile(\'' + dir + '\')').text('Delete ' + dir);
    $('#nav-buttons').append(deleteButton);
  }
}

// Create a blank profile
function createProfile() {
  let user = $('#user').val();
  let pass = $('#pass').val();
  $('#main').empty();
  $('#side').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('createprofile', [user,pass]);
}

// Delete a profile
function deleteProfile(user) {
  $('#main').empty();
  $('#side').empty();
  $('#main').append('<div class="loader"></div>');
  socket.emit('deleteprofile', user);
}

window.renderScansView = renderScansView;
window.scanRoms = scanRoms;
window.newScan = newScan;
window.downloadArt = downloadArt;
window.dlDefaultFiles = dlDefaultFiles;
