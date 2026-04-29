//Default vars
var endPoint = 'profile'
var storeName = 'RetroArch';
var afs;
BrowserFS.install(window);
var fs = require('fs');
var mfs = new BrowserFS.FileSystem.MountableFileSystem();
var postSettings = {method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'}};
var favoritesProfileFile = '.emulatorjs-favorites.json';

function getFavoritesForProfile() {
  return localStorage.getItem('ejsFavorites') || '[]';
}

function restoreFavoritesFromProfile(data) {
  if (typeof data === 'undefined' || data === null) {
    return;
  }
  try {
    JSON.parse(data);
    localStorage.setItem('ejsFavorites', data);
  } catch(e) {
    console.log(e);
  }
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
  if ((localStorage.getItem('user')) && (localStorage.getItem('pass'))) {
    await verifyLogin();
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
  for await (let name of ['Username', 'Role', 'Password', 'Action']) {
    header.append($('<th>').text(name));
  }
  table.append(header);
  for await (let user of json.users) {
    let row = $('<tr>');
    let roleSelect = $('<select>').attr('data-user', user.username).append($('<option>').attr('value','user').text('User'), $('<option>').attr('value','admin').text('Admin')).val(user.role);
    let save = $('<button>').text('Save Role').on('click', async function() {
      await setUserRole(user.username, roleSelect.val());
    });
    let passInput = $('<input>').attr({type:'password', placeholder:'New password'});
    let passButton = $('<button>').text('Update Password').on('click', async function() {
      await adminChangePassword(user.username, passInput.val());
      passInput.val('');
    });
    row.append($('<td>').text(user.username), $('<td>').append(roleSelect), $('<td>').append(passInput, passButton), $('<td>').append(save));
    table.append(row);
  }
  $('#usersList').append(table);
}

async function setUserRole(target, role) {
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('setrole', {target: target, role: role}));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  if (json.status !== 'success') {
    alert('Unable to update role');
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
  $('#userManagement').removeClass('hidden');
  $('body').addClass('modal-open');
  loadUsers();
  loadAdminSettings();
  window.setTimeout(function() {
    $('#newUser').trigger('focus');
  }, 50);
}

function closeUserManagement() {
  $('#userManagement').addClass('hidden');
  $('body').removeClass('modal-open');
}

function handleUserManagementBackdrop(event) {
  if (event.target && event.target.id === 'userManagement') {
    closeUserManagement();
  }
}

async function loadAdminSettings() {
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('getsettings'));
  let res = await fetch(endPoint, loginSettings);
  let json = await res.json();
  if (json.status == 'success') {
    $('#requireMainLogin').prop('checked', json.requireLogin === true);
    $('#usePopupSelectors').prop('checked', json.selectorStyle === 'popup');
    $('#passwordResetWebhook').val(json.passwordResetWebhook || '');
  }
}

async function saveAdminSettings() {
  let loginSettings = postSettings;
  loginSettings.body = JSON.stringify(adminProfileBody('setsettings', {
    requireLogin: $('#requireMainLogin').prop('checked'),
    selectorStyle: $('#usePopupSelectors').prop('checked') ? 'popup' : 'menu',
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
            zip.file(fileName).async('string').then(function(content) {
              restoreFavoritesFromProfile(content);
            });
          } else {
          zip.file(fileName).async('arraybuffer').then(function(content) {
            fs.writeFileSync('/' + fileName, Buffer.from(content));
          });
          }
        }
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
            zip.file(fileName).async('string').then(function(content) {
              restoreFavoritesFromProfile(content);
            });
          } else {
          zip.file(fileName).async('arraybuffer').then(function(content) {
            fs.writeFileSync('/' + fileName, Buffer.from(content));
          });
          }
        }
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
  window.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && !$('#userManagement').hasClass('hidden')) {
      closeUserManagement();
    }
  });
}
