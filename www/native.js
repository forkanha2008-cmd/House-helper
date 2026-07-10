/**
 * native.js — Capacitor plugin wrappers for House Helper
 * Loaded only when running inside the Android app.
 * Falls back gracefully to web behaviour on browser.
 */

// ── ENVIRONMENT DETECTION ──────────────────────────────────
const IS_NATIVE = window.Capacitor?.isNativePlatform?.() || false;
const IS_ANDROID = IS_NATIVE && window.Capacitor?.getPlatform?.() === 'android';

// ── HAPTIC FEEDBACK ────────────────────────────────────────
const Haptics = {
  async light() {
    if (!IS_NATIVE) return;
    try { await window.Capacitor.Plugins.Haptics.impact({ style: 'LIGHT' }); } catch(e) {}
  },
  async medium() {
    if (!IS_NATIVE) return;
    try { await window.Capacitor.Plugins.Haptics.impact({ style: 'MEDIUM' }); } catch(e) {}
  },
  async success() {
    if (!IS_NATIVE) return;
    try { await window.Capacitor.Plugins.Haptics.notification({ type: 'SUCCESS' }); } catch(e) {}
  },
  async error() {
    if (!IS_NATIVE) return;
    try { await window.Capacitor.Plugins.Haptics.notification({ type: 'ERROR' }); } catch(e) {}
  }
};

// ── STATUS BAR ─────────────────────────────────────────────
const StatusBar = {
  async setDark() {
    if (!IS_NATIVE) return;
    try {
      await window.Capacitor.Plugins.StatusBar.setStyle({ style: 'DARK' });
      await window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#0F172A' });
    } catch(e) {}
  },
  async setLight() {
    if (!IS_NATIVE) return;
    try {
      await window.Capacitor.Plugins.StatusBar.setStyle({ style: 'LIGHT' });
      await window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#FFFFFF' });
    } catch(e) {}
  },
  async setGreen() {
    if (!IS_NATIVE) return;
    try {
      await window.Capacitor.Plugins.StatusBar.setStyle({ style: 'DARK' });
      await window.Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#0F8C3D' });
    } catch(e) {}
  }
};

// ── BACK BUTTON (Android hardware back) ────────────────────
function initBackButton() {
  if (!IS_NATIVE) return;
  window.Capacitor.Plugins.App.addListener('backButton', ({ canGoBack }) => {
    // If a modal is open, close it
    const modal = document.querySelector('.modal-overlay:not([style*="display: none"])') ||
                  document.getElementById('active-modal');
    if (modal) {
      // Close modal
      if (modal.id === 'active-modal') { modal.remove(); }
      else { modal.style.display = 'none'; }
      Haptics.light();
      return;
    }
    // If on a detail/sub screen, go back
    if (window.S && window.S.currentScreen && window.S.currentScreen !== 'home' && window.S.currentScreen !== 'login') {
      if (typeof goBack === 'function') goBack();
      Haptics.light();
      return;
    }
    // If on home, show exit confirmation
    if (window.S?.currentScreen === 'home') {
      showNativeConfirm('Exit App', 'Are you sure you want to exit?', () => {
        window.Capacitor.Plugins.App.exitApp();
      });
      return;
    }
  });
}

// ── NATIVE CONFIRM DIALOG ──────────────────────────────────
function showNativeConfirm(title, message, onConfirm) {
  // Use a nicer in-app bottom sheet instead of JS confirm()
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-end;animation:fadeIn .2s ease';
  sheet.innerHTML = `
    <div style="background:white;width:100%;border-radius:20px 20px 0 0;padding:24px 20px;animation:slideUp .25s ease">
      <div style="width:40px;height:4px;background:#E2E8F0;border-radius:99px;margin:0 auto 20px"></div>
      <h3 style="font-size:17px;font-weight:700;margin-bottom:8px;text-align:center">${title}</h3>
      <p style="font-size:14px;color:#64748B;text-align:center;margin-bottom:24px">${message}</p>
      <button onclick="this.closest('div[style]').remove();(${onConfirm.toString()})()" 
        style="width:100%;padding:14px;background:#EF4444;color:white;border:none;border-radius:12px;font-size:15px;font-weight:700;margin-bottom:10px;cursor:pointer">
        Exit
      </button>
      <button onclick="this.closest('div[style]').remove()"
        style="width:100%;padding:14px;background:#F1F5F9;color:#0F172A;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer">
        Cancel
      </button>
    </div>`;
  document.body.appendChild(sheet);
}

