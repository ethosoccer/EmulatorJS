var host = window.location.hostname; 
var port = window.location.port;
var protocol = window.location.protocol;
var path = window.location.pathname;
var socket = io(protocol + '//' + host + ':' + port, { path: path + 'socket.io'});
var adminReady = false;
var logFilters = {sinceDays: '7', eventType: 'all', status: 'all', username: '', search: '', limit: 200};

function adminEndpoint(name) {
  var basePath = path.endsWith('/') ? path : path + '/';
  return basePath + name;
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
socket.on('influxtest', function(result) {
  var ok = result && result.status === 'success';
  $('#logs-status').text(ok ? 'Influx test event sent.' : 'Influx test failed.');
  emptyModal();
  $('#modal-content').append($('<h3>').text(ok ? 'Influx Test Succeeded' : 'Influx Test Failed'));
  $('#modal-content').append($('<p>').text(result && result.message ? result.message : (ok ? 'Influx accepted the test event.' : 'Influx did not accept the test event.')));
  if (result && result.statusCode) {
    $('#modal-content').append($('<p>').text('HTTP Status: ' + result.statusCode));
  }
  if (result && result.influxUrl) {
    $('#modal-content').append($('<p>').text('Influx URL: ' + result.influxUrl));
  }
  if (result && result.influxOrg) {
    $('#modal-content').append($('<p>').text('Org: ' + result.influxOrg));
  }
  if (result && result.influxBucket) {
    $('#modal-content').append($('<p>').text('Bucket: ' + result.influxBucket));
  }
  if (result && result.requestPath) {
    $('#modal-content').append($('<p>').text('Write Path: ' + result.requestPath));
  }
  if (result && result.responseBody) {
    $('#modal-content').append($('<h3>').text('Influx Response'));
    $('#modal-content').append($('<pre>').addClass('log-details-json').text(result.responseBody));
  }
  $('#modal').stop(true, true).show(100);
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
  socket.emit('renderlogs', logFilters);
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
      var button = $('<button>').addClass('scanbutton hover').attr('onclick', 'scanRoms(\'' + emu + '\');').text('Scan');
      card.append(button);
      $(cardContainer).append(card);
      var scanRendered = true;
    } else if (emu == 'default') {
      var card = $('<div>').addClass('card');
      card.append($('<h2>').text('Default'));
      card.append($('<p>').text('Available: ' + counts[emu].available));
      card.append($('<p>').text('Downloaded: ' + counts[emu].downloaded));
      var button = $('<button>').addClass('scanbutton hover').attr('onclick', 'dlDefaultFiles()').text('DL/Update');
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
  socket.emit('scanroms', [folder, true, getPreferredRegion(folder)]);
  $('#modal').toggle(100);
}

// Scan in a roms directory
function newScan(folder) {
  var choice = prompt('Type "all" to scan all items, or press OK/Enter to scan only new items.', 'new');
  if (choice === null) {
    return;
  }
  socket.emit('scanroms', [folder, choice.toLowerCase() === 'all', getPreferredRegion(folder)]);
  $('#modal').toggle(100);
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

// Close modal
function closeModal() {
  emptyModal();
  $('#modal').toggle(100)
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
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  $('#modal').toggle(100);
  socket.emit('downloadart', name);
}

// Tell server to download the default file set
function dlDefaultFiles() {
  $('#main').empty();
  $('#main').append('<div class="loader"></div>');
  $('#modal').toggle(100);
  socket.emit('dldefaultfiles');
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
  let downloadArtButton = $('<button>').addClass('button hover').attr('onclick', 'downloadArt(\'' + folderName + '\');').text('Download All Available Art');
  $('#side').append($('<p>').text('Step 1:'));
  $('#side').append(downloadArtButton);
  let configButton = $('<button>').addClass('button hover').attr('onclick', 'addToConfig(\'' + folderName + '\');').text('Add All Roms to Config');
  $('#side').append($('<p>').text('Step 2:'));
  $('#side').append(configButton);
  $('#side').append($('<p>').text('Optional:'));
  let noArtButton = $('<button>').addClass('button hover').attr('onclick', 'purgeNoArt(\'' + folderName + '\');').text('Remove Roms with No Art');
  $('#side').append(noArtButton);
  let newScanButton = $('<button>').addClass('button hover').attr('onclick', 'newScan(\'' + folderName + '\');').text('Scan for New Items');
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
  $('#modal').toggle(100);
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

function openLogDetails(eventId) {
  var row = $('#log-row-' + eventId);
  if (!row.length) {
    return;
  }
  emptyModal();
  $('#modal-content').append($('<pre>').addClass('log-details-json').text(JSON.stringify(row.data('details') || {}, null, 2)));
  $('#modal').toggle(100);
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
  settingsCard.append($('<div>').addClass('logs-inline-note').text('Webhook destination: ' + (settings.webhookConfigured ? 'configured' : 'not configured') + '. Influx token stays on the server unless you save a new one.'));
  settingsCard.append($('<div>').addClass('logs-button-row')
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', saveLogSettings).text('Save Log Settings'))
    .append($('<button>').addClass('button hover').attr('type', 'button').on('click', testInfluxSettings).text('Test Influx')));
  wrapper.append(settingsCard);
  wrapper.append(filterCard);

  var tableCard = $('<div>').addClass('card logs-card');
  tableCard.append($('<h3>').text('Recent Events'));
  var tableWrap = $('<div>').addClass('logs-table-wrap');
  var table = $('<table>').addClass('logs-table');
  table.append($('<thead>').append($('<tr>')
    .append($('<th>').text('When'))
    .append($('<th>').text('Event'))
    .append($('<th>').text('User'))
    .append($('<th>').text('Source'))
    .append($('<th>').text('IP'))
    .append($('<th>').text('Game / Details'))
    .append($('<th>').text('View'))));
  var body = $('<tbody>');
  if (!events.length) {
    body.append($('<tr>').append($('<td>').attr('colspan', 7).addClass('logs-empty').text('No events matched the current filters.')));
  } else {
    $.each(events, function(index, entry) {
      var row = $('<tr>').attr('id', 'log-row-' + entry.id);
      row.data('details', entry.details || {});
      row.append($('<td>').text(entry.timestamp || ''));
      row.append($('<td>').text((entry.title || entry.event_type || 'Event') + (entry.status ? ' (' + entry.status + ')' : '')));
      row.append($('<td>').text(entry.username || '-'));
      row.append($('<td>').text(entry.source || '-'));
      row.append($('<td>').text(entry.ip || '-'));
      row.append($('<td>').text(entry.game_name ? entry.game_name + (entry.console_title ? ' - ' + entry.console_title : '') : (entry.host || '-')));
      row.append($('<td>').append($('<button>').addClass('button hover').attr('type', 'button').on('click', function() { openLogDetails(entry.id); }).text('Details')));
      body.append(row);
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

