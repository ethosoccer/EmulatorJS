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
var saveWatchTimer;
var saveWatchInFlight = false;
var lastSaveWatchSignature = null;
var saveInventoryCache;
var saveInventoryLoading;
var savePanelBackHandler = null;
var variantPanelState = null;
var pendingLaunchSelection = null;
var activeFrontPanelSelector = null;
var frontPanelNavState = {selector: null, row: 0, col: 0};
var menuActionIndex = 0;
var currentMenuActiveItem = 0;
var requireMainLogin = false;
var selectorStyle = 'menu';
var launchErrorDebug = false;
var selectorMenuStack = [];
var selectorRouteMap = {
  variant: '#selector-game',
  save: '#selector-save'
};
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
  var text = String(value || '');
  try {
    text = decodeURIComponent(text);
  } catch(e) {
  }
  return repairDisplayText(text);
}
function repairDisplayText(value) {
  var text = String(value || '');
  text = text.replace(/\u00c2\u00b7/g, ' | ');
  try {
    if (/[ÃÂ]/.test(text)) {
      text = decodeURIComponent(escape(text));
    }
  } catch(e) {}
  return text.replace(/\u00b7/g, ' | ');
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
        favorite.exactName = hasUsableValue(favorite.exactName) ? favorite.exactName : favorite.name;
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
function notifyGameStarted(details) {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return Promise.resolve();
  }
  return profileRequest({
    type: 'notifygameevent',
    user: localStorage.getItem('user'),
    pass: localStorage.getItem('pass'),
    source: 'frontend',
    gameName: details && details.gameName || '',
    gameFile: details && details.gameFile || '',
    console: details && details.console || '',
    consoleTitle: details && details.consoleTitle || '',
    path: details && details.path || '',
    emulator: details && details.emulator || '',
    romExtension: details && details.romExtension || '',
    gameUrl: details && details.gameUrl || ''
  }).catch(function(e) {
    console.log('Unable to notify game start', e);
  });
}
function freshJsonUrl(url) {
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  return url + separator + 'v=' + configCacheToken;
}
function fetchFreshJson(url) {
  return fetch(freshJsonUrl(url), Init);
}
function normalizeGamepads(gamepads) {
  if (!gamepads) {
    return [];
  }
  if (typeof gamepads[Symbol.iterator] === 'function') {
    return Array.from(gamepads).filter(Boolean);
  }
  if (typeof gamepads.length === 'number') {
    return Array.from({length: gamepads.length}, function(_, index) {
      return gamepads[index];
    }).filter(Boolean);
  }
  return Object.keys(gamepads).filter(function(key) {
    return String(Number(key)) === key;
  }).map(function(key) {
    return gamepads[key];
  }).filter(Boolean);
}
function getGamepadsList() {
  if (!navigator.getGamepads || typeof navigator.getGamepads !== 'function') {
    return [];
  }
  try {
    return normalizeGamepads(navigator.getGamepads());
  } catch (e) {
    console.log('Unable to read gamepads', e);
    return [];
  }
}
function dispatchGamepadConnected(gp) {
  if (!gp) {
    return;
  }
  try {
    window.dispatchEvent(new GamepadEvent("gamepadconnected", {gamepad: gp}));
    return;
  } catch (e) {
  }
  var fallbackEvent = new Event("gamepadconnected");
  fallbackEvent.gamepad = gp;
  window.dispatchEvent(fallbackEvent);
}
function resetGameplayViewport() {
  try {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  } catch (e) {
    console.log('Unable to reset gameplay viewport', e);
  }
}
function getFrontPanelSelectors() {
  return ['#search-panel', '#favorites-panel', '#save-panel', '#variant-panel', '#login-panel'];
}
function getActiveFrontPanel() {
  if (activeFrontPanelSelector && !$(activeFrontPanelSelector).hasClass('hidden')) {
    return activeFrontPanelSelector;
  }
  var selectors = getFrontPanelSelectors();
  for (var i = selectors.length - 1; i >= 0; i--) {
    if (!$(selectors[i]).hasClass('hidden')) {
      activeFrontPanelSelector = selectors[i];
      return activeFrontPanelSelector;
    }
  }
  activeFrontPanelSelector = null;
  return null;
}
function syncFrontPanelState() {
  var activeSelector = getActiveFrontPanel();
  $('body').toggleClass('front-panel-open', !!activeSelector);
  getFrontPanelSelectors().forEach(function(item) {
    $(item).toggleClass('is-active-panel', item === activeSelector && !$(item).hasClass('hidden'));
  });
  return activeSelector;
}
function panelFocusableElements(selector) {
  if (!selector) {
    return $();
  }
  return $(selector).find('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    .filter(':visible');
}
function focusDomElement($element, fallbackPanel) {
  var $target = $element && $element.length ? $element.first() : $();
  var target = $target.length ? $target.get(0) : null;
  if (target && typeof target.focus === 'function') {
    try {
      target.focus({preventScroll: true});
      return true;
    } catch (e) {
      try {
        target.focus();
        return true;
      } catch (ignore) {}
    }
  }
  if (fallbackPanel && fallbackPanel.length) {
    var panel = fallbackPanel.get(0);
    if (panel && typeof panel.focus === 'function') {
      try {
        panel.focus({preventScroll: true});
        return true;
      } catch (err) {
        try {
          panel.focus();
          return true;
        } catch (ignorePanel) {}
      }
    }
  }
  return false;
}
function clickDomElement($element) {
  var target = $element && $element.length ? $element.first().get(0) : null;
  if (!target) {
    return false;
  }
  if (typeof target.click === 'function') {
    target.click();
    return true;
  }
  return false;
}
function captureCurrentVisualState() {
  return {
    backgroundSrc: $('#background').attr('src') || '',
    cornerSrc: $('#corner').attr('src') || '',
    videoSrc: $('#bgvid source').attr('src') || '',
    videoPosition: $('#bgvid').attr('style') || '',
    videoVisible: $('#bgvid').css('display') !== 'none'
  };
}
function storeSelectorVisualState() {
  try {
    sessionStorage.setItem('ejsSelectorVisualState', JSON.stringify(captureCurrentVisualState()));
  } catch (e) {
    console.log(e);
  }
}
function loadSelectorVisualState() {
  try {
    return JSON.parse(sessionStorage.getItem('ejsSelectorVisualState') || 'null');
  } catch (e) {
    return null;
  }
}
function applySelectorVisualState() {
  var state = loadSelectorVisualState();
  if (!state) {
    return false;
  }
  if (state.backgroundSrc) {
    $('#background').attr('src', state.backgroundSrc);
  }
  if (state.cornerSrc) {
    $('#corner').attr('src', state.cornerSrc).show();
  } else {
    $('#corner').hide();
  }
  if (state.videoSrc) {
    $('#bgvid source').attr('src', state.videoSrc);
    $('#bgvid').attr('style', state.videoPosition || '');
    try {
      var video = $('#bgvid').get(0);
      if (video) {
        video.load();
        video.muted = true;
        video.play().catch(function() {});
      }
    } catch (e) {}
    $('#bgvid').toggle(state.videoVisible !== false);
  } else {
    $('#bgvid').hide();
  }
  return true;
}
function serializeButtonData(source) {
  var selected = source && source.jquery ? source : $(source);
  if (!selected.length) {
    return null;
  }
  var attrs = {};
  if (selected.get(0) && selected.get(0).attributes) {
    Array.prototype.forEach.call(selected.get(0).attributes, function(attr) {
      attrs[attr.name] = attr.value;
    });
  }
  return attrs;
}
function deserializeLaunchButton(attrs) {
  if (!attrs) {
    return null;
  }
  var temp = $('<button type="button">');
  Object.keys(attrs).forEach(function(name) {
    temp.attr(name, attrs[name]);
  });
  temp.attr('data-save-selection-ready', 'true');
  return temp;
}
function savePendingLaunchSelection() {
  try {
    sessionStorage.setItem('ejsPendingLaunchSelection', JSON.stringify(pendingLaunchSelection || null));
  } catch (e) {
    console.log(e);
  }
}
function loadPendingLaunchSelection() {
  try {
    pendingLaunchSelection = JSON.parse(sessionStorage.getItem('ejsPendingLaunchSelection') || 'null');
  } catch (e) {
    pendingLaunchSelection = null;
  }
}
function clearPendingLaunchSelection() {
  pendingLaunchSelection = null;
  try {
    sessionStorage.removeItem('ejsPendingLaunchSelection');
  } catch (e) {
    console.log(e);
  }
}
function clearControllerSelectionClasses() {
  $('.controller-selected').removeClass('controller-selected');
}
function panelRowControls($row) {
  return $row.find('.search-result, .variant-launch, .panel-icon-button, .variant-favorite, .favorite-indicator, button')
    .filter(':visible');
}
function panelNavigationRows(selector) {
  if (!selector) {
    return [];
  }
  var $panel = $(selector);
  var rows = [];
  $panel.children('button:visible').each(function() {
    rows.push($(this));
  });
  $panel.find('.variant-result-row:visible, .save-file-row:visible, .favorite-result-row:visible').each(function() {
    var controls = panelRowControls($(this));
    if (controls.length) {
      rows.push(controls);
    }
  });
  if (!rows.length) {
    panelFocusableElements(selector).each(function() {
      rows.push($(this));
    });
  }
  return rows;
}
function syncFrontPanelNavigation(selector, options) {
  options = options || {};
  if (!selector || $(selector).hasClass('hidden')) {
    frontPanelNavState = {selector: null, row: 0, col: 0};
    clearControllerSelectionClasses();
    return false;
  }
  var rows = panelNavigationRows(selector);
  if (!rows.length) {
    frontPanelNavState = {selector: selector, row: 0, col: 0};
    clearControllerSelectionClasses();
    focusDomElement($(selector), $(selector));
    return true;
  }
  if (frontPanelNavState.selector !== selector || !options.preserve) {
    frontPanelNavState = {selector: selector, row: 0, col: 0};
  }
  frontPanelNavState.selector = selector;
  frontPanelNavState.row = Math.max(0, Math.min(frontPanelNavState.row, rows.length - 1));
  var selectedRow = rows[frontPanelNavState.row];
  var rowControls = selectedRow && selectedRow.jquery ? selectedRow : $(selectedRow);
  frontPanelNavState.col = Math.max(0, Math.min(frontPanelNavState.col, rowControls.length - 1));
  clearControllerSelectionClasses();
  panelFocusableElements(selector).attr('tabindex', '-1');
  var $target = rowControls.eq(frontPanelNavState.col);
  $target.attr('tabindex', '0');
  $target.addClass('controller-selected');
  var targetElement = $target.get(0);
  if (targetElement && typeof targetElement.scrollIntoView === 'function') {
    try {
      targetElement.scrollIntoView({block: 'nearest', inline: 'nearest'});
    } catch (e) {}
  }
  focusDomElement($target, $(selector));
  return true;
}
function moveFrontPanelHorizontal(delta) {
  var selector = getActiveFrontPanel();
  if (!selector) {
    return false;
  }
  var rows = panelNavigationRows(selector);
  if (!rows.length) {
    return false;
  }
  if (frontPanelNavState.selector !== selector) {
    syncFrontPanelNavigation(selector);
    return true;
  }
  var rowControls = rows[frontPanelNavState.row] && rows[frontPanelNavState.row].jquery ? rows[frontPanelNavState.row] : $(rows[frontPanelNavState.row]);
  if (!rowControls.length) {
    return false;
  }
  frontPanelNavState.col = (frontPanelNavState.col + delta + rowControls.length) % rowControls.length;
  return syncFrontPanelNavigation(selector, {preserve: true});
}
function activateCurrentFrontPanelControl() {
  var selector = getActiveFrontPanel();
  if (!selector) {
    return false;
  }
  if (frontPanelNavState.selector !== selector) {
    syncFrontPanelNavigation(selector);
  }
  var rows = panelNavigationRows(selector);
  if (!rows.length) {
    return false;
  }
  var rowControls = rows[frontPanelNavState.row] && rows[frontPanelNavState.row].jquery ? rows[frontPanelNavState.row] : $(rows[frontPanelNavState.row]);
  var $target = rowControls.eq(frontPanelNavState.col);
  if (!$target.length) {
    return false;
  }
  focusDomElement($target, $(selector));
  return clickDomElement($target);
}
function getMenuRowControls(index) {
  var $row = $('#h' + index);
  if (!$row.length) {
    return $();
  }
  return $row.find('a, .save-toggle:not(.hidden), .rom-download-toggle, .favorite-toggle').filter(':visible');
}
function syncMenuControllerSelection() {
  clearControllerSelectionClasses();
  var $row = $('#h' + currentMenuActiveItem);
  var $controls = getMenuRowControls(currentMenuActiveItem);
  if (!$controls.length) {
    return false;
  }
  menuActionIndex = Math.max(0, Math.min(menuActionIndex, $controls.length - 1));
  var $target = $controls.eq(menuActionIndex);
  $target.addClass('controller-selected');
  focusDomElement($target, $('#h' + currentMenuActiveItem));
  return true;
}
function moveMenuHorizontal(delta) {
  var $controls = getMenuRowControls(currentMenuActiveItem);
  if (!$controls.length) {
    return false;
  }
  menuActionIndex = (menuActionIndex + delta + $controls.length) % $controls.length;
  return syncMenuControllerSelection();
}
function activateCurrentMenuControl() {
  var $controls = getMenuRowControls(currentMenuActiveItem);
  if (!$controls.length) {
    return false;
  }
  menuActionIndex = Math.max(0, Math.min(menuActionIndex, $controls.length - 1));
  var $target = $controls.eq(menuActionIndex);
  focusDomElement($target, $('#h' + currentMenuActiveItem));
  return clickDomElement($target);
}
function focusFrontPanel(selector, preferredSelector) {
  if (!selector || $(selector).hasClass('hidden')) {
    return;
  }
  activeFrontPanelSelector = selector;
  var $panel = $(selector);
  $panel.attr('tabindex', '-1');
  syncFrontPanelState();
  var $preferred = preferredSelector ? $panel.find(preferredSelector).filter(':visible').first() : $();
  var $focusables = panelFocusableElements(selector);
  var $target = $preferred.length ? $preferred : ($focusables.length ? $focusables.first() : $panel);
  setTimeout(function() {
    focusDomElement($target, $panel);
    syncFrontPanelNavigation(selector, {preserve: false});
  }, 0);
}
function clearFrontPanelFocus(selector) {
  if (!selector || activeFrontPanelSelector === selector) {
    activeFrontPanelSelector = null;
  }
  if (!selector || frontPanelNavState.selector === selector) {
    frontPanelNavState = {selector: null, row: 0, col: 0};
  }
  syncFrontPanelState();
  clearControllerSelectionClasses();
}
function moveFrontPanelFocus(delta) {
  var selector = getActiveFrontPanel();
  if (!selector) {
    return false;
  }
  var rows = panelNavigationRows(selector);
  if (!rows.length) {
    focusFrontPanel(selector);
    return true;
  }
  if (frontPanelNavState.selector !== selector) {
    syncFrontPanelNavigation(selector);
  }
  frontPanelNavState.row = (frontPanelNavState.row + delta + rows.length) % rows.length;
  var rowControls = rows[frontPanelNavState.row] && rows[frontPanelNavState.row].jquery ? rows[frontPanelNavState.row] : $(rows[frontPanelNavState.row]);
  frontPanelNavState.col = Math.max(0, Math.min(frontPanelNavState.col, rowControls.length - 1));
  return syncFrontPanelNavigation(selector, {preserve: true});
}
function activateFrontPanelControl() {
  return activateCurrentFrontPanelControl();
}
function handleActiveFrontPanelKeydown(event) {
  var activePanel = getActiveFrontPanel();
  if (!activePanel) {
    return false;
  }
  if ($(event.target).is('input, select, textarea')) {
    return false;
  }
  syncFrontPanelNavigation(activePanel, {preserve: true});
  if (event.key == 'ArrowDown') {
    event.preventDefault();
    moveFrontPanelFocus(1);
    return true;
  }
  if (event.key == 'ArrowUp') {
    event.preventDefault();
    moveFrontPanelFocus(-1);
    return true;
  }
  if (event.key == 'ArrowRight') {
    event.preventDefault();
    moveFrontPanelHorizontal(1);
    return true;
  }
  if (event.key == 'ArrowLeft') {
    event.preventDefault();
    moveFrontPanelHorizontal(-1);
    return true;
  }
  if (event.key == 'Enter' || event.key == ' ') {
    event.preventDefault();
    activateFrontPanelControl();
    return true;
  }
  if (event.key == 'Escape' || event.key == 'Backspace') {
    event.preventDefault();
    handleFrontPanelBack();
    return true;
  }
  return false;
}
function updateFrontPanelNavFromElement(element) {
  var activePanel = getActiveFrontPanel();
  if (!activePanel || !element) {
    return false;
  }
  var rows = panelNavigationRows(activePanel);
  if (!rows.length) {
    return false;
  }
  for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    var rowControls = rows[rowIndex] && rows[rowIndex].jquery ? rows[rowIndex] : $(rows[rowIndex]);
    for (var colIndex = 0; colIndex < rowControls.length; colIndex++) {
      if (rowControls.get(colIndex) === element) {
        frontPanelNavState = {
          selector: activePanel,
          row: rowIndex,
          col: colIndex
        };
        syncFrontPanelNavigation(activePanel, {preserve: true});
        return true;
      }
    }
  }
  return false;
}
function handleFrontPanelBack() {
  var selector = getActiveFrontPanel();
  if (!selector) {
    return false;
  }
  if (selector === '#save-panel' && !$('#save-panel-back').hasClass('hidden')) {
    $('#save-panel-back').trigger('click');
    return true;
  }
  var $close = $(selector).find('.search-header button').filter(':visible').last();
  if ($close.length) {
    $close.trigger('click');
    return true;
  }
  return false;
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
function idbWrite(dbName, storeName, writer) {
  return new Promise(function(resolve) {
    if (!window.indexedDB) {
      resolve(false);
      return;
    }
    var request = indexedDB.open(dbName);
    request.onerror = function() {
      resolve(false);
    };
    request.onsuccess = function() {
      var db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve(false);
        return;
      }
      try {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var writeRequest = writer(store);
        if (writeRequest && typeof writeRequest.onerror !== 'undefined') {
          writeRequest.onerror = function() {
            resolve(false);
          };
        }
        tx.oncomplete = function() {
          db.close();
          resolve(true);
        };
        tx.onerror = function() {
          db.close();
          resolve(false);
        };
      } catch (e) {
        db.close();
        resolve(false);
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
          queueProfilePush(true);
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
function saveSortValue(save) {
  if (!save) {
    return 0;
  }
  return Number(save.versionSort || 0);
}
function saveStateLabel(save) {
  if (save && save.current) {
    return 'Current';
  }
  if (save && String(save.source || '').toLowerCase().indexOf('backup') !== -1) {
    return 'History';
  }
  if (save && String(save.source || '').toLowerCase().indexOf('history') !== -1) {
    return 'History';
  }
  return 'Saved';
}
function saveSourceLabel(save) {
  if (!save) {
    return 'Unknown source';
  }
  if (String(save.source || '').toLowerCase().indexOf('profile current') !== -1) {
    return 'Server current';
  }
  if (String(save.source || '').toLowerCase().indexOf('profile history') !== -1) {
    return 'Server history';
  }
  if (String(save.source || '').toLowerCase().indexOf('legacy backup') !== -1) {
    return 'Legacy backup';
  }
  if (String(save.source || '').toLowerCase().indexOf('local backup') !== -1) {
    return 'Local backup';
  }
  if (String(save.source || '').toLowerCase().indexOf('local profile') !== -1) {
    return 'Local profile';
  }
  return save.source || 'Unknown source';
}
function saveBadges(save) {
  var badges = [saveStateLabel(save), saveSourceLabel(save)];
  if (save && save.type) {
    badges.push(save.type);
  }
  return badges.filter(Boolean);
}
function saveVersionSummary(save) {
  var parts = [];
  if (save && save.versionLabel) {
    parts.push(save.versionLabel);
  }
  parts.push(formatDateTime(saveSortValue(save)));
  parts.push(formatBytes(save && save.size));
  return parts.filter(Boolean).join(' - ');
}
function groupedSaveSummary(group) {
  var parts = [];
  if (group.hasCurrent) {
    parts.push('Current available');
  }
  parts.push(group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's'));
  parts.push('Latest ' + formatDateTime(saveSortValue(group.latest)));
  return parts.join(' - ');
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
function restoreTargetForSave(save) {
  if (!save) {
    return null;
  }
  if ((save.type || '').indexOf('State') !== -1) {
    return {
      dbName: 'EmulatorJS-states',
      storeName: 'states',
      key: save.name
    };
  }
  return {
    dbName: 'FILE_DATA',
    storeName: 'FILE_DATA',
    key: '/data/saves/' + save.name
  };
}
function restoreProfilePathForSave(save) {
  if (!save) {
    return null;
  }
  var relativePath = save.pathKey || save.key || '';
  if (!relativePath) {
    return null;
  }
  relativePath = String(relativePath).replace(/^\/+/, '');
  if (isHistoryProfileSavePath(relativePath)) {
    relativePath = historyRelativeSavePath(relativePath);
  }
  if (!isProfileSavePath(relativePath)) {
    return null;
  }
  return relativePath;
}
async function restoreProfileSaveForLaunch(save, bytes) {
  var relativePath = restoreProfilePathForSave(save);
  if (!relativePath) {
    return false;
  }
  try {
    await setupProfileFs();
    if (!profileFs) {
      return false;
    }
    await writeProfileFileWithBackup(relativePath, Buffer.from(bytes), 'launch-restore-' + Date.now());
    return true;
  } catch(e) {
    console.log('Unable to restore save into profile filesystem', e);
    return false;
  }
}
async function restoreSaveForLaunch(saveId) {
  var save = findSaveById(saveId);
  if (!save) {
    await getSaveInventory(true);
    save = findSaveById(saveId);
  }
  if (!save) {
    return false;
  }
  var bytes = await save.load();
  if (!bytes) {
    return false;
  }
  var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var target = restoreTargetForSave(save);
  if (!target || !target.key) {
    var profileOnlyRestored = await restoreProfileSaveForLaunch(save, payload);
    if (!profileOnlyRestored) {
      return false;
    }
    await getSaveInventory(true);
    return true;
  }
  var restoredToProfile = await restoreProfileSaveForLaunch(save, payload);
  var restoredToBrowser = await idbWrite(target.dbName, target.storeName, function(store) {
    return store.put(payload, target.key);
  });
  if (!restoredToProfile && !restoredToBrowser) {
    return false;
  }
  await getSaveInventory(true);
  return true;
}
function saveByteLength(value) {
  var bytes = bytesFromSaveValue(value);
  if (!bytes) {
    return 0;
  }
  return bytes.byteLength || bytes.length || 0;
}
function saveBytesSignature(value) {
  var bytes = bytesFromSaveValue(value);
  if (!bytes) {
    return '0:0:0:0';
  }
  var length = bytes.byteLength || bytes.length || 0;
  if (!length) {
    return '0:0:0:0';
  }
  var first = bytes[0] || 0;
  var middle = bytes[Math.floor(length / 2)] || 0;
  var last = bytes[length - 1] || 0;
  return [length, first, middle, last].join(':');
}
function profileRequestBody(type, extra) {
  var body = {
    user: localStorage.getItem('user'),
    pass: localStorage.getItem('pass'),
    type: type
  };
  return Object.assign(body, extra || {});
}
async function buildLocalSaveWatchSignature() {
  var parts = [];
  var stateKeys = (await idbGetKeys('EmulatorJS-states', 'states')).filter(function(key) {
    return key && key !== '?EJS_KEYS!';
  }).sort();
  for (var stateKey of stateKeys) {
    var stateValue = await idbGetValue('EmulatorJS-states', 'states', stateKey);
    parts.push('state:' + stateKey + ':' + saveBytesSignature(stateValue));
  }
  var fileKeys = (await idbGetKeys('FILE_DATA', 'FILE_DATA')).filter(function(key) {
    return key && String(key).indexOf('/data/saves/') !== -1;
  }).sort();
  for (var fileKey of fileKeys) {
    var fileValue = await idbGetValue('FILE_DATA', 'FILE_DATA', fileKey);
    parts.push('file:' + fileKey + ':' + saveBytesSignature(fileValue));
  }
  return parts.join('|');
}
async function watchLocalSaveChanges(forceBaseline) {
  if (saveWatchInFlight || !localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  saveWatchInFlight = true;
  try {
    var signature = await buildLocalSaveWatchSignature();
    if (forceBaseline || lastSaveWatchSignature === null) {
      lastSaveWatchSignature = signature;
    } else if (signature !== lastSaveWatchSignature) {
      lastSaveWatchSignature = signature;
      setProfileStatus('Save change detected. Pushing to server...');
      queueProfilePush(true);
    }
  } catch(e) {
    console.log('Save watcher error', e);
  }
  saveWatchInFlight = false;
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
var localSaveVersionRoot = '.save-versions';
function normalizeLocalSavePath(fileName) {
  return String(fileName || '').replace(/\\/g, '/').replace(/^\/+/, '');
}
function localSaveVersionStorageKey(fileName) {
  var value = normalizeLocalSavePath(fileName);
  var out = '';
  for (var i = 0; i < value.length; i++) {
    out += value.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}
function localSaveVersionDir(fileName) {
  return '/' + localSaveVersionRoot + '/' + localSaveVersionStorageKey(fileName);
}
function localSaveManifestPath(fileName) {
  return localSaveVersionDir(fileName) + '/manifest.json';
}
function localSaveVersionPath(fileName, versionId) {
  return localSaveVersionDir(fileName) + '/versions/' + versionId + '.bin';
}
function localSaveManifestDefaults(fileName) {
  var normalized = normalizeLocalSavePath(fileName);
  var parts = normalized.split('/');
  var leaf = parts[parts.length - 1] || '';
  return {
    saveKey: normalized,
    fileName: leaf,
    displayName: safeDecodeDisplayName(leaf),
    scope: parts[0] || '',
    core: parts[1] || '',
    saveType: profileSaveType(normalized),
    createdAt: '',
    updatedAt: '',
    currentVersionId: '',
    currentHash: '',
    versions: []
  };
}
async function localSaveContentHash(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
    var digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }
  return saveBytesSignature(bytes);
}
function readLocalSaveManifest(fileName) {
  var manifestPath = localSaveManifestPath(fileName);
  try {
    if (!profileFs.existsSync(manifestPath)) {
      return localSaveManifestDefaults(fileName);
    }
    var parsed = JSON.parse(String(profileFs.readFileSync(manifestPath), 'utf8'));
    return Object.assign(localSaveManifestDefaults(fileName), parsed || {}, {
      versions: Array.isArray(parsed && parsed.versions) ? parsed.versions : []
    });
  } catch (e) {
    console.log('Unable to read local save manifest', e);
    return localSaveManifestDefaults(fileName);
  }
}
function writeLocalSaveManifest(fileName, manifest) {
  var manifestPath = localSaveManifestPath(fileName);
  ensureProfileDirSync(manifestPath.split('/').slice(0, -1).join('/') || '/');
  profileFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}
function sortLocalSaveVersionsNewestFirst(versions) {
  return (versions || []).slice().sort(function(a, b) {
    return Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0);
  });
}
async function ensureLocalSaveVersioned(relativePath, buffer, options) {
  var normalized = normalizeLocalSavePath(relativePath);
  if (!isProfileSavePath(normalized)) {
    return null;
  }
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var manifest = readLocalSaveManifest(normalized);
  var now = new Date();
  var nowIso = now.toISOString();
  var nowMs = now.getTime();
  var hash = await localSaveContentHash(bytes);
  var size = bytes.byteLength || bytes.length || 0;
  var existingVersion = (manifest.versions || []).find(function(version) {
    return version.hash === hash && Number(version.size || 0) === size;
  });
  var created = false;
  if (!manifest.createdAt) {
    manifest.createdAt = nowIso;
  }
  if (!existingVersion) {
    created = true;
    var versionId = 'local-' + nowIso.replace(/[:.]/g, '-') + '--' + String(hash).slice(0, 12);
    var versionPath = localSaveVersionPath(normalized, versionId);
    ensureProfileDirSync(versionPath.split('/').slice(0, -1).join('/') || '/');
    profileFs.writeFileSync(versionPath, Buffer.from(bytes));
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
      source: options && options.source || 'Local profile',
      notes: options && options.notes || '',
      pathKey: versionPath.replace(/^\//, '')
    };
    manifest.versions.push(existingVersion);
  }
  manifest.currentVersionId = existingVersion.id;
  manifest.currentHash = hash;
  manifest.updatedAt = nowIso;
  manifest.versions = sortLocalSaveVersionsNewestFirst(manifest.versions);
  writeLocalSaveManifest(normalized, manifest);
  return {
    manifest: manifest,
    version: existingVersion,
    created: created,
    hash: hash,
    size: size
  };
}
async function listLocalSaveVersionRecords() {
  await setupProfileFs();
  if (!profileFs) {
    return [];
  }
  var manifests = [];
  async function walk(dirPath) {
    if (!profileFs.existsSync(dirPath)) {
      return;
    }
    var items = profileFs.readdirSync(dirPath);
    for (var item of items) {
      var fullPath = (dirPath === '/' ? '' : dirPath) + '/' + item;
      if (profileFs.lstatSync(fullPath).isDirectory()) {
        await walk(fullPath);
      } else if (/\/manifest\.json$/i.test(fullPath)) {
        manifests.push(fullPath);
      }
    }
  }
  await walk('/' + localSaveVersionRoot);
  var saves = [];
  for (var manifestPath of manifests) {
    var parsed;
    try {
      parsed = JSON.parse(String(profileFs.readFileSync(manifestPath), 'utf8'));
    } catch (e) {
      continue;
    }
    var manifest = Object.assign(localSaveManifestDefaults(parsed && parsed.saveKey || ''), parsed || {});
    var versions = sortLocalSaveVersionsNewestFirst(Array.isArray(manifest.versions) ? manifest.versions : []);
    var currentVersionId = manifest.currentVersionId || '';
    var currentVersion = versions.find(function(version) {
      return version.id === currentVersionId;
    }) || versions[0] || null;
    if (currentVersion) {
      saves.push({
        id: 'localprofile::current::' + manifest.saveKey,
        key: manifest.saveKey,
        name: manifest.displayName || safeDecodeDisplayName(manifest.fileName || manifest.saveKey.split('/').pop()),
        type: manifest.saveType || profileSaveType(manifest.saveKey),
        source: 'Local profile',
        size: Number(currentVersion.size || 0),
        versionLabel: 'Current',
        versionSort: Number(currentVersion.createdAtMs || 0),
        current: true,
        createdAt: currentVersion.createdAt || manifest.updatedAt || '',
        saveKey: manifest.saveKey,
        versionId: currentVersion.id,
        currentVersionId: currentVersion.id,
        hash: currentVersion.hash || '',
        notes: currentVersion.notes || '',
        load: async function(pathKey) {
          return Buffer.from(profileFs.readFileSync('/' + pathKey));
        }.bind(null, manifest.saveKey)
      });
    }
    for (var version of versions) {
      if (version.id === currentVersionId) {
        continue;
      }
      saves.push({
        id: 'localprofile::version::' + manifest.saveKey + '::' + version.id,
        key: version.pathKey,
        name: manifest.displayName || safeDecodeDisplayName(manifest.fileName || manifest.saveKey.split('/').pop()),
        type: manifest.saveType || profileSaveType(manifest.saveKey),
        source: version.source || 'Local history',
        size: Number(version.size || 0),
        versionLabel: version.createdAt || version.id,
        versionSort: Number(version.createdAtMs || 0),
        current: false,
        createdAt: version.createdAt || '',
        saveKey: manifest.saveKey,
        versionId: version.id,
        currentVersionId: currentVersionId,
        hash: version.hash || '',
        notes: version.notes || '',
        load: async function(pathKey) {
          return Buffer.from(profileFs.readFileSync('/' + pathKey));
        }.bind(null, version.pathKey)
      });
    }
  }
  return saves;
}
async function buildLocalProfileSaveInventory() {
  try {
    var saves = await listLocalSaveVersionRecords();
    if (saves.length) {
      return saves;
    }
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
    var legacySaves = [];
    for (var fileName of files) {
      var localName = fileName;
      var versionLabel = 'Local profile';
      if (isHistoryProfileSavePath(fileName)) {
        localName = historyRelativeSavePath(fileName);
        versionLabel = historyVersionLabel(fileName);
      }
      if (!isProfileSavePath(localName) || String(fileName).indexOf(localSaveVersionRoot + '/') === 0) {
        continue;
      }
      var bytes = profileFs.readFileSync('/' + fileName);
      var localStat = profileFs.statSync('/' + fileName);
      legacySaves.push({
        id: 'localprofile::' + fileName,
        key: fileName,
        name: safeDecodeDisplayName(localName.split('/').pop()),
        type: profileSaveType(localName),
        source: isHistoryProfileSavePath(fileName) ? 'Local backup: ' + versionLabel : profileSaveSource(localName),
        size: saveByteLength(bytes),
        versionLabel: versionLabel,
        versionSort: localStat && localStat.mtimeMs ? localStat.mtimeMs : Date.now(),
        current: !isHistoryProfileSavePath(fileName),
        createdAt: localStat && localStat.mtime ? new Date(localStat.mtime).toISOString() : '',
        load: async function(data) {
          return data;
        }.bind(null, bytes)
      });
    }
    return legacySaves;
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
        current: profileSave.current === true,
        createdAt: profileSave.createdAt || '',
        saveKey: profileSave.saveKey || '',
        versionId: profileSave.versionId || '',
        currentVersionId: profileSave.currentVersionId || '',
        hash: profileSave.hash || '',
        notes: profileSave.notes || '',
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
function downloadSelectorSave(event, button) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  var saveId = button && typeof button.getAttribute === 'function'
    ? (button.getAttribute('data-selector-save-id') || button.getAttribute('data-selector_save_id') || '')
    : '';
  if (!saveId) {
    return;
  }
  downloadSaveFile(saveId);
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
      if (!!a.current !== !!b.current) {
        return a.current ? -1 : 1;
      }
      return saveSortValue(b) - saveSortValue(a);
    });
    groups[key].latest = groups[key].versions[0];
    groups[key].hasCurrent = groups[key].versions.some(function(version) {
      return version.current;
    });
    return groups[key];
  });
  grouped.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
  return grouped;
}
function renderSaveVersionRows(target, saves, options) {
  options = options || {};
  $(target).empty();
  for (var save of saves) {
    var row = $('<div>').addClass('save-file-row');
    var detail = $('<button>').addClass('search-result').attr('type', 'button');
    detail.append($('<span>').addClass('save-file-title').text(save.name));
    var badges = $('<span>').addClass('save-file-badges');
    saveBadges(save).forEach(function(label) {
      badges.append($('<span>').addClass('save-file-badge').text(label));
    });
    detail.append(badges);
    detail.append($('<span>').addClass('save-file-meta').text(saveVersionSummary(save)));
    if (save.notes) {
      detail.append($('<span>').addClass('save-file-note').text(save.notes));
    }
    detail.on('click', function(saveId) {
      return async function() {
        if (options.mode === 'launch' && typeof options.onSelect === 'function') {
          await options.onSelect(saveId);
          return;
        }
        downloadSaveFile(saveId);
      };
    }(save.id));
    var download = $('<button>').attr('type', 'button').text(options.mode === 'launch' ? 'Use Save' : 'Download');
    download.on('click', function(saveId) {
      return async function() {
        if (options.mode === 'launch' && typeof options.onSelect === 'function') {
          await options.onSelect(saveId);
          return;
        }
        downloadSaveFile(saveId);
      };
    }(save.id));
    row.append(detail, download);
    $(target).append(row);
  }
}
function openSaveVersionPicker(group, backHandler, options) {
  options = options || {};
  setSavePanelBack(backHandler);
  $('#save-panel').removeClass('hidden');
  $('#save-panel-title').text(safeDecodeDisplayName((options.titlePrefix || group.name) + (options.mode === 'launch' ? '' : ' Versions')));
  $('#save-panel-status').text(options.statusText || (group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's') + ' available'));
  $('#save-panel-results').empty();
  if (options.mode === 'launch') {
    var withoutButton = $('<button>').attr('type', 'button').text('Launch Without Restoring');
    withoutButton.on('click', function() {
      if (typeof options.onSkip === 'function') {
        options.onSkip();
      }
    });
    $('#save-panel-results').append(withoutButton);
  } else if (group.versions.length > 1) {
    var allButton = $('<button>').attr('type', 'button').text('Download All Versions');
    allButton.on('click', function() {
      downloadSaveList(group.versions.map(function(save) { return save.id; }), saveBasename(group.name) + '-versions.zip');
    });
    $('#save-panel-results').append(allButton);
  }
  if (group.hasCurrent) {
    $('#save-panel-results').append($('<div>').addClass('search-status').text('Current save is shown first. Older versions remain available below it.'));
  }
  renderSaveVersionRows('#save-panel-results', group.versions, options);
  focusFrontPanel('#save-panel', '.search-result, button');
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
function renderSaveRows(target, saves, emptyMessage, backHandler, options) {
  options = options || {};
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
    var badges = $('<span>').addClass('save-file-badges');
    if (group.hasCurrent) {
      badges.append($('<span>').addClass('save-file-badge').text('Current available'));
    }
    badges.append($('<span>').addClass('save-file-badge').text(group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's')));
    detail.append(badges);
    detail.append($('<span>').addClass('save-file-meta').text(groupedSaveSummary(group)));
    detail.on('click', function(saveGroup) {
      return function() {
        openSaveVersionPicker(saveGroup, backHandler, options);
      };
    }(group));
    var download = $('<button>').attr('type', 'button').text(options.mode === 'launch' ? (group.versions.length > 1 ? 'Choose Save' : 'Use Save') : (group.versions.length > 1 ? 'Versions' : 'Download'));
    download.on('click', function(saveGroup) {
      return function() {
        openSaveVersionPicker(saveGroup, backHandler, options);
      };
    }(group));
    row.append(detail, download);
    $(target).append(row);
  }
}
function closeSavePanel() {
  setSavePanelBack(null);
  $('#save-panel').addClass('hidden');
  clearFrontPanelFocus('#save-panel');
}
function closeVariantPanel() {
  variantPanelState = null;
  $('#variant-panel').addClass('hidden');
  clearFrontPanelFocus('#variant-panel');
}
function closeInfoPanel() {
  $('#info-panel').addClass('hidden');
}
function usePopupSelectors() {
  return selectorStyle === 'popup';
}
function saveSelectorStackState() {
  try {
    sessionStorage.setItem('ejsSelectorMenuStack', JSON.stringify(selectorMenuStack));
  } catch (e) {
    console.log(e);
  }
}
function loadSelectorStackState() {
  try {
    selectorMenuStack = JSON.parse(sessionStorage.getItem('ejsSelectorMenuStack') || '[]');
    if (!Array.isArray(selectorMenuStack)) {
      selectorMenuStack = [];
    }
  } catch (e) {
    selectorMenuStack = [];
  }
}
function storeSelectorRouteState(route, config, activeItem) {
  try {
    sessionStorage.setItem('ejsSelectorRouteState', JSON.stringify({
      route: route,
      config: config,
      activeItem: typeof activeItem === 'number' ? activeItem : 0
    }));
  } catch (e) {
    console.log(e);
  }
}
function loadSelectorRouteState() {
  try {
    return JSON.parse(sessionStorage.getItem('ejsSelectorRouteState') || 'null');
  } catch (e) {
    return null;
  }
}
function clearSelectorRouteState() {
  try {
    sessionStorage.removeItem('ejsSelectorRouteState');
  } catch (e) {
    console.log(e);
  }
}
function storeMenuRestoreState(snapshot) {
  try {
    sessionStorage.setItem('ejsMenuRestoreState', JSON.stringify(snapshot || null));
  } catch (e) {
    console.log(e);
  }
}
function loadMenuRestoreState() {
  try {
    return JSON.parse(sessionStorage.getItem('ejsMenuRestoreState') || 'null');
  } catch (e) {
    return null;
  }
}
function clearMenuRestoreState() {
  try {
    sessionStorage.removeItem('ejsMenuRestoreState');
  } catch (e) {
    console.log(e);
  }
}
function isSelectorRoute(hash) {
  return hash === selectorRouteMap.variant || hash === selectorRouteMap.save;
}
function snapshotMenuState() {
  return {
    hash: window.location.hash || '#main',
    config: $('#menu').data('config') || null,
    activeItem: currentMenuActiveItem || 0,
    filter: $('#console-list-search').val() || '',
    menuActionIndex: menuActionIndex || 0
  };
}
function restoreMenuState(snapshot) {
  if (!snapshot || !snapshot.config) {
    return false;
  }
  rendermenu([snapshot.config, snapshot.activeItem || 0]);
  setTimeout(function() {
    $('#console-list-search').val(snapshot.filter || '');
    $('#console-list-search').trigger('input');
    currentMenuActiveItem = snapshot.activeItem || 0;
    menuActionIndex = snapshot.menuActionIndex || 0;
    syncMenuControllerSelection();
  }, 0);
  return true;
}
function openSelectorMenu(config, activeItem) {
  selectorMenuStack.push(snapshotMenuState());
  saveSelectorStackState();
  storeSelectorVisualState();
  var route = selectorRouteMap[config.selectorKind] || selectorRouteMap.variant;
  storeSelectorRouteState(route, config, activeItem);
  if (window.location.hash === route) {
    rendermenu([config, typeof activeItem === 'number' ? activeItem : 0]);
    return;
  }
  window.location.href = route;
}
function closeSelectorMenu() {
  var snapshot = selectorMenuStack.pop();
  saveSelectorStackState();
  clearSelectorRouteState();
  if (!snapshot) {
    window.location.href = '#main';
    return;
  }
  storeMenuRestoreState(snapshot);
  window.location.href = snapshot.hash || '#main';
}
function variantCodeSummary(variant) {
  var lines = [];
  (variant.codeTooltips || []).forEach(function(item) {
    if (item && item.description && lines.indexOf(item.description) === -1) {
      lines.push(repairDisplayText(item.description));
    }
  });
  return lines.join(' | ');
}
function variantSummary(variant) {
  var bits = [];
  if (variant.regionLabel) {
    bits.push(repairDisplayText(variant.regionLabel));
  }
  if (variant.versionLabel) {
    bits.push(repairDisplayText(variant.versionLabel));
  }
  if (variant.extraLabel) {
    bits.push(repairDisplayText(variant.extraLabel));
  }
  return bits.join(' | ') || 'Default release';
}
function openVariantInfo(event, variant, groupTitle) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  var title = safeDecodeDisplayName((groupTitle || variant.name || 'Game') + ' Info');
  var tooltipText = variantTooltipText(variant);
  $('#info-panel-title').text(title);
  $('#info-panel-results').empty();
  if (!tooltipText) {
    $('#info-panel-status').text('No additional GoodTools notes were found for this version.');
  } else {
    $('#info-panel-status').text('GoodTools metadata for this version:');
    tooltipText.split('\n').forEach(function(line) {
      $('#info-panel-results').append($('<p>').addClass('info-panel-copy').text(repairDisplayText(line)));
    });
  }
  $('#info-panel').removeClass('hidden');
}
function downloadVariantRom(event, button) {
  downloadRom(event, button);
  closeVariantPanel();
}
function handleRomDownload(event, button) {
  event.preventDefault();
  event.stopPropagation();
  var variantCount = Number(button.getAttribute('data-variant-count') || '1');
  var menuIndex = Number(button.getAttribute('data-menu-index'));
  var entries = $('#menu').data('menuEntries') || [];
  var entry = !isNaN(menuIndex) ? entries[menuIndex] : null;
  if (variantCount > 1 && entry && entry.variants) {
    openVariantSelector(entry, {mode: 'download'});
    return;
  }
  downloadRom(event, button);
}
function renderVariantPanel() {
  if (!variantPanelState || !variantPanelState.variants || variantPanelState.variants.length <= 1) {
    closeVariantPanel();
    return;
  }
  var favoriteMode = variantPanelState.mode === 'favorite';
  var downloadMode = variantPanelState.mode === 'download';
  $('#variant-panel-title').text(safeDecodeDisplayName(variantPanelState.title || (favoriteMode ? 'Choose a Favorite' : 'Choose a Version')));
  $('#variant-panel-status').text(favoriteMode
    ? 'Pick a version to favorite, or click the title to launch it.'
    : (downloadMode
      ? 'Pick a version to download, or click the title to launch it.'
      : variantPanelState.variants.length + ' version' + (variantPanelState.variants.length === 1 ? '' : 's') + ' available'));
  $('#variant-panel-results').empty();
  for (var variant of variantPanelState.variants) {
    var row = $('<div>').addClass('variant-result-row');
    var button = $('<button>').addClass('variant-launch').attr('type', 'button');
    var tooltipText = variantTooltipText(variant);
    button.attr('onclick', 'launch(this)');
    button.attr('data-variant-choice', 'true');
    button.attr('data-group-display-name', variantPanelState.title || variant.displayName || variant.name);
    button.attr('data-close-variant-panel', 'true');
    button.attr('data-parent-root', variantPanelState.root || '');
    button.attr('data-parent-title', variantPanelState.consoleTitle || '');
    button.attr('data-group-key', variantPanelState.groupKey || '');
    button.attr('data-variant-label', variantSummary(variant));
    button.attr('data-variant-count', '1');
    button.attr('data-display-name', variant.displayName || variant.name);
    button.attr('data-name', variant.name);
    button.attr('data-original-index', Number(variant.index || 0));
    if (tooltipText) {
      button.attr('title', tooltipText);
    }
    for (var key of defaultKeys) {
      button.attr('data-' + key, String(variant.resolved[key] || ''));
    }
    button.append($('<span>').addClass('variant-launch-title').text(safeDecodeDisplayName(variant.name)));
    button.append($('<span>').addClass('variant-launch-meta').text(variantSummary(variant)));
    var codeSummary = variantCodeSummary(variant);
    if (codeSummary) {
      button.append($('<span>').addClass('variant-launch-notes').text(codeSummary));
    }
    var actions = $('<div>').addClass('variant-actions');
    var downloadButton = $('<button>')
      .addClass('panel-icon-button')
      .attr('type', 'button')
      .attr('title', 'Download this version')
      .attr('aria-label', 'Download this version')
      .html('&#10515;');
    downloadButton.attr('data-rom-path', variant.resolved.path || '');
    downloadButton.attr('data-rom-name', variant.name);
    downloadButton.attr('data-rom-extension', String(variant.resolved.rom_extension || ''));
    downloadButton.on('click', function(element) {
      return function(event) {
        downloadVariantRom(event, element);
      };
    }(downloadButton.get(0)));
    actions.append(downloadButton);
    var favoriteButton = $('<button>')
      .addClass('panel-icon-button variant-favorite')
      .attr('type', 'button')
      .attr('title', isFavorite(variant.id) ? 'Remove from favorites' : 'Add to favorites')
      .attr('aria-label', isFavorite(variant.id) ? 'Remove from favorites' : 'Add to favorites')
      .attr('data-favorite-id', variant.id)
      .attr('data-favorite-name', variant.name)
      .attr('data-favorite-exact-name', variant.name)
      .attr('data-favorite-root', variant.root || variantPanelState.root || '')
      .attr('data-favorite-title', variant.title || variantPanelState.consoleTitle || '')
      .attr('data-favorite-index', Number(variant.index || 0))
      .attr('data-favorite-variant-count', '1')
      .attr('data-favorite-variant-choice', favoriteMode ? 'true' : 'false')
      .toggleClass('is-favorite', isFavorite(variant.id))
      .html('&hearts;');
    favoriteButton.on('click', function(favoriteId, element) {
      return function(event) {
        toggleFavorite(event, favoriteId, element);
      };
    }(variant.id, favoriteButton.get(0)));
    actions.append(favoriteButton);
    row.append(button, actions);
    $('#variant-panel-results').append(row);
  }
  $('#variant-panel').removeClass('hidden');
}
function variantSelectorSubtitle(variant) {
  var parts = [];
  if (variant.regionLabel) {
    parts.push(variant.regionLabel);
  }
  if (variant.versionLabel) {
    parts.push(variant.versionLabel);
  }
  if (variant.extraLabel) {
    parts.push(variant.extraLabel);
  }
  return parts.join(' | ');
}
function variantSelectorDetails(variant) {
  return (variant.codeTooltips || []).map(function(item) {
    return item.description;
  }).filter(Boolean).join(' | ');
}
function buildVariantSelectorConfig(entry, mode) {
  var currentConfig = $('#menu').data('config') || {};
  var items = {};
  entry.variants.forEach(function(variant, index) {
    var key = variant.name + ' #' + index;
    var item = Object.assign({}, variant.resolved);
    if (mode === 'favorite') {
      item.type = 'selector-favorite';
      item.selector_favorite_id = variant.id;
      item.selector_favorite_name = variant.displayName || variant.name;
      item.selector_favorite_exact_name = variant.name;
      item.selector_favorite_root = variant.root || entry.root || '';
      item.selector_favorite_title = variant.title || entry.title || '';
      item.selector_favorite_index = variant.index;
    } else if (mode === 'download') {
      item.type = 'selector-download';
      item.selector_rom_path = variant.path || '';
      item.selector_rom_name = variant.name || '';
      item.selector_rom_extension = variant.extension || '';
    } else {
      item.type = 'game';
      item.multi_disc = Number(item.multi_disc || 0);
      item.variant_choice = true;
    }
    item.has_logo = false;
    item.has_video = false;
    item.selector_subtitle = variantSelectorSubtitle(variant);
    item.selector_details = variantSelectorDetails(variant);
    item.selector_display_name = variant.displayName || variant.name;
    item.selector_original_index = variant.index;
    items[key] = item;
  });
  return {
    title: entry.displayName || entry.name,
    root: entry.root || $('#menu').data('root') || 'main',
    parent: '',
    defaults: Object.assign({}, currentConfig.defaults || {}),
    display_items: currentConfig.display_items || 7,
    items: items,
    selectorMode: true,
    selectorKind: 'variant',
    selectorVariantMode: mode || 'launch'
  };
}
function buildSaveSelectorConfig(gameLabel, saves, originalIndex) {
  var currentConfig = $('#menu').data('config') || {};
  var items = {};
  items['Launch Without Restoring'] = {
    type: 'selector-action',
    selector_action: 'skip-save',
    has_logo: false,
    has_video: false,
    selector_subtitle: 'Start the game without restoring a previous save',
    selector_details: '',
    selector_original_index: originalIndex
  };
  saves.forEach(function(save, index) {
    var item = {
      type: 'selector-save',
      selector_save_id: save.id,
      has_logo: false,
      has_video: false,
      selector_subtitle: saveVersionSummary(save),
      selector_details: save.notes || '',
      selector_display_name: save.name,
      selector_original_index: originalIndex
    };
    items[(save.name || 'Save') + ' #' + index] = item;
  });
  return {
    title: 'Launch ' + safeDecodeDisplayName(gameLabel),
    root: $('#menu').data('root') || 'main',
    parent: '',
    defaults: Object.assign({}, currentConfig.defaults || {}),
    display_items: currentConfig.display_items || 7,
    items: items,
    selectorMode: true,
    selectorKind: 'save'
  };
}
function openVariantSelector(entry, options) {
  if (!entry || !entry.variants || entry.variants.length <= 1) {
    return;
  }
  if (usePopupSelectors()) {
    openVariantPanel(entry, options);
    return;
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeSavePanel();
  closeInfoPanel();
  openSelectorMenu(buildVariantSelectorConfig(entry, options && options.mode || 'launch'), 0);
}
function openVariantPanel(entry, options) {
  if (!entry || !entry.variants || entry.variants.length <= 1) {
    return;
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeSavePanel();
  closeInfoPanel();
  variantPanelState = {
    title: entry.displayName || entry.name,
    groupKey: entry.groupKey || '',
    root: entry.root || '',
    consoleTitle: entry.title || '',
    variants: entry.variants.slice(),
    mode: options && options.mode || 'launch'
  };
  renderVariantPanel();
  focusFrontPanel('#variant-panel', '.variant-launch, .panel-icon-button');
}
function cloneLaunchButton(button) {
  var source = button && button.jquery ? button.get(0) : button;
  var temp = $('<button type="button">');
  if (source && source.attributes) {
    Array.prototype.forEach.call(source.attributes, function(attr) {
      temp.attr(attr.name, attr.value);
    });
  }
  temp.attr('data-save-selection-ready', 'true');
  return temp;
}
async function openLaunchSavePickerForButton(button) {
  var selected = button && button.jquery ? button : $(button);
  var gameLabel = selected.attr('data-group-display-name') || selected.attr('data-display-name') || selected.attr('data-name') || 'Game';
  var gameBase = saveBasename((selected.attr('data-name') || gameLabel) + (selected.attr('data-rom_extension') || ''));
  var saves = (await getSaveInventory(true)).filter(function(save) {
    return saveRecordMatchesGame(save, gameBase);
  });
  if (!saves.length) {
    var directLaunch = cloneLaunchButton(selected);
    launch(directLaunch);
    return;
  }
  pendingLaunchSelection = {
    buttonAttrs: serializeButtonData(cloneLaunchButton(selected)),
    gameName: gameLabel,
    gameBase: gameBase
  };
  savePendingLaunchSelection();
  if (!usePopupSelectors()) {
    closeSearchPanel();
    closeFavoritesPanel();
    closeLoginPanel();
    closeVariantPanel();
    closeInfoPanel();
    openSelectorMenu(buildSaveSelectorConfig(gameLabel, saves, Number(selected.attr('data-original-index') || selectedIndex || 0)), 0);
    return;
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeVariantPanel();
  $('#save-panel-title').text('Launch ' + safeDecodeDisplayName(gameLabel));
  $('#save-panel-status').text('Choose which save version to restore before launch.');
  $('#save-panel-results').empty();
  $('#save-panel').removeClass('hidden');
  setSavePanelBack(null);
  renderSaveRows('#save-panel-results', saves, 'No matching saves found for this game yet.', null, {
    mode: 'launch',
    titlePrefix: gameLabel,
    statusText: 'Choose which save version to restore before launch.',
    onSelect: async function(saveId) {
      $('#save-panel-status').text('Restoring save...');
      var restored = await restoreSaveForLaunch(saveId);
      if (!restored) {
        $('#save-panel-status').text('Unable to restore that save.');
        return;
      }
      closeSavePanel();
      if (pendingLaunchSelection && pendingLaunchSelection.buttonAttrs) {
        var launchButton = deserializeLaunchButton(pendingLaunchSelection.buttonAttrs);
        if (launchButton) {
          launch(launchButton);
        }
      }
      clearPendingLaunchSelection();
    },
    onSkip: function() {
      closeSavePanel();
      if (pendingLaunchSelection && pendingLaunchSelection.buttonAttrs) {
        var launchButton = deserializeLaunchButton(pendingLaunchSelection.buttonAttrs);
        if (launchButton) {
          launch(launchButton);
        }
      }
      clearPendingLaunchSelection();
    }
  });
  focusFrontPanel('#save-panel', '.search-result, button');
}
async function openGameSaves(event, gameName, gameBase) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeVariantPanel();
  closeInfoPanel();
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
  focusFrontPanel('#save-panel', '.search-result, button');
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
function isLoginGateActive() {
  return requireMainLogin && (!localStorage.getItem('user') || !localStorage.getItem('pass'));
}
function silenceBackgroundMedia(clearSource) {
  var video = $('#bgvid').get(0);
  if (!video) {
    return;
  }
  video.pause();
  video.muted = true;
  video.volume = 0;
  if (clearSource) {
    $('#vid').removeAttr('src');
    video.load();
  }
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
    clearInterval(profilePushTimer);
    profilePushTimer = null;
    stopSaveWatchTimer();
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
      silenceBackgroundMedia(true);
      $('#background').attr('src', '');
      $('#corner').attr('src', '');
      $('#console-list-tools').addClass('hidden');
      focusFrontPanel('#login-panel', '#profile-user, button');
    } else {
      clearFrontPanelFocus('#login-panel');
    }
  }
}
function openLoginPanel() {
  closeSearchPanel();
  closeFavoritesPanel();
  closeSavePanel();
  closeVariantPanel();
  $('#login-panel').removeClass('hidden');
  updateLoginState();
  focusFrontPanel('#login-panel', '#profile-user, button');
}
function closeLoginPanel() {
  if (requireMainLogin && !localStorage.getItem('user')) {
    return;
  }
  $('#login-panel').addClass('hidden');
  clearFrontPanelFocus('#login-panel');
}
async function profileLogin() {
  var user = $('#profile-user').val();
  var pass = $('#profile-pass').val();
  $('#profile-pass').val('');
  setProfileStatus('Logging in...');
  try {
    var res = await profileRequest({user:user, pass:pass, type:'login', source:'frontend-profile'});
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
    var res = await profileRequest({user:localStorage.getItem('user'), pass:localStorage.getItem('pass'), type:'login', source:'frontend-verify', silent:true});
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
  clearInterval(profilePushTimer);
  profilePushTimer = null;
  stopSaveWatchTimer();
  updateLoginState();
  setProfileStatus('Logged out.');
}

async function loadPublicSettings() {
  try {
    var res = await profileRequest({type:'publicsettings'});
    var json = await res.json();
    requireMainLogin = json.status == 'success' && json.requireLogin === true;
    selectorStyle = json.status == 'success' && json.selectorStyle === 'popup' ? 'popup' : 'menu';
    launchErrorDebug = json.status == 'success' && json.launchErrorDebug === true;
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
  var normalizedPath = normalizeLocalSavePath(relativePath);
  var targetPath = '/' + normalizedPath;
  var parent = targetPath.split('/').slice(0, -1).join('/') || '/';
  ensureProfileDirSync(parent);
  var changed = true;
  if (profileFs.existsSync(targetPath)) {
    var existing = profileFs.readFileSync(targetPath);
    if (Buffer.from(existing).equals(Buffer.from(buffer))) {
      if (isProfileSavePath(normalizedPath)) {
        await ensureLocalSaveVersioned(normalizedPath, Buffer.from(buffer), {
          source: 'Local profile',
          notes: 'Local profile write matched current bytes.'
        });
      }
      return;
    }
    changed = true;
    var backupPath = localProfileBackupPath(relativePath, stamp);
    var backupParent = backupPath.split('/').slice(0, -1).join('/') || '/';
    ensureProfileDirSync(backupParent);
    profileFs.writeFileSync(backupPath, Buffer.from(existing));
  }
  profileFs.writeFileSync(targetPath, Buffer.from(buffer));
  if (isProfileSavePath(normalizedPath)) {
    await ensureLocalSaveVersioned(normalizedPath, Buffer.from(buffer), {
      source: 'Local profile',
      notes: changed ? 'Stored local browser version.' : 'Stored local browser version.'
    });
  }
}
async function addProfileFsToZip(zip, item) {
  if (item === '/.history' || item.indexOf('/.history/') === 0 || item === '/' + localSaveVersionRoot || item.indexOf('/' + localSaveVersionRoot + '/') === 0) {
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
    await watchLocalSaveChanges(true);
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
function queueProfilePush(forceImmediate) {
  if (!localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  if (!forceImmediate && window.location.hash !== '#game' && document.visibilityState === 'visible') {
    setProfileStatus('Saved locally. Use Push to Server to sync now.');
    return;
  }
  clearTimeout(profilePushTimeout);
  profilePushTimeout = setTimeout(function() {
    pushServerProfile(true);
  }, 2000);
}
function startSaveWatchTimer(forceBaseline) {
  if (saveWatchTimer || !localStorage.getItem('user') || !localStorage.getItem('pass')) {
    return;
  }
  watchLocalSaveChanges(forceBaseline !== false);
  saveWatchTimer = setInterval(function() {
    watchLocalSaveChanges(false);
  }, 15000);
}
function stopSaveWatchTimer() {
  clearInterval(saveWatchTimer);
  saveWatchTimer = null;
  saveWatchInFlight = false;
  lastSaveWatchSignature = null;
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
    exactName: $button.attr('data-favorite-exact-name') || cleanGameName($button.attr('data-favorite-name'), favoriteId),
    root: $button.attr('data-favorite-root') || 'main',
    title: $button.attr('data-favorite-title') || 'Games',
    index: Number($button.attr('data-favorite-index') || 0)
  };
}
function isFavorite(favoriteId) {
  return getFavoriteIds().indexOf(favoriteId) !== -1;
}
function favoriteIdsForButton(button) {
  var $button = $(button);
  var count = Number($button.attr('data-favorite-variant-count') || 1);
  var menuIndex = Number($button.attr('data-menu-index'));
  var entries = $('#menu').data('menuEntries') || [];
  var entry = !isNaN(menuIndex) ? entries[menuIndex] : null;
  if (count > 1 && entry && entry.variants) {
    return entry.variants.map(function(variant) {
      return variant.id;
    });
  }
  return [$button.attr('data-favorite-id')];
}
function refreshFavoriteButtons() {
  $('.favorite-toggle').each(function() {
    var ids = favoriteIdsForButton(this);
    var active = ids.some(function(id) {
      return isFavorite(id);
    });
    $(this).toggleClass('is-favorite', active);
    $(this).attr('aria-pressed', active);
    $(this).attr('title', active ? 'Remove from favorites' : 'Add to favorites');
  });
  $('.variant-favorite').each(function() {
    var active = isFavorite(this.dataset.favoriteId);
    $(this).toggleClass('is-favorite', active);
    $(this).attr('aria-pressed', active);
    $(this).attr('title', active ? 'Remove from favorites' : 'Add to favorites');
    $(this).attr('aria-label', active ? 'Remove from favorites' : 'Add to favorites');
  });
  $('.favorite-indicator').toggleClass('is-favorite', true);
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
  var $button = $(button);
  var variantCount = Number($button.attr('data-favorite-variant-count') || 1);
  var menuIndex = Number($button.attr('data-menu-index'));
  var entries = $('#menu').data('menuEntries') || [];
  var entry = !isNaN(menuIndex) ? entries[menuIndex] : null;
  if (variantCount > 1 && !$button.attr('data-favorite-variant-choice') && entry && entry.variants) {
    openVariantSelector(entry, {mode: 'favorite'});
    return;
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
  refreshFavoriteButtons();
  if (!$('#search-panel').hasClass('hidden')) {
    runGameSearch();
  }
  if (!$('#favorites-panel').hasClass('hidden')) {
    renderFavoritesPanel();
  }
  if ($button.attr('data-favorite-variant-choice')) {
    closeVariantPanel();
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
function openMenuInfo(event, button) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  var menuIndex = Number(button.getAttribute('data-menu-index'));
  var entries = $('#menu').data('menuEntries') || [];
  var entry = !isNaN(menuIndex) ? entries[menuIndex] : null;
  if (!entry || !entry.representative) {
    return;
  }
  openVariantInfo(event, entry.representative, entry.displayName || entry.name);
}
function openSearchPanel() {
  closeFavoritesPanel();
  closeSavePanel();
  closeVariantPanel();
  closeInfoPanel();
  $('#search-panel').removeClass('hidden');
  focusFrontPanel('#search-panel', '#game-search');
  ensureSearchCatalog().then(function() {
    runGameSearch();
  });
  setTimeout(function() {
    $('#game-search').trigger('focus');
  }, 0);
}
function closeSearchPanel() {
  $('#search-panel').addClass('hidden');
  clearFrontPanelFocus('#search-panel');
}
function closeFavoritesPanel() {
  $('#favorites-panel').addClass('hidden');
  clearFrontPanelFocus('#favorites-panel');
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
  closeVariantPanel();
  closeInfoPanel();
  $('#favorites-panel').removeClass('hidden');
  $('#favorites-status').text('Loading favorites...');
  $('#favorites-results').empty();
  ensureSearchCatalog().then(function() {
    renderFavoritesPanel();
    focusFrontPanel('#favorites-panel', '.search-result, .panel-icon-button, button');
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
    var openButton = $('<button>').addClass('search-result').attr('type', 'button').attr('onclick', 'openFavoriteResult("' + item.id + '")');
    openButton.append($('<span>').addClass('search-result-title').html('&hearts; ' + escapeHtml(cleanGameName(item.name, item.id))));
    openButton.append($('<span>').addClass('search-result-meta').text(item.title || item.root || 'Games'));
    var actions = $('<div>').addClass('favorite-actions');
    var removeButton = $('<button>').addClass('panel-icon-button favorite-remove favorite-indicator is-favorite').attr('type', 'button').attr('title', 'Remove from favorites').attr('aria-label', 'Remove from favorites').html('&hearts;');
    removeButton.on('click', function(favoriteId) {
      return function(event) {
        toggleFavorite(event, favoriteId);
      };
    }(item.id));
    actions.append(removeButton);
    row.append(openButton, actions);
    $('#favorites-results').append(row);
  }
  if (getActiveFrontPanel() === '#favorites-panel') {
    focusFrontPanel('#favorites-panel', '.search-result, .panel-icon-button, button');
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
  Object.keys(item || {}).forEach(function(key) {
    if (!resolved.hasOwnProperty(key)) {
      resolved[key] = item[key];
    }
  });
  return resolved;
}
function normalizeVariantKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function terminalVariantToken(name) {
  return name.match(/(\[[^\]]+\]|\([^()]+\))\s*$/);
}
var goodToolsRegionLabels = {
  u: 'USA',
  usa: 'USA',
  e: 'Europe',
  europe: 'Europe',
  j: 'Japan',
  japan: 'Japan',
  w: 'World',
  world: 'World',
  ue: 'USA, Europe',
  'usa, europe': 'USA, Europe',
  'europe, usa': 'USA, Europe',
  g: 'Germany',
  germany: 'Germany',
  f: 'France',
  france: 'France',
  s: 'Spain',
  spain: 'Spain',
  i: 'Italy',
  it: 'Italy',
  italy: 'Italy',
  a: 'Australia',
  australia: 'Australia',
  asia: 'Asia',
  k: 'Korea',
  korea: 'Korea',
  c: 'China',
  china: 'China',
  hk: 'Hong Kong',
  'hong kong': 'Hong Kong',
  nl: 'Netherlands',
  netherlands: 'Netherlands',
  unl: 'Unlicensed',
  pd: 'Public Domain'
};
var goodToolsCodeExplanations = {
  '!': 'Verified good dump.',
  a: 'Alternate version.',
  b: 'Bad dump.',
  f: 'Fixed or patched dump.',
  h: 'Hack.',
  o: 'Overdump.',
  p: 'Pirate release.',
  t: 'Trained release.',
  m: 'Multilanguage release.',
  pd: 'Public domain release.',
  unl: 'Unlicensed release.',
  beta: 'Beta build.',
  proto: 'Prototype build.',
  sample: 'Sample build.',
  demo: 'Demo build.',
  kiosk: 'Kiosk or demo unit build.',
  promo: 'Promotional build.',
  alpha: 'Alpha build.'
};
function normalizeGoodToolsRegion(value) {
  return goodToolsRegionLabels[String(value || '').trim().toLowerCase()] || '';
}
function explainGoodToolsCode(value) {
  var content = String(value || '').trim();
  if (!content) {
    return '';
  }
  var lower = content.toLowerCase();
  if (goodToolsCodeExplanations[lower]) {
    return goodToolsCodeExplanations[lower];
  }
  if (/^t[+-]/i.test(content)) {
    return 'Translation patch (' + content + ').';
  }
  if (/^m\d+$/i.test(content)) {
    return 'Multilanguage release (' + content + ').';
  }
  var family = lower.charAt(0);
  if (goodToolsCodeExplanations[family]) {
    return goodToolsCodeExplanations[family] + (content.length > 1 ? ' (' + content + ')' : '');
  }
  return 'GoodTools code ' + content + '.';
}
function classifyGoodToolsToken(rawToken) {
  var raw = String(rawToken || '');
  var content = raw.slice(1, -1).trim();
  var lower = content.toLowerCase();
  var region = normalizeGoodToolsRegion(content);
  if (region) {
    return {type: 'region', value: region, raw: raw, content: content};
  }
  if (isVersionLabel(content)) {
    return {type: 'version', value: content.toUpperCase(), raw: raw, content: content};
  }
  if (raw === '[!]') {
    return {type: 'quality', family: '!', value: content, raw: raw, content: content, label: explainGoodToolsCode(content || '!')};
  }
  if (/^(alpha|beta|proto|prototype|sample|demo|kiosk|promo)$/i.test(content)) {
    return {type: 'release', family: lower.replace('prototype', 'proto'), value: content, raw: raw, content: content, label: explainGoodToolsCode(content)};
  }
  if (/^t[+-]/i.test(content)) {
    return {type: 'flag', family: 'translation', value: content, raw: raw, content: content, label: explainGoodToolsCode(content)};
  }
  if (/^m\d+$/i.test(content)) {
    return {type: 'flag', family: 'multilanguage', value: content, raw: raw, content: content, label: explainGoodToolsCode(content)};
  }
  if (/^(a|b|f|h|o|p|t)\d*[a-z]*$/i.test(content) || /^(pd|unl)$/i.test(content)) {
    return {type: 'flag', family: content.toLowerCase().charAt(0), value: content, raw: raw, content: content, label: explainGoodToolsCode(content)};
  }
  return {type: 'flag', family: 'other', value: content, raw: raw, content: content, label: explainGoodToolsCode(content)};
}
function variantTooltipText(variant) {
  var lines = [];
  (variant.codeTooltips || []).forEach(function(item) {
    if (item && item.code && item.description) {
      lines.push(item.code + ': ' + item.description);
    }
  });
  if (variant.clean && !lines.some(function(line) { return line.indexOf('[!]') === 0; })) {
    lines.push('[!]: Verified good dump.');
  }
  return lines.join('\n');
}
function isRegionLabel(value) {
  return !!normalizeGoodToolsRegion(value);
}
function isVersionLabel(value) {
  return /^(v\d+(\.\d+)?|rev(ision)?\s*\d+)$/i.test(String(value || '').trim());
}
function parseVariantInfo(name) {
  var working = String(name || '').trim();
  var tokens = [];
  var parsedTokens = [];
  while (true) {
    var match = terminalVariantToken(working);
    if (!match) {
      break;
    }
    var token = match[1];
    var parsed = classifyGoodToolsToken(token);
    if (token.startsWith('[') || parsed.type === 'region' || parsed.type === 'version' || parsed.type === 'release') {
      tokens.unshift(token);
      parsedTokens.unshift(parsed);
      working = working.slice(0, match.index).trim();
      continue;
    }
    break;
  }
  var region = '';
  var version = '';
  var flags = [];
  var clean = false;
  var codeTooltips = [];
  parsedTokens.forEach(function(token) {
    if (!region && token.type === 'region') {
      region = token.value;
      return;
    }
    if (!version && token.type === 'version') {
      version = token.value;
      return;
    }
    if (token.family === '!') {
      clean = true;
    }
    flags.push(token.raw);
    if (token.label) {
      codeTooltips.push({code: token.raw, description: token.label});
    }
  });
  var title = working || String(name || '').trim();
  var extraLabel = flags.map(function(flag) {
    return flag.slice(1, -1);
  }).join(', ');
  return {
    name: name,
    title: title,
    groupKey: normalizeVariantKey(title),
    regionLabel: region,
    versionLabel: version,
    extraLabel: extraLabel,
    flags: flags,
    clean: clean,
    codeTooltips: codeTooltips,
    searchText: [name, title, region, version, extraLabel].join(' ').toLowerCase()
  };
}
function regionPriority(label) {
  var value = String(label || '').toUpperCase();
  if (value === 'U' || value === 'USA') {
    return 120;
  }
  if (value === 'USA, EUROPE' || value === 'EUROPE, USA' || value === 'UE') {
    return 110;
  }
  if (value === 'E' || value === 'EUROPE') {
    return 100;
  }
  if (value === 'WORLD') {
    return 95;
  }
  if (value === 'J' || value === 'JAPAN') {
    return 90;
  }
  if (value === 'G' || value === 'GERMANY' || value === 'F' || value === 'FRANCE' || value === 'S' || value === 'SPAIN' || value === 'IT' || value === 'ITALY') {
    return 85;
  }
  return value ? 70 : 60;
}
function versionPriority(label) {
  var match = String(label || '').toUpperCase().match(/(\d+)(?:\.(\d+))?/);
  if (!match) {
    return 0;
  }
  return (Number(match[1] || 0) * 100) + Number(match[2] || 0);
}
function variantPreferenceScore(variant) {
  var score = 0;
  if (variant.resolved.has_logo === true || variant.resolved.has_logo === 'true') {
    score += 30;
  }
  if (variant.resolved.has_video === true || variant.resolved.has_video === 'true') {
    score += 20;
  }
  if (variant.clean) {
    score += 10;
  }
  score += regionPriority(variant.regionLabel);
  score += versionPriority(variant.versionLabel);
  if (variant.extraLabel) {
    score -= 5;
  }
  return score;
}
function groupConsoleItems(consoleConfig, consoleRoot) {
  var defaults = consoleConfig.defaults || {};
  var groups = {};
  var entries = [];
  var index = 0;
  var allowGrouping = consoleConfig.selectorMode !== true && consoleRoot !== 'main' && !(consoleConfig.hasOwnProperty('multi_name') && hasUsableValue(consoleConfig.multi_name));
  Object.keys(consoleConfig.items).forEach(function(name) {
    var item = consoleConfig.items[name];
    if ((item.hasOwnProperty('cloneof')) && (consoleConfig.items.hasOwnProperty(item.cloneof))) {
      return;
    }
    var resolved = resolveItem(item, defaults);
    var itemType = resolved.type;
    var parsed = parseVariantInfo(name);
    var variant = {
      id: resolved.path + '::' + name,
      name: name,
      displayName: parsed.title,
      title: consoleConfig.title || consoleRoot,
      root: consoleRoot,
      path: resolved.path,
      index: index,
      resolved: resolved,
      multiDisc: Number(resolved.multi_disc || 0),
      extension: resolved.rom_extension || '',
      hasLogo: resolved.has_logo === true || resolved.has_logo === 'true',
      hasVideo: resolved.has_video === true || resolved.has_video === 'true',
      groupKey: parsed.groupKey,
      regionLabel: parsed.regionLabel,
      versionLabel: parsed.versionLabel,
      extraLabel: parsed.extraLabel,
      flags: parsed.flags,
      clean: parsed.clean,
      codeTooltips: parsed.codeTooltips,
      searchText: parsed.searchText
    };
      if (!allowGrouping || itemType !== 'game') {
        entries.push({
          id: variant.id,
          key: 'single:' + name,
          name: name,
          displayName: item.selector_display_name || resolved.selector_display_name || name,
          root: consoleRoot,
          title: consoleConfig.title || consoleRoot,
          originalIndex: index,
          representative: variant,
          variants: [variant],
          variantCount: 1,
          selectorSubtitle: item.selector_subtitle || resolved.selector_subtitle || '',
          selectorDetails: item.selector_details || resolved.selector_details || '',
          searchText: variant.searchText,
          itemType: itemType
        });
      index++;
      return;
    }
    if (!groups[variant.groupKey]) {
      groups[variant.groupKey] = {
        id: variant.id,
        key: variant.groupKey,
        name: parsed.title,
        displayName: parsed.title,
        root: consoleRoot,
        title: consoleConfig.title || consoleRoot,
        variants: [],
        searchTextParts: []
      };
      entries.push(groups[variant.groupKey]);
    }
    groups[variant.groupKey].variants.push(variant);
    groups[variant.groupKey].searchTextParts.push(variant.searchText);
    index++;
  });
  entries.forEach(function(entry) {
    if (!entry.variants || entry.variants.length === 0) {
      return;
    }
    entry.variants.sort(function(a, b) {
      return variantPreferenceScore(b) - variantPreferenceScore(a) || a.name.localeCompare(b.name);
    });
    entry.representative = entry.variants[0];
    entry.originalIndex = entry.representative.index;
    entry.variantCount = entry.variants.length;
    entry.id = entry.representative.id;
    entry.itemType = entry.representative.resolved.type;
    entry.searchText = entry.searchTextParts ? entry.searchTextParts.join(' ') : entry.representative.searchText;
  });
  return entries;
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
      var consoleTitle = consoleConfig.title || consoleRoot;
      consoles.push({root: consoleRoot, title: consoleTitle});
      for await (var entry of groupConsoleItems(consoleConfig, consoleRoot)) {
        if (entry.itemType !== 'game') {
          continue;
        }
        var resolved = entry.representative.resolved;
        catalog.push({
          id: entry.id,
          name: entry.displayName,
          root: consoleRoot,
          title: consoleTitle,
          index: entry.originalIndex,
          path: resolved.path,
          hasLogo: resolved.has_logo === true || resolved.has_logo === 'true',
          hasVideo: resolved.has_video === true || resolved.has_video === 'true',
          multiDisc: Number(resolved.multi_disc || 0),
          extension: resolved.rom_extension || '',
          variantCount: entry.variantCount || 1,
          searchText: entry.searchText || entry.displayName.toLowerCase()
        });
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
    if (query && (item.searchText || item.name.toLowerCase()).indexOf(query) === -1) {
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
    if (item.variantCount > 1) {
      meta += ' - ' + item.variantCount + ' versions';
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
async function openFavoriteResult(favoriteId) {
  closeFavoritesPanel();
  var favorite = getFavorites().find(function(entry) {
    return entry.id === favoriteId;
  });
  if (!favorite) {
    return;
  }
  var root = favorite.root || 'main';
  var config = await fetchConfig(root);
  if (!config || !config.items || !config.items[favorite.exactName]) {
    openSearchResult(root, Number(favorite.index || 0));
    return;
  }
  $('#menu').data('config', config);
  $('#menu').data('root', root);
  var resolved = resolveItem(config.items[favorite.exactName], config.defaults || {});
  var temp = $('<button>');
  temp.attr('data-name', favorite.exactName);
  temp.attr('data-display-name', favorite.name || favorite.exactName);
  temp.attr('data-group-display-name', favorite.name || favorite.exactName);
  temp.attr('data-original-index', Number(favorite.index || 0));
  temp.attr('data-close-variant-panel', 'true');
  for (var key of defaultKeys) {
    temp.attr('data-' + key, String(resolved[key] || ''));
  }
  launch(temp);
}
function clearConsoleListFilter() {
  $('#console-list-search').val('').trigger('input');
}
function goBackToMain() {
  if (selectorMenuStack.length) {
    closeSelectorMenu();
    return;
  }
  closeSearchPanel();
  closeFavoritesPanel();
  closeLoginPanel();
  closeSavePanel();
  closeVariantPanel();
  $('#console-list-search').val('');
  if (window.location.hash === '#main') {
    loadjson('main');
  } else {
    window.location.href = '#main';
  }
}
function updateConsoleBackButton(root, data) {
  var showBack = selectorMenuStack.length > 0 || (root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name)));
  $('#console-back-button').toggleClass('hidden', !showBack);
}
// Load and play video
var loadvideo = debounce(function(active_item) {
  if (isLoginGateActive()) {
    silenceBackgroundMedia(true);
    return;
  }
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
  var selected = active_item && active_item.jquery ? active_item : (active_item && active_item.nodeType ? $(active_item) : $('#i' + active_item.toString()).first());
  var selectedIndex = selected.attr('id') ? Number(selected.attr('id').replace('i', '')) : Number(active_item);
  var name = selected.data('name');
  var displayName = selected.data('group-display-name') || selected.data('display-name') || name;
  var type = selected.data('type');
  var selectorAction = selected.attr('data-selector_action') || selected.attr('data-selector-action') || '';
  var selectorSaveId = selected.attr('data-selector_save_id') || selected.attr('data-selector-save-id') || '';
  var selectorFavoriteId = selected.attr('data-selector_favorite_id') || selected.attr('data-selector-favorite-id') || '';
  var multi = selected.data('multi_disc');
  var root = $('#menu').data('root');
  var originalActiveItem = Number(selected.attr('data-original-index') || selectedIndex);
  var menuEntries = $('#menu').data('menuEntries') || [];
  var menuIndex = Number(selected.attr('data-menu-index'));
  var groupedEntry = !isNaN(menuIndex) ? menuEntries[menuIndex] : null;
  if (type == 'selector-action') {
    if (selectorAction === 'skip-save') {
      if (pendingLaunchSelection && pendingLaunchSelection.buttonAttrs) {
        var skipLaunchButton = deserializeLaunchButton(pendingLaunchSelection.buttonAttrs);
        if (skipLaunchButton) {
          launch(skipLaunchButton);
        }
      }
      clearPendingLaunchSelection();
    } else if (selectorAction === 'back') {
      closeSelectorMenu();
    }
    return;
  }
  if (type == 'selector-save' && selectorSaveId) {
    restoreSaveForLaunch(selectorSaveId).then(function(restored) {
      if (!restored) {
        alert('Unable to restore that save.');
        return;
      }
      if (pendingLaunchSelection && pendingLaunchSelection.buttonAttrs) {
        var launchButton = deserializeLaunchButton(pendingLaunchSelection.buttonAttrs);
        if (launchButton) {
          launch(launchButton);
        }
      }
      clearPendingLaunchSelection();
    });
    return;
  }
  if (type == 'selector-favorite' && selectorFavoriteId) {
    toggleFavorite(null, selectorFavoriteId, selected.get(0));
    closeSelectorMenu();
    return;
  }
  if (type == 'selector-download') {
    downloadRom({
      preventDefault: function() {},
      stopPropagation: function() {}
    }, {
      getAttribute: function(attribute) {
        if (attribute === 'data-rom-path') return selected.attr('data-selector_rom_path') || selected.attr('data-selector-rom-path');
        if (attribute === 'data-rom-name') return selected.attr('data-selector_rom_name') || selected.attr('data-selector-rom-name');
        if (attribute === 'data-rom-extension') return selected.attr('data-selector_rom_extension') || selected.attr('data-selector-rom-extension');
        return '';
      }
    });
    closeSelectorMenu();
    return;
  }
  if (selected.data('variant-choice') !== true && groupedEntry && groupedEntry.variantCount > 1 && type == 'game') {
    openVariantSelector(groupedEntry);
    return;
  }
  if (selected.data('close-variant-panel') === true) {
    closeVariantPanel();
  }
  if (type == 'game' && selected.data('save-selection-ready') !== true) {
    openLaunchSavePickerForButton(selected);
    return;
  }
  $(document).attr('title', displayName);
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
        getGamepadsList().forEach(function(gp) {
          dispatchGamepadConnected(gp);
        });
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
    var gameConsoleTitle = $('#menu').data('config') && $('#menu').data('config').title ? $('#menu').data('config').title : root;
    document.documentElement.classList.add('gameplay');
    document.body.classList.add('gameplay');
    // Clear screen
    $('body').empty();
    document.body.className = 'gameplay';
    resetGameplayViewport();
    // Add game window
    var gameDiv = $('<div>').attr('id','game');
    $('body').append(gameDiv);
    var launchGlobalTarget = typeof globalThis !== 'undefined' ? globalThis : window;
    var hiddenLaunchGlobals = {
      process: launchGlobalTarget.process,
      module: launchGlobalTarget.module,
      exports: launchGlobalTarget.exports,
      require: launchGlobalTarget.require
    };
    function restoreLaunchGlobals() {
      try {
        if (typeof hiddenLaunchGlobals.process === 'undefined') {
          delete launchGlobalTarget.process;
        } else {
          launchGlobalTarget.process = hiddenLaunchGlobals.process;
        }
        if (typeof hiddenLaunchGlobals.module === 'undefined') {
          delete launchGlobalTarget.module;
        } else {
          launchGlobalTarget.module = hiddenLaunchGlobals.module;
        }
        if (typeof hiddenLaunchGlobals.exports === 'undefined') {
          delete launchGlobalTarget.exports;
        } else {
          launchGlobalTarget.exports = hiddenLaunchGlobals.exports;
        }
        if (typeof hiddenLaunchGlobals.require === 'undefined') {
          delete launchGlobalTarget.require;
        } else {
          launchGlobalTarget.require = hiddenLaunchGlobals.require;
        }
      } catch (e) {
        console.log('Unable to restore launch globals', e);
      }
    }
    try {
      launchGlobalTarget.process = undefined;
      launchGlobalTarget.module = undefined;
      launchGlobalTarget.exports = undefined;
      launchGlobalTarget.require = undefined;
    } catch (e) {
      console.log('Unable to hide Node-like globals during launch', e);
    }
    window.EJS_showLaunchError = function(message) {
      if (!launchErrorDebug) {
        return;
      }
      var target = document.getElementById('loading') || document.getElementById('game') || document.body;
      if (!target) {
        return;
      }
      var details = document.getElementById('launch-error-details');
      if (!details) {
        details = document.createElement('pre');
        details.id = 'launch-error-details';
        details.style.whiteSpace = 'pre-wrap';
        details.style.color = '#ff8a8a';
        details.style.padding = '12px';
        details.style.margin = '16px';
        details.style.maxWidth = '960px';
        details.style.fontSize = '16px';
        details.style.lineHeight = '1.4';
        details.style.background = 'rgba(0,0,0,0.65)';
        details.style.border = '1px solid rgba(255,138,138,0.5)';
        if (target.id === 'loading') {
          target.appendChild(details);
        } else {
          target.prepend(details);
        }
      }
      details.textContent = String(message || 'Unknown launch error');
    };
    window.onerror = function(message, source, lineno, colno, error) {
      var text = 'Launch error: ' + message;
      if (source) {
        text += '\nSource: ' + source + ':' + lineno + ':' + colno;
      }
      if (error && error.stack) {
        text += '\n' + error.stack;
      }
      console.log(text);
      if (launchErrorDebug) {
        window.EJS_showLaunchError(text);
      }
      restoreLaunchGlobals();
    };
    window.onunhandledrejection = function(event) {
      var reason = event && event.reason ? event.reason : 'Unknown promise rejection';
      var text = 'Launch promise rejection: ' + (reason && reason.stack ? reason.stack : reason);
      console.log(text);
      if (launchErrorDebug) {
        window.EJS_showLaunchError(text);
      }
      restoreLaunchGlobals();
    };
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
        resetGameplayViewport();
        restoreLaunchGlobals();
        notifyGameStarted({
          gameName: name,
          gameFile: gameSaveName,
          console: root,
          consoleTitle: gameConsoleTitle,
          path: path,
          emulator: emulator,
          romExtension: rom_extension,
          gameUrl: EJS_gameUrl
        });
        installQuickSaveMirror(gameSaveName);
        startSaveWatchTimer(true);
      };
    // Load touch screen interface
    if ((! EJSemu) && (window.orientation !== undefined) && localStorage.getItem('touchpad') !== 'false' && !getGamepadsList()[0]) {
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
    loaderscript.onerror = function() {
      restoreLaunchGlobals();
      if (launchErrorDebug) {
        window.EJS_showLaunchError('Failed to load startup script: ' + script);
      }
    };
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
  closeVariantPanel();
  var mobileSelectorMode = !!data.selectorMode && window.innerWidth <= 900;
  // Set default variables
  var portrait = window.orientation;
  if (data.selectorMode) {
    portrait = 0;
  }
  $('#menu').toggleClass('selector-route-active', !!data.selectorMode);
  $('#menu').toggleClass('selector-route-mobile-active', mobileSelectorMode);
  $('#menu').attr('data-selector-title', data.selectorMode ? (data.title || '') : '');
  $('#menu').attr('data-selector-kind', data.selectorMode ? (data.selectorKind || '') : '');
  $('#menu').data('config', data);
  var root = data.root;
  $('#menu').data('root', root);
  updateConsoleBackButton(root, data);
  var parent = data.parent;
  var allEntries = groupConsoleItems(data, root);
  $('#menu').data('menuEntries', allEntries);
  if (allEntries.length == 0) {
    alert('No items to load, please add some games');
    return '';
  };
  var filteredEntries = allEntries.slice();
  var items_length = filteredEntries.length - 1;
  // Determine counts and style based on menu items
  var display_items = data.display_items;
  if (typeof active_item == 'undefined'){
    var active_item = Math.floor(display_items/2);
  };
  var mappedActive = filteredEntries.findIndex(function(entry) {
    return Number(entry.originalIndex) === Number(active_item);
  });
  if (mappedActive >= 0) {
    active_item = mappedActive;
  }
  var image_height = Math.floor(100/display_items).toString() + 'vh';
  var visible_items = display_items;
  // Render zoom effect on active item
  function highlight(active_item) {
    if (portrait !== 0) {
      $('#h' + active_item).addClass('grow')
    } else {
      $('#h' + active_item).addClass('grow-mobile')
    };
    syncMenuControllerSelection();
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
  var filteredNames = filteredEntries.map(function(entry) { return entry.displayName; });
  function renderConsoleFilterState(totalCount, filteredCount, query) {
    var showFilter = !data.selectorMode && root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name));
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
  function buildMenuEntry(entry, count) {
    var item = entry.representative.resolved;
    var name = entry.representative.name;
    var displayName = entry.displayName || name;
    var selectorSubtitle = item.selector_subtitle || entry.selectorSubtitle || '';
    var selectorDetails = item.selector_details || entry.selectorDetails || '';
    var variantTooltip = variantTooltipText(entry.representative);
    var launchTooltip = variantTooltip;
    if (entry.variantCount > 1) {
      launchTooltip = (launchTooltip ? launchTooltip + '\n' : '') + 'Multiple versions are grouped here. Open this game to choose a specific version.';
    }
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
      var logo_html = '<img class="menu-img" alt="'+ displayName +'" title="'+ displayName +'">';
    } else if (selectorSubtitle || selectorDetails) {
      var logo_html = '<div class="menu-text"><p class="menu-img">' + escapeHtml(displayName) + '</p><p class="menu-subtitle">' + escapeHtml(selectorSubtitle) + '</p>' + (selectorDetails ? '<p class="menu-detail">' + escapeHtml(selectorDetails) + '</p>' : '') + '</div>';
    } else {
      var logo_html = '<p class="menu-img">' + escapeHtml(displayName) + '</p>';
    };
    // Set varibles to default if not set in item
    var jsdata = '';
    jsdata += 'data-name="' + escapeHtml(romName) + '" ';
    jsdata += 'data-display-name="' + escapeHtml(displayName) + '" ';
    jsdata += 'data-group-display-name="' + escapeHtml(displayName) + '" ';
    jsdata += 'data-menu-index="' + count + '" ';
    jsdata += 'data-variant-count="' + (entry.variantCount || 1) + '" ';
    for (var key of defaultKeys) {
      if (item.hasOwnProperty(key)) {
        jsdata += 'data-' + key + '="' + item[key] + '" ';
      } else {
        jsdata += 'data-' + key + '="' + data.defaults[key] + '" ';
      };
    };
    ['selector_action', 'selector_save_id', 'selector_favorite_id', 'selector_favorite_name', 'selector_favorite_exact_name', 'selector_favorite_root', 'selector_favorite_title', 'selector_favorite_index', 'selector_rom_path', 'selector_rom_name', 'selector_rom_extension'].forEach(function(extraKey) {
      if (item.hasOwnProperty(extraKey)) {
        jsdata += 'data-' + extraKey + '="' + escapeHtml(item[extraKey]) + '" ';
      }
    });
    if (item.hasOwnProperty('variant_choice')) {
      jsdata += 'data-variant-choice="' + escapeHtml(item.variant_choice) + '" ';
    }
    var itemType = item.hasOwnProperty('type') ? item.type : data.defaults.type;
    var itemPath = item.hasOwnProperty('path') ? item.path : data.defaults.path;
    var itemTitle = data.title || itemPath || 'Games';
    if (item.hasOwnProperty('selector_favorite_id')) {
      jsdata += 'data-favorite-id="' + escapeHtml(item.selector_favorite_id) + '" ';
      jsdata += 'data-favorite-name="' + escapeHtml(item.selector_favorite_name || displayName) + '" ';
      jsdata += 'data-favorite-exact-name="' + escapeHtml(item.selector_favorite_exact_name || name) + '" ';
      jsdata += 'data-favorite-root="' + escapeHtml(item.selector_favorite_root || root) + '" ';
      jsdata += 'data-favorite-title="' + escapeHtml(item.selector_favorite_title || itemTitle) + '" ';
      jsdata += 'data-favorite-index="' + escapeHtml(item.selector_favorite_index || entry.originalIndex || 0) + '" ';
    }
    var favoriteName = cleanGameName(displayName, itemPath + '::' + displayName);
    var favoriteId = entry.id || (itemPath + '::' + romName);
    var saveBase = saveBasename(romName + (item.hasOwnProperty('rom_extension') ? item.rom_extension : data.defaults.rom_extension || ''));
      var favoriteButton = '';
      var saveButton = '';
      var romDownloadButton = '';
      var showSelectorButtons = !data.selectorMode || data.selectorKind === 'variant';
      var showSaveButton = !data.selectorMode;
      var showDownloadButton = !data.selectorMode || (data.selectorKind === 'variant' && data.selectorVariantMode !== 'favorite');
      var showFavoriteButton = !data.selectorMode || (data.selectorKind === 'variant' && data.selectorVariantMode !== 'download');
      if (itemType == 'game') {
        if (showSaveButton) {
          saveButton = '<button class="save-toggle hidden" type="button" data-save-base="' + escapeHtml(saveBase) + '" data-save-name="' + escapeHtml(favoriteName) + '" onclick="openGameSaves(event, this.getAttribute(\'data-save-name\'), this.getAttribute(\'data-save-base\'))" aria-label="Download saves" title="No local saves found">&#128190;</button>';
        }
        if (showDownloadButton && showSelectorButtons) {
          romDownloadButton = '<button class="rom-download-toggle" type="button" data-menu-index="' + count + '" data-variant-count="' + (entry.variantCount || 1) + '" data-rom-path="' + escapeHtml(itemPath) + '" data-rom-name="' + escapeHtml(romName) + '" data-rom-extension="' + escapeHtml(item.hasOwnProperty('rom_extension') ? item.rom_extension : data.defaults.rom_extension || '') + '" onclick="handleRomDownload(event, this)" aria-label="Download ROM" title="Download ROM">&#10515;</button>';
        }
        if (showFavoriteButton && showSelectorButtons) {
          favoriteButton = '<button class="favorite-toggle" type="button" data-menu-index="' + count + '" data-favorite-id="' + escapeHtml(favoriteId) + '" data-favorite-name="' + escapeHtml(favoriteName) + '" data-favorite-exact-name="' + escapeHtml(romName) + '" data-favorite-root="' + escapeHtml(root) + '" data-favorite-title="' + escapeHtml(itemTitle) + '" data-favorite-index="' + entry.originalIndex + '" data-favorite-variant-count="' + (entry.variantCount || 1) + '" onclick="toggleFavorite(event, this.getAttribute(\'data-favorite-id\'), this)" aria-label="Toggle favorite" title="Add to favorites">&hearts;</button>';
        }
      } else if (itemType == 'selector-save' && item.hasOwnProperty('selector_save_id')) {
        saveButton = '<button class="save-toggle has-saves selector-save-download" type="button" data-selector-save-id="' + escapeHtml(item.selector_save_id) + '" onclick="downloadSelectorSave(event, this)" aria-label="Download save file" title="Download save file">&#10515;</button>';
      }
      return '\
        <div id="m' + count + '">\
          <div id="h' + count + '" class="menu-wrap ' + shrink + '">\
            <a onclick="launch(this)" id="i' + count + '" title="' + escapeHtml(launchTooltip || displayName) + '" data-original-index="' + escapeHtml(item.selector_original_index || entry.originalIndex) + '" ' + jsdata + '>\
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
        if (data.selectorMode && (itemIndex < 0 || itemIndex > items_length)) {
          $('#games-list').append('<div class="selector-spacer" aria-hidden="true"></div>');
          continue;
        }
        if (items_length >= 0) {
          itemIndex = ((itemIndex % (items_length + 1)) + (items_length + 1)) % (items_length + 1);
        }
        if (itemIndex >= 0 && itemIndex <= items_length && filteredNames[itemIndex] && !rendered[itemIndex]) {
          rendered[itemIndex] = true;
          $('#games-list').append(buildMenuEntry(filteredEntries[itemIndex], itemIndex));
      }
    }
    if (data.selectorMode) {
      $('#games-list').scrollTop(0);
    }
    refreshFavoriteButtons();
    refreshSaveIndicators();
    $('.menu-img').css({'max-height': image_height});
    if (portrait !== 0) {
      $('.menu-img').css({'max-width': '30vw'});
    } else {
      $('.menu-img').css({'max-width': '90vw'});
    }
    if (data.selectorMode) {
      $('#games-list > div').css({'min-height': image_height});
    }
    syncMenuControllerSelection();
  }
  function renderMenuItems(nextActiveItem) {
    var showFilter = root !== 'main' && !(data.hasOwnProperty('multi_name') && hasUsableValue(data.multi_name));
    var query = showFilter ? ($('#console-list-search').val() || '').toLowerCase().trim() : '';
    filteredEntries = allEntries.filter(function(entry) {
      return !query || (entry.searchText || entry.displayName.toLowerCase()).indexOf(query) !== -1;
    });
    $('#menu').data('menuEntries', filteredEntries);
    filteredNames = filteredEntries.map(function(entry) { return entry.displayName; });
    items_length = filteredEntries.length - 1;
    visible_items = Math.min(display_items, filteredEntries.length);
    jumpIndex = {};
    $('#games-list').empty();
    $('#active-list').empty();
    renderConsoleFilterState(allEntries.length, filteredEntries.length, query);
    if (filteredEntries.length === 0) {
      active_item = 0;
      menuActionIndex = 0;
      clearControllerSelectionClasses();
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
    currentMenuActiveItem = active_item;
    var count = 0;
    for (var entry of filteredEntries) {
      // Generate an index table based on alphabetical order ignoring numbers
      var name = entry.displayName || entry.name;
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
    if (!data.selectorMode) {
      for (var active_num of [...Array(visible_items).keys()]) {
        $('#active-list').append('<div id="active' + active_num + '" class="menu-div"></div>');
      }
    }
    renderVisibleEntries();
    // Render initial
    if (portrait !== 0) {
      $('.menu-img').css({'max-width': '30vw'});
      $('#active-list').css({'width': '40vw'});
      if (!data.selectorMode) {
        loadart(active_item);
        loadvideo(active_item);
      }
    } else {
      if (mobileSelectorMode) {
        $('.menu-img').css({'max-width': '100%'});
        $('#games-list').css({'width': 'calc(100vw - 16px)'});
      } else if (data.selectorMode) {
        $('.menu-img').css({'max-width': '100%'});
        $('#games-list').css({'width': 'min(46vw, 550px)'});
      } else {
        $('.menu-img').css({'max-width': '90vw'});
        $('#active-list').css({'width': '100vw'});
      }
    }
    var logo_load_start = active_item - Math.floor(visible_items/2);
    if (!data.selectorMode) {
      loadlogos(logo_load_start, visible_items, items_length, active_item);
      $('.menu-div').css({'height': image_height});
    }
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
    if (data.selectorMode) {
      active_item = Math.max(0, active_item);
    } else if (active_item < 0) {
      active_item = items_length;
    }
    currentMenuActiveItem = active_item;
    var logo_load_start = active_item - Math.floor(visible_items/2);
    renderVisibleEntries();
    if (!data.selectorMode) {
      loadlogos(logo_load_start, visible_items, items_length, active_item);
    }
    // Background art and video
    if (portrait !== 0) {
      if (!data.selectorMode) {
        loadart(active_item);
        loadvideo(active_item);
      }
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
    if (data.selectorMode) {
      active_item = Math.min(items_length, active_item);
    } else if (active_item > items_length) {
      active_item = 0;
    }
    currentMenuActiveItem = active_item;
    var logo_load_start = active_item - Math.floor(visible_items/2);
    renderVisibleEntries();
    if (!data.selectorMode) {
      loadlogos(logo_load_start, visible_items, items_length, active_item);
    }
    // Background art and video
    if (portrait !== 0) {
      if (!data.selectorMode) {
        loadart(active_item);
        loadvideo(active_item);
      }
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
    if (handleActiveFrontPanelKeydown(event)) {
      event.stopPropagation();
      return;
    }
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
    if ((event.key == 'ArrowRight') && ((upPressed == false) && (downPressed == false))) {
      moveMenuHorizontal(1);
      return;
    }
    if ((event.key == 'ArrowLeft') && ((upPressed == false) && (downPressed == false))) {
      moveMenuHorizontal(-1);
      return;
    }
    // Load item
    if ((event.key == 'Enter') && ((upPressed == false) && (downPressed == false))) {
      activateCurrentMenuControl();
    }
    // Go to Parent
    if (event.key == 'Escape' || event.key == 'Backspace') {
      if (selectorMenuStack.length) {
        closeSelectorMenu();
      } else {
        window.location.href = '#' + parent;
      }
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
    if (data.selectorMode) {
      return;
    }
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
  var hammerTarget = (mobileSelectorMode && data.selectorMode) ? document.getElementById('games-list') : document.getElementById('menu');
  var mc = new Hammer(hammerTarget);
  mc.get('swipe').set({ direction: Hammer.DIRECTION_ALL });
  mc.get('pan').set({ direction: Hammer.DIRECTION_ALL, threshold: 180 });
  mc.on("swipeup", function(ev) {
    if (getActiveFrontPanel()) {
      return;
    }
    moveDown(ev);
  });
  mc.on("swipedown", function(ev) {
    if (getActiveFrontPanel()) {
      return;
    }
    moveUp(ev);
  });
  mc.on("panstart", function(ev) {
    if (getActiveFrontPanel()) {
      return;
    }
    scroll(ev);
  });
  mc.on("panend", killScroll);
  // Render menu on orientation change
  $(window).on('orientationchange',function(){
    window.location.href = '#' + root + '---' + active_item;
    window.location.reload();
  });
  //// Mouse Scrolling ////
  $('#menu').bind('DOMMouseScroll', function(e){
    if (getActiveFrontPanel()) {
      return false;
    }
    if(e.originalEvent.detail > 0) {
      moveDown();
    } else {
      moveUp();
    };
    return false;
  });
  $('#menu').bind('mousewheel', function(e){
    if (getActiveFrontPanel()) {
      return false;
    }
    if(e.originalEvent.wheelDelta < 0) {
      moveDown();
    } else {
      moveUp();
    };
    return false;
  });
  $(document).off('.frontpaneltrap');
  $(document).on('wheel.frontpaneltrap mousewheel.frontpaneltrap DOMMouseScroll.frontpaneltrap touchstart.frontpaneltrap touchmove.frontpaneltrap pointerdown.frontpaneltrap pointermove.frontpaneltrap', '.search-panel, .favorites-panel, .save-panel, .variant-panel, .login-panel', function(event) {
    event.stopPropagation();
  });
  $(document).off('keydown.frontpanelnav');
  $(document).on('keydown.frontpanelnav', '.search-panel, .favorites-panel, .save-panel, .variant-panel, .login-panel, .search-panel button, .favorites-panel button, .save-panel button, .variant-panel button, .login-panel button', function(event) {
    if (handleActiveFrontPanelKeydown(event)) {
      event.stopPropagation();
      return false;
    }
  });
  $(document).off('focusin.frontpanelnav');
  $(document).on('focusin.frontpanelnav', '.search-panel button, .favorites-panel button, .save-panel button, .variant-panel button, .login-panel button', function() {
    updateFrontPanelNavFromElement(this);
  });
  //// GamePad controls ////
  let scrollDelay
  let animReq
  let homeTimer;
  let home = 0;
  let homePressed = false;
  let gpUpdate;
  function isAndroidHatController(gp) {
    return !!(gp && gp.id && gp.id.indexOf('Bluetooth Wireless Controller') !== -1 && gp.axes && gp.axes.length >= 10);
  }
  function applyAndroidHatDirection(gp, direction) {
    if (!isAndroidHatController(gp)) {
      return direction;
    }
    var hat = typeof gp.axes[9] === 'number' ? gp.axes[9] : null;
    if (hat === null) {
      return direction;
    }
    if (hat < -0.75) {
      direction.vertical = -1;
      direction.horizontal = 0;
    } else if (hat > -0.1 && hat < 0.35) {
      direction.vertical = 1;
      direction.horizontal = 0;
    } else if (hat > 0.45 && hat < 0.95) {
      direction.horizontal = -1;
      direction.vertical = 0;
    } else if (hat > -0.65 && hat < -0.2) {
      direction.horizontal = 1;
      direction.vertical = 0;
    }
    return direction;
  }
  function readMenuDirection(gp) {
    var direction = {vertical: 0, horizontal: 0};
    var axisY = typeof gp.axes[1] === 'number' ? gp.axes[1] : 0;
    var axisX = typeof gp.axes[0] === 'number' ? gp.axes[0] : 0;
    if (axisY > .5) {
      direction.vertical = 1;
    } else if (axisY < -.5) {
      direction.vertical = -1;
    }
    if (axisX > .5) {
      direction.horizontal = 1;
    } else if (axisX < -.5) {
      direction.horizontal = -1;
    }
    if (gp.buttons[13] && gp.buttons[13].pressed) {
      direction.vertical = 1;
    } else if (gp.buttons[12] && gp.buttons[12].pressed) {
      direction.vertical = -1;
    }
    if (gp.buttons[15] && gp.buttons[15].pressed) {
      direction.horizontal = 1;
    } else if (gp.buttons[14] && gp.buttons[14].pressed) {
      direction.horizontal = -1;
    }
    return applyAndroidHatDirection(gp, direction);
  }
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
    var direction = readMenuDirection(gp);
    if (window.location.hash != "#game") {
      gameStarted = false;
      var activePanel = getActiveFrontPanel();
      if (activePanel) {
        if (frontPanelNavState.selector !== activePanel || !$(activePanel).find('.controller-selected').length) {
          focusFrontPanel(activePanel);
        }
        if (!scrollDelay) {
          if (direction.vertical > 0) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
            moveFrontPanelFocus(1);
          } else if (direction.vertical < 0) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
            moveFrontPanelFocus(-1);
          } else if (direction.horizontal > 0) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
            moveFrontPanelHorizontal(1);
          } else if (direction.horizontal < 0) {
            scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
            moveFrontPanelHorizontal(-1);
          }
        }
        if (gp.timestamp == gpUpdate) {
          animReq = requestAnimationFrame(gameLoop);
          return;
        }
        gpUpdate = gp.timestamp;
        if (gp.buttons[0].pressed) {
          activateFrontPanelControl();
          animReq = requestAnimationFrame(gameLoop);
          return;
        } else if (gp.buttons[1].pressed) {
          handleFrontPanelBack();
          animReq = requestAnimationFrame(gameLoop);
          return;
        }
        animReq = requestAnimationFrame(gameLoop);
        return;
      }
      if (!scrollDelay) {
        // Analog down
        if (direction.vertical > 0) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 200);
          moveDown();
        // Analog up
        } else if (direction.vertical < 0) {
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
        } else if (direction.horizontal > 0) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
          moveMenuHorizontal(1);
        } else if (direction.horizontal < 0) {
          scrollDelay = setTimeout(() => scrollDelay = undefined, 180);
          moveMenuHorizontal(-1);
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
        activateCurrentMenuControl();
        return;
      } else if (gp.buttons[1].pressed && parent && '#' + parent != window.location.hash) {
        if (selectorMenuStack.length) {
          closeSelectorMenu();
        } else {
          window.location.href = '#' + parent;
        }
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
          if (selectorMenuStack.length) {
            closeSelectorMenu();
          } else {
            window.location.href = '#' + parent;
          }
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
    getGamepadsList().forEach(function(gp) {
      dispatchGamepadConnected(gp);
    });
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

window.onload = async function() {
  updateLoginState();
  await loadPublicSettings();
  loadSelectorStackState();
  loadPendingLaunchSelection();
  $('#game-search').on('input', debounce(runGameSearch, 150));
  $('#console-filter').on('change', runGameSearch);
  $('#art-filter').on('change', runGameSearch);
  $('#favorites-filter').on('change', runGameSearch);
  if (!isLoginGateActive()) {
    var selectorRouteState = loadSelectorRouteState();
    var restoreState = loadMenuRestoreState();
    if (isSelectorRoute(window.location.hash) && selectorRouteState && selectorRouteState.route === window.location.hash && selectorRouteState.config) {
      clearMenuRestoreState();
      applySelectorVisualState();
      rendermenu([selectorRouteState.config, selectorRouteState.activeItem || 0]);
    } else if (restoreState && restoreState.config) {
      clearMenuRestoreState();
      restoreMenuState(restoreState);
    } else if (! window.location.hash) {
      loadjson('main');
    } else {
      var hash = window.location.hash.replace('#','');
      var name = hash.split('---')[0];
      let active_item = hash.split('---')[1];
      loadjson(name, active_item);
    }
  } else {
    silenceBackgroundMedia(true);
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

window.handleRomDownload = handleRomDownload;