// ── NATIVE CAMERA / PHOTO PICKER ──────────────────────────
const NativeCamera = {
  /**
   * Pick image from gallery OR camera.
   * Returns a base64 data URL string, or null if cancelled.
   */
  async pick(source = 'PHOTOS') {
    if (!IS_NATIVE) return null; // caller falls back to <input type=file>

    try {
      const result = await window.Capacitor.Plugins.Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: 'base64',
        source: source, // 'CAMERA' | 'PHOTOS' | 'PROMPT'
        width: 1280,
        height: 1280,
        correctOrientation: true,
        saveToGallery: false,
      });

      if (!result?.base64String) return null;

      // Convert base64 to a proper data URL
      const mimeType = result.format === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mimeType};base64,${result.base64String}`;
    } catch (e) {
      if (e?.message?.includes('cancel') || e?.message?.includes('No image')) return null;
      console.warn('[NativeCamera] pick failed', e);
      return null;
    }
  },

  /** Convert data URL to a File object for upload */
  dataUrlToFile(dataUrl, filename = 'photo.jpg') {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  }
};

// ── PULL TO REFRESH ────────────────────────────────────────
function initPullToRefresh(contentEl, onRefresh) {
  if (!contentEl) return;
  let startY = 0, pulling = false, indicator = null;

  contentEl.addEventListener('touchstart', e => {
    if (contentEl.scrollTop === 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  contentEl.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 10 && contentEl.scrollTop === 0) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.style.cssText = 'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:center;padding:12px;pointer-events:none;z-index:100;transition:opacity .2s';
        indicator.innerHTML = '<div style="width:24px;height:24px;border:2.5px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .7s linear infinite"></div>';
        contentEl.style.position = 'relative';
        contentEl.insertBefore(indicator, contentEl.firstChild);
      }
      indicator.style.opacity = Math.min(dy / 80, 1);
    }
  }, { passive: true });

  contentEl.addEventListener('touchend', async () => {
    if (!pulling || !indicator) { pulling = false; return; }
    const wasVisible = parseFloat(indicator.style.opacity) > 0.8;
    indicator.remove(); indicator = null; pulling = false;
    if (wasVisible) {
      Haptics.light();
      await onRefresh();
    }
  });
}

// ── NETWORK AWARENESS ─────────────────────────────────────
let _isOnline = true;
async function initNetworkListener() {
  if (!IS_NATIVE) {
    _isOnline = navigator.onLine;
    window.addEventListener('online', () => { _isOnline = true; hideOfflineBanner(); });
    window.addEventListener('offline', () => { _isOnline = false; showOfflineBanner(); });
    return;
  }
  try {
    const { connected } = await window.Capacitor.Plugins.Network.getStatus();
    _isOnline = connected;
    window.Capacitor.Plugins.Network.addListener('networkStatusChange', ({ connected }) => {
      _isOnline = connected;
      connected ? hideOfflineBanner() : showOfflineBanner();
    });
  } catch(e) {}
}

function showOfflineBanner() {
  if (document.getElementById('offline-banner')) return;
  const b = document.createElement('div');
  b.id = 'offline-banner';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#0F172A;color:white;text-align:center;padding:10px 16px;font-size:13px;font-weight:600;z-index:9998;animation:slideDown .25s ease';
  b.textContent = '📡 No internet connection';
  document.body.prepend(b);
}
function hideOfflineBanner() {
  document.getElementById('offline-banner')?.remove();
}

// ── SHARE ─────────────────────────────────────────────────
async function nativeShare(title, text, url) {
  if (IS_NATIVE) {
    try {
      await window.Capacitor.Plugins.Share.share({ title, text, url, dialogTitle: 'Share House Helper' });
      return;
    } catch(e) {}
  }
  // Web fallback
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch(e) {}
  }
  navigator.clipboard?.writeText(url).then(() => { if (typeof toast === 'function') toast('Link copied ✓'); });
}

// ── SPLASH SCREEN ─────────────────────────────────────────
async function hideSplash() {
  if (!IS_NATIVE) return;
  try { await window.Capacitor.Plugins.SplashScreen.hide({ fadeOutDuration: 400 }); } catch(e) {}
}

// ── KEYBOARD HANDLING ─────────────────────────────────────
function initKeyboardHandling() {
  if (!IS_NATIVE) return;
  try {
    window.Capacitor.Plugins.Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => {
      document.documentElement.style.setProperty('--keyboard-height', keyboardHeight + 'px');
      document.body.classList.add('keyboard-open');
    });
    window.Capacitor.Plugins.Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
      document.body.classList.remove('keyboard-open');
    });
  } catch(e) {}
}

// ── SAFE AREA ─────────────────────────────────────────────
function applySafeArea() {
  // CSS env() variables handle this natively, but we set fallbacks
  document.documentElement.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
  document.documentElement.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
  document.documentElement.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');
  document.documentElement.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
}

// ── PAGE TRANSITIONS ──────────────────────────────────────
function initPageTransitions() {
  // Override showScreen to add native-feeling slide transitions
  const origShowScreen = window.showScreen;
  if (!origShowScreen) return;

  window.showScreen = function(id) {
    const current = document.querySelector('.screen.active');
    const next = document.getElementById('screen-' + id);
    if (!next || next === current) { origShowScreen(id); return; }

    // Determine direction
    const isBack = window.S?.history?.length > 0 &&
                   window.S.history[window.S.history.length - 1] === id;

    next.style.cssText = `transform:translateX(${isBack ? '-30%' : '100%'});opacity:${isBack ? '.7' : '1'}`;
    next.classList.add('active');
    origShowScreen(id);

    requestAnimationFrame(() => {
      if (current) current.style.cssText = `transform:translateX(${isBack ? '100%' : '-30%'});opacity:${isBack ? '1' : '.7'};transition:transform .28s cubic-bezier(.4,0,.2,1),opacity .28s;pointer-events:none`;
      next.style.cssText = 'transform:translateX(0);opacity:1;transition:transform .28s cubic-bezier(.4,0,.2,1),opacity .28s';
      setTimeout(() => {
        if (current) current.style.cssText = '';
        next.style.cssText = '';
      }, 300);
    });
  };
}

// ── INIT ALL NATIVE FEATURES ──────────────────────────────
async function initNative() {
  applySafeArea();
  await initNetworkListener();
  initBackButton();
  initKeyboardHandling();

  // Only enhance transitions on native (feels wrong on desktop browser)
  if (IS_NATIVE) initPageTransitions();

  // Hide splash after app loads
  setTimeout(hideSplash, IS_NATIVE ? 800 : 0);

  console.log(`[native.js] platform=${IS_ANDROID ? 'android' : IS_NATIVE ? 'native' : 'web'}`);
}
