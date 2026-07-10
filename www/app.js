// app.js - House Helper PWA v2
// All 12 improvements included

// ── SUPABASE ──────────────────────────────────────────────────
const SUPABASE_URL = 'https://zvuhsxqwhitjhndlnujv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3uTlDh-VxEVXUptPKj-uGQ_x3wOPQaE';
let sb = null;
try {
  if (!SUPABASE_ANON_KEY.includes('YOUR_')) {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch(e) {}

// ── BRAND LOGO (animated mark by default, admin can override with image) ─
let S_LOGO_URL = null; // set from app_settings.logo_url once loaded

function brandLogoSVG(px, light) {
  const houseStroke = light ? '#142850' : '#142850';
  const swooshColor  = '#16A34A';
  const bg = light ? 'white' : 'transparent';
  return `<svg width="${px}" height="${px}" viewBox="0 0 48 48" style="background:${bg};border-radius:${Math.round(px*0.28)}px;flex-shrink:0" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 6 L42 20 L40 20 L40 38 L8 38 L8 20 L6 20 Z" fill="none" stroke="${houseStroke}" stroke-width="3" stroke-linejoin="round"/>
    <path class="logo-mark-swoosh" d="M13 29 Q24 40 35 29" fill="none" stroke="${swooshColor}" stroke-width="3" stroke-linecap="round"/>
    <circle class="logo-mark-dot" cx="24" cy="23" r="3.2" fill="${houseStroke}"/>
  </svg>`;
}

function brandLogoHTML(px, light) {
  if (S_LOGO_URL) {
    return `<img src="${S_LOGO_URL}" alt="House Helper" style="width:${px}px;height:${px}px;border-radius:${Math.round(px*0.28)}px;object-fit:cover;flex-shrink:0">`;
  }
  return brandLogoSVG(px, light);
}

function renderAllLogoSlots() {
  document.querySelectorAll('.logo-slot').forEach(el => {
    const px = parseInt(el.dataset.size || '32', 10);
    const light = el.dataset.light === '1';
    el.innerHTML = brandLogoHTML(px, light);
  });
}

async function loadBrandSettings() {
  if (!sb) { renderAllLogoSlots(); return; }
  try {
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'logo_url').maybeSingle();
    if (!error && data && data.value) S_LOGO_URL = data.value;
  } catch (e) {
    console.warn('[loadBrandSettings] could not load logo_url', e);
  }
  renderAllLogoSlots();
}

// ── SHARED IMAGE UPLOAD PIPELINE ────────────────────────────────
// Used by service images, category images, and the brand logo.
// Handles: type/size validation, client-side compression (so large
// phone photos don't blow past bucket limits), retry with backoff,
// clear error classification, cache-busted URLs, and cleanup of the
// previous image when replacing.

// ══════════════════════════════════════════════════════════════
// PRODUCTION IMAGE UPLOAD SYSTEM
// Works entirely within Supabase free plan limits.
// ══════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────
const IMG_MAX_RAW_MB   = 50;    // reject truly absurd files before trying
const IMG_BUCKET_MAX_MB = 4.5;  // stay safely under a 5 MB bucket limit
const IMG_MAX_DIM      = 1280;  // longest side after resize, px
const IMG_QUALITY      = 0.82;  // JPEG quality for first-pass compression
const IMG_QUALITY_LOW  = 0.55;  // fallback quality if first pass is still too big

// Accepted input types (HEIC covered by extension check for iOS)
const IMG_ACCEPT_TYPES = new Set([
  'image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'
]);

// ── Global image registry ────────────────────────────────────
// Maps a "slot key" (e.g. "service:uuid" or "category:uuid") to the
// current public URL.  Every <img> rendered for that slot reads from
// here, so a single call to ImageRegistry.update() refreshes every
// place the image appears — no page reload, no full re-render.
const ImageRegistry = {
  _map: {},            // key → url
  _listeners: {},      // key → Set<callback>

  get(key) { return this._map[key] || null; },

  update(key, url) {
    this._map[key] = url;
    // Push new URL to every subscribed <img> in the DOM instantly
    (this._listeners[key] || new Set()).forEach(fn => { try { fn(url); } catch(e){} });
    // Also update any <img data-img-key="key"> elements that aren't subscribed
    document.querySelectorAll(`[data-img-key="${key}"]`).forEach(el => {
      if (el.tagName === 'IMG') { el.src = url || el.dataset.fallback || ''; }
      else if (url) { el.style.backgroundImage = `url('${url}')`; }
    });
  },

  subscribe(key, fn) {
    if (!this._listeners[key]) this._listeners[key] = new Set();
    this._listeners[key].add(fn);
    return () => this._listeners[key].delete(fn); // returns unsubscribe fn
  },

  // Convenience: create an <img> string that's wired to this registry
  img(key, fallbackUrl, style='') {
    const current = this._map[key] || fallbackUrl || '';
    return `<img src="${current}" data-img-key="${key}" data-fallback="${fallbackUrl || ''}" style="${style}" onerror="this.src=this.dataset.fallback||''" loading="lazy">`;
  }
};

// ── File validation ───────────────────────────────────────────
function img_validate(file) {
  if (!file) return 'No file selected.';
  const byType = IMG_ACCEPT_TYPES.has(file.type);
  const byExt  = /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  if (!byType && !byExt) return 'Unsupported format. Please use JPG, PNG, WebP or HEIC.';
  if (file.size > IMG_MAX_RAW_MB * 1024 * 1024) {
    return `File is too large (${(file.size/1024/1024).toFixed(1)} MB). Maximum is ${IMG_MAX_RAW_MB} MB.`;
  }
  return null; // valid
}

// ── Canvas compression ────────────────────────────────────────
// Always outputs JPEG regardless of input — PNG ignores the quality param
// in canvas.toBlob which can produce files larger than the bucket limit.
function img_compress(file, maxDim = IMG_MAX_DIM, quality = IMG_QUALITY) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = image;

      // Resize to fit within maxDim while preserving aspect ratio
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width);  width  = maxDim; }
        else                 { width  = Math.round(width  * maxDim / height); height = maxDim; }
      }

      const canvas  = Object.assign(document.createElement('canvas'), { width, height });
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);

      const tryBlob = (q, cb) => canvas.toBlob(cb, 'image/jpeg', q);

      tryBlob(quality, blob => {
        if (!blob) { reject(new Error('Image compression produced no output. Try a different file.')); return; }

        if (blob.size <= IMG_BUCKET_MAX_MB * 1024 * 1024) {
          // First pass is small enough
          resolve(new File([blob], _jpgName(file.name), { type: 'image/jpeg' }));
        } else {
          // Still too large — try lower quality
          tryBlob(IMG_QUALITY_LOW, blob2 => {
            if (!blob2) { reject(new Error('Could not compress image enough. Try a smaller photo.')); return; }
            if (blob2.size > IMG_BUCKET_MAX_MB * 1024 * 1024) {
              // Even low quality is over limit — resize more aggressively
              const smallerDim = Math.round(maxDim * 0.65);
              img_compress(file, smallerDim, IMG_QUALITY_LOW).then(resolve).catch(reject);
            } else {
              resolve(new File([blob2], _jpgName(file.name), { type: 'image/jpeg' }));
            }
          });
        }
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read the image. The file may be corrupted or in an unsupported format.'));
    };

    image.src = objectUrl;
  });
}

function _jpgName(name) { return name.replace(/\.[^.]+$/, '') + '.jpg'; }

// ── Friendly error classifier ─────────────────────────────────
function img_classifyError(err) {
  const m = (err?.message || String(err) || '').toLowerCase();
  if (m.includes('row-level security') || m.includes('rls') || m.includes('permission denied')) {
    return { msg: 'Upload permission denied. Check your Supabase Storage bucket policies.', retryable: false };
  }
  if (m.includes('bucket') && m.includes('not found')) {
    return { msg: 'Storage bucket not found. Check the bucket name in Supabase.', retryable: false };
  }
  if (m.includes('payload too large') || m.includes('entity too large') || m.includes('exceeded')) {
    return { msg: 'The image is still too large after compression. Try a different photo.', retryable: false };
  }
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('timeout') || m.includes('abort')) {
    return { msg: 'Network error. Check your connection and try again.', retryable: true };
  }
  if (m.includes('jwt') || m.includes('unauthorized') || m.includes('401')) {
    return { msg: 'Session expired. Please reload the app.', retryable: false };
  }
  return { msg: err?.message || 'Upload failed. Please try again.', retryable: true };
}

// ── Storage path extraction ───────────────────────────────────
function img_storagePath(publicUrl, bucket) {
  if (!publicUrl || !bucket) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(publicUrl.slice(idx + marker.length).split('?')[0]);
}

// ── Progress bar helpers ──────────────────────────────────────
// Supabase JS SDK on the free plan doesn't expose upload progress events.
// We simulate a realistic progress bar: fast at first (compression is done),
// then slows near 90% to show the real upload is happening, jumps to 100%
// on success. This is the same pattern used by GitHub, Notion and Linear.
function img_progressBar(containerEl, pct) {
  let bar = containerEl.querySelector('.img-upload-bar');
  if (!bar) {
    containerEl.insertAdjacentHTML('beforeend',
      `<div class="img-upload-track"><div class="img-upload-bar" style="width:0%"></div></div>`);
    bar = containerEl.querySelector('.img-upload-bar');
  }
  bar.style.width = pct + '%';
  if (pct >= 100) {
    bar.style.background = 'var(--success)';
    setTimeout(() => { const t = bar.closest('.img-upload-track'); if (t) t.remove(); }, 900);
  }
}

// ── Core upload function ──────────────────────────────────────
/**
 * Compress, upload, cache-bust and optionally delete the previous image.
 * Returns the final public URL.
 *
 * @param {string}   bucket    Supabase bucket name
 * @param {string}   folder    Path prefix inside the bucket
 * @param {File}     file      Raw file from <input type="file">
 * @param {object}   opts
 * @param {string}   opts.oldUrl       Previous image URL to delete on success
 * @param {Function} opts.onProgress   Called with 0-100 integer
 * @param {Function} opts.onStatus     Called with status string for the UI label
 * @param {number}   opts.maxRetries   Network-error retries (default 3)
 */
async function img_upload(bucket, folder, file, opts = {}) {
  const { oldUrl = null, onProgress = () => {}, onStatus = () => {}, maxRetries = 3 } = opts;

  if (!sb) throw new Error('Supabase is not configured.');

  // 1. Validate
  const valErr = img_validate(file);
  if (valErr) throw new Error(valErr);

  // 2. Instant local preview via object URL (caller already set this before calling us)
  onProgress(5);
  onStatus('Optimising image…');

  // 3. Compress
  let compressed;
  try {
    compressed = await img_compress(file);
  } catch (e) {
    throw new Error(e.message || 'Could not process the image. Please try a different photo.');
  }

  const sizeMB = (compressed.size / 1024 / 1024).toFixed(2);
  onProgress(30);
  onStatus(`Uploading (${sizeMB} MB)…`);

  // 4. Build a unique path
  const uid  = window.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2));
  const path = `${folder}/${uid}.jpg`;

  // 5. Simulate progress while the real XHR is in-flight
  let simulatedPct = 30;
  const progressTimer = setInterval(() => {
    if (simulatedPct < 85) { simulatedPct += 3; onProgress(simulatedPct); }
  }, 250);

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { error: upErr } = await sb.storage.from(bucket).upload(path, compressed, {
        upsert: false,
        contentType: 'image/jpeg',
      });
      if (upErr) throw upErr;

      clearInterval(progressTimer);
      onProgress(95);

      // 6. Get the public URL and append a version token to bust browser cache
      const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
      const finalUrl = urlData.publicUrl + '?v=' + Date.now();

      // 7. Best-effort delete the old image (don't block or fail if this errors)
      if (oldUrl) {
        const oldPath = img_storagePath(oldUrl, bucket);
        if (oldPath && oldPath !== path) {
          sb.storage.from(bucket).remove([oldPath])
            .catch(e => console.warn('[img_upload] old image delete failed (non-fatal)', e));
        }
      }

      onProgress(100);
      onStatus('Uploaded ✓');
      return finalUrl;

    } catch (e) {
      lastErr = e;
      clearInterval(progressTimer);
      const { msg, retryable } = img_classifyError(e);

      if (!retryable || attempt === maxRetries) {
        onProgress(0);
        onStatus('');
        throw new Error(msg);
      }

      // Exponential backoff before next attempt
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      onStatus(`Connection issue. Retrying in ${Math.round(delay/1000)}s… (${attempt}/${maxRetries})`);
      onProgress(20);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(img_classifyError(lastErr).msg);
}

/** Delete an image from Supabase Storage by its public URL. Best-effort. */
async function img_delete(bucket, publicUrl) {
  if (!sb || !publicUrl) return;
  const path = img_storagePath(publicUrl, bucket);
  if (!path) return;
  try { await sb.storage.from(bucket).remove([path]); }
  catch (e) { console.warn('[img_delete] non-fatal', e); }
}

// ── Upload widget renderer ────────────────────────────────────
// Renders a self-contained upload card into `containerEl`.
// Handles: instant preview, progress bar, status text, disable-during-upload.
//
// opts.key        — ImageRegistry key (e.g. 'service:uuid')
// opts.bucket     — Supabase bucket
// opts.folder     — path prefix
// opts.currentUrl — existing image URL (may be null)
// opts.onDone(url) — called with the final URL when upload succeeds
// opts.onRemove() — called when user clicks Remove

function renderUploadWidget(containerEl, opts = {}) {
  const { key = '', bucket = 'service-images', folder = 'uploads',
          currentUrl = null, onDone = () => {}, onRemove = () => {} } = opts;

  let isUploading = false;
  let localPreviewUrl = null;

  const render = (url, uploading, status, pct) => {
    const displayUrl = url || localPreviewUrl;
    containerEl.innerHTML = `
      <div class="upload-widget">
        <div class="upload-dropzone ${uploading ? 'uploading' : ''}" id="uwDrop">
          ${displayUrl ? `
            <div class="upload-preview-wrap">
              <img src="${displayUrl}" class="upload-preview-img" alt="Preview"
                onerror="this.src=''" ${key ? `data-img-key="${key}"` : ''}>
              ${!uploading ? `<button class="upload-remove-btn" type="button" aria-label="Remove image">✕</button>` : ''}
            </div>` : `
            <div class="upload-placeholder">
              <div class="upload-icon">🖼️</div>
              <div class="upload-hint-main">Tap to upload photo</div>
              <div class="upload-hint-sub">JPG · PNG · WebP · HEIC — auto-optimised</div>
            </div>`}
        </div>
        ${uploading ? `
          <div class="upload-progress-wrap">
            <div class="upload-progress-bar" style="width:${pct||5}%"></div>
          </div>` : ''}
        <div class="upload-status ${status && status.includes('✓') ? 'success' : status ? 'active' : ''}">${status || ''}</div>
        <input type="file" class="upload-file-input" accept="image/*,.heic,.heif">
      </div>`;

    // Wire up click → input
    const drop  = containerEl.querySelector('.uwDrop, .upload-dropzone');
    const input = containerEl.querySelector('.upload-file-input');
    const rmBtn = containerEl.querySelector('.upload-remove-btn');

    if (drop && !uploading) drop.addEventListener('click', () => input.click());
    if (rmBtn) rmBtn.addEventListener('click', e => { e.stopPropagation(); onRemove(); render(null, false, '', 0); });
    if (input) input.addEventListener('change', () => onFileSelected(input.files[0]));
  };

  const onFileSelected = async (file) => {
    if (!file || isUploading) return;

    // Instant local preview — show immediately, before any network activity
    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    localPreviewUrl = URL.createObjectURL(file);
    isUploading = true;
    render(localPreviewUrl, true, 'Optimising image…', 5);

    let pct = 5;
    const onProgress = p => {
      pct = p;
      const bar = containerEl.querySelector('.upload-progress-bar');
      if (bar) bar.style.width = p + '%';
    };
    const onStatus = s => {
      const el = containerEl.querySelector('.upload-status');
      if (el) { el.textContent = s; el.className = 'upload-status active'; }
    };

    try {
      const url = await img_upload(bucket, folder, file, {
        oldUrl: currentUrl,
        onProgress,
        onStatus,
      });

      // Release local object URL — real URL is now available
      URL.revokeObjectURL(localPreviewUrl);
      localPreviewUrl = null;
      isUploading = false;

      // Update the global registry so every other place this image appears
      // refreshes automatically without a page reload
      if (key) ImageRegistry.update(key, url);

      render(url, false, 'Photo uploaded ✓', 100);
      onDone(url);

    } catch (e) {
      URL.revokeObjectURL(localPreviewUrl);
      localPreviewUrl = null;
      isUploading = false;
      render(currentUrl, false, '', 0);
      // Show the error in the status area, not a disruptive toast
      const statusEl = containerEl.querySelector('.upload-status');
      if (statusEl) {
        statusEl.textContent = '⚠ ' + (e.message || 'Upload failed. Please try again.');
        statusEl.className = 'upload-status error';
      }
    }
  };

  render(currentUrl, false, '', 0);
}

// Keep backward-compat shims so existing callers don't break
function validateImageFile(file)   { return img_validate(file); }
function extractStoragePath(u, b)  { return img_storagePath(u, b); }
async function uploadImageWithRetry(bucket, folder, file, opts = {}) {
  return img_upload(bucket, folder, file, {
    oldUrl:     opts.oldUrl,
    onStatus:   opts.onStatus,
    maxRetries: opts.maxRetries,
  });
}
async function deleteImageFromStorage(bucket, url) { return img_delete(bucket, url); }
function compressImageFile(f, d, q) { return img_compress(f, d, q); }

function validateImageFile(file) {
  if (!file) return 'No file selected';
  // Accept HEIC on iOS (will be converted to JPEG during compression)
  const acceptable = [...ALLOWED_IMAGE_TYPES, 'image/heic', 'image/heif'];
  if (!acceptable.includes(file.type) && !file.name.match(/\.(jpe?g|png|webp|heic|heif)$/i)) {
    return 'Unsupported file type — use JPG, PNG, WebP or HEIC';
  }
  if (file.size > MAX_RAW_FILE_MB * 1024 * 1024) {
    return `Image too large — max ${MAX_RAW_FILE_MB}MB`;
  }
  return null;
}

function compressImageFile(file, maxDim = COMPRESS_MAX_DIM, quality = COMPRESS_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;

      // Always resize if needed
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      // Always output JPEG — PNG ignores the quality param in toBlob, producing
      // large lossless files that blow past bucket limits even at 1280px.
      // JPEG at 0.82 quality is visually identical at these sizes and stays small.
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Compression produced empty output')); return; }

        const compressed = new File(
          [blob],
          file.name.replace(/\.[^.]+$/, '.jpg'),
          { type: 'image/jpeg' }
        );

        // Safety net: if the compressed file is still over the bucket limit,
        // re-compress at lower quality instead of failing silently.
        if (compressed.size > BUCKET_MAX_MB * 1024 * 1024) {
          canvas.toBlob(blob2 => {
            if (!blob2) { reject(new Error('Re-compression failed')); return; }
            resolve(new File([blob2], compressed.name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.55);
          return;
        }

        resolve(compressed);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image — the file may be corrupted or in an unsupported format'));
    };
    img.src = url;
  });
}

function classifyUploadError(err) {
  const msg = (err?.message || String(err) || '').toLowerCase();
  if (msg.includes('row-level security') || msg.includes('rls') || msg.includes('permission')) {
    return 'Permission denied — Storage RLS policy is blocking this upload. Check bucket policies in Supabase.';
  }
  if (msg.includes('not found') && msg.includes('bucket')) {
    return 'Storage bucket not found — check the bucket name exists in Supabase.';
  }
  if (msg.includes('payload too large') || msg.includes('exceeded') || msg.includes('size')) {
    return 'File too large for this bucket\'s size limit.';
  }
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('timeout')) {
    return 'Network error — check your connection.';
  }
  if (msg.includes('jwt') || msg.includes('auth') || msg.includes('unauthorized')) {
    return 'Authentication error with Supabase.';
  }
  return err?.message || 'Unknown upload error';
}

function extractStoragePath(publicUrl, bucket) {
  if (!publicUrl) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length).split('?')[0];
}

/**
 * Upload an image file to a Supabase Storage bucket with compression + retry.
 * @param {string} bucket - bucket name e.g. 'service-images'
 * @param {string} folder - path prefix e.g. 'services'
 * @param {File} file - raw file from <input type=file>
 * @param {object} opts - { oldUrl, onStatus, maxRetries }
 * @returns {Promise<string>} cache-busted public URL
 */
async function uploadImageWithRetry(bucket, folder, file, opts = {}) {
  const { oldUrl = null, onStatus = () => {}, maxRetries = 3 } = opts;
  if (!sb) throw new Error('Supabase is not configured');

  const validationError = validateImageFile(file);
  if (validationError) throw new Error(validationError);

  onStatus('Compressing image…');
  let toUpload;
  try {
    toUpload = await compressImageFile(file);
  } catch (e) {
    // Compression genuinely failed — surface the error clearly rather than
    // silently uploading the raw file (which would hit the bucket size limit).
    throw new Error('Could not compress image: ' + (e?.message || 'unknown error') + '. Try a different photo.');
  }

  const sizeMB = (toUpload.size / (1024 * 1024)).toFixed(2);
  const ext = (toUpload.name.split('.').pop() || 'jpg').toLowerCase();
  const uniqueId = (window.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));
  const path = `${folder}/${uniqueId}.${ext}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    onStatus(attempt === 1 ? `Uploading (${sizeMB}MB)…` : `Retrying upload (${attempt}/${maxRetries})…`);
    try {
      const { error: upErr } = await sb.storage.from(bucket).upload(path, toUpload, {
        upsert: false,
        contentType: toUpload.type,
      });
      if (upErr) throw upErr;

      const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
      const finalUrl = urlData.publicUrl + '?t=' + Date.now(); // cache-bust so it shows immediately

      // Best-effort cleanup of the old image — never block success on this
      if (oldUrl) {
        const oldPath = extractStoragePath(oldUrl, bucket);
        if (oldPath && oldPath !== path) {
          sb.storage.from(bucket).remove([oldPath]).catch(e =>
            console.warn('[uploadImageWithRetry] could not delete old image', e));
        }
      }

      onStatus('Done ✓');
      return finalUrl;
    } catch (e) {
      lastErr = e;
      console.error(`[uploadImageWithRetry] attempt ${attempt} failed`, e);
      const friendly = classifyUploadError(e);
      // Don't retry permission/RLS or validation-type errors — retrying won't help
      if (friendly.includes('Permission denied') || friendly.includes('bucket not found')) {
        onStatus('Failed: ' + friendly);
        throw new Error(friendly);
      }
      if (attempt < maxRetries) {
        onStatus(`Failed, retrying… (${friendly})`);
        await new Promise(r => setTimeout(r, attempt * 600)); // backoff: 600ms, 1200ms
      }
    }
  }
  onStatus('Failed: ' + classifyUploadError(lastErr));
  throw new Error(classifyUploadError(lastErr));
}

/** Best-effort delete of an image from storage by its public URL. */
async function deleteImageFromStorage(bucket, publicUrl) {
  if (!sb || !publicUrl) return;
  const path = extractStoragePath(publicUrl, bucket);
  if (!path) return;
  try {
    await sb.storage.from(bucket).remove([path]);
  } catch (e) {
    console.warn('[deleteImageFromStorage] failed', e);
  }
}

// ── STATE ─────────────────────────────────────────────────────
const S = {
  user: null,
  currentScreen: 'login',
  history: [],
  selectedService: null,
  bookingStep: 1,
  bookingPhotos: [],
  paymentMethod: 'pay_after',
  paymentScreenshot: null,
  promoDiscount: 0,
  promoCode: '',
  promoType: '',
  selectedTimeSlot: '',
  currentAdminBooking: null,
  selectedStatusUpdate: null,
  currentRatingBookingId: null,
  selectedRating: 0,
  versionTaps: 0,
  versionTimer: null,
  settings: {
    support_phone: '+91XXXXXXXXXX',
    support_whatsapp: '+91XXXXXXXXXX',
    upi_id: 'yourname@upi',
    upi_qr_url: '',
    admin_pin: '1234',
    business_name: 'House Helper',
  }
};

let BOOKINGS = [];
let SAVED_ADDRESSES = [];
let RATINGS = {};

// ── DATA ──────────────────────────────────────────────────────
let CATEGORIES = [
  {id:'c1',name:'House Cleaning', emoji:'🧹',bg:'#DCFCE7'},
  {id:'c2',name:'Deep Cleaning',  emoji:'🧽',bg:'#E0F2FE'},
  {id:'c3',name:'Electrician',    emoji:'⚡',bg:'#FEF9C3'},
  {id:'c4',name:'Plumber',        emoji:'💧',bg:'#DBEAFE'},
  {id:'c5',name:'Carpenter',      emoji:'🔨',bg:'#FEF3C7'},
  {id:'c6',name:'Painter',        emoji:'🖌️',bg:'#FEE2E2'},
  {id:'c7',name:'AC Repair',      emoji:'❄️',bg:'#E0F2FE'},
  {id:'c8',name:'Laundry',        emoji:'🧺',bg:'#F0FDF4'},
  {id:'c9',name:'Cook',           emoji:'👨‍🍳',bg:'#FFF7ED'},
  {id:'c10',name:'Babysitter',    emoji:'🍼',bg:'#FDF2F8'},
  {id:'c11',name:'Elder Care',    emoji:'🧓',bg:'#F3E8FF'},
  {id:'c12',name:'Pest Control',  emoji:'🐜',bg:'#F1F5F9'},
];

let SERVICES = [
  {id:'s1', catId:'c4',name:'Leaking Tap Repair',       desc:'Fix dripping or leaking taps and faucets.',       price:299, unit:'visit',featured:true},
  {id:'s2', catId:'c4',name:'Blocked Drain Cleaning',   desc:'Clear clogged sinks, basins and floor drains.',   price:499, unit:'visit',featured:false},
  {id:'s3', catId:'c4',name:'Water Tank Cleaning',      desc:'Clean overhead or underground water tanks.',      price:799, unit:'visit',featured:false},
  {id:'s4', catId:'c4',name:'Toilet Repair',            desc:'Fix flush, seat or internal tank issues.',        price:399, unit:'visit',featured:false},
  {id:'s5', catId:'c3',name:'Switch/Socket Repair',     desc:'Replace or repair faulty switches and sockets.',  price:249, unit:'visit',featured:true},
  {id:'s6', catId:'c3',name:'Fan Installation',         desc:'Install ceiling or exhaust fan safely.',          price:349, unit:'visit',featured:false},
  {id:'s7', catId:'c3',name:'MCB/Fuse Repair',          desc:'Fix tripped MCB or blown fuse issues.',           price:299, unit:'visit',featured:false},
  {id:'s8', catId:'c2',name:'Home Deep Cleaning',       desc:'Full home deep clean — all rooms.',               price:1499,unit:'visit',featured:true},
  {id:'s9', catId:'c1',name:'Bathroom Cleaning',        desc:'Deep clean bathroom tiles, pot, wash basin.',     price:399, unit:'visit',featured:false},
  {id:'s10',catId:'c1',name:'Kitchen Cleaning',         desc:'Degrease chimney, platform and tiles.',           price:599, unit:'visit',featured:false},
  {id:'s11',catId:'c6',name:'Room Painting',            desc:'Interior painting per room, includes labour.',    price:2999,unit:'room', featured:true},
  {id:'s12',catId:'c6',name:'Wall Putty + Paint',       desc:'Putty finish with two coats of paint.',           price:3999,unit:'room', featured:false},
  {id:'s13',catId:'c5',name:'Door Repair',              desc:'Fix sagging, squeaking or misaligned doors.',     price:349, unit:'visit',featured:true},
  {id:'s14',catId:'c5',name:'Furniture Repair',         desc:'Fix broken furniture joints, hinges, drawers.',  price:499, unit:'visit',featured:false},
  {id:'s15',catId:'c7',name:'AC Service & Cleaning',    desc:'Filter clean, coil wash and gas check.',          price:699, unit:'unit', featured:true},
  {id:'s16',catId:'c7',name:'AC Gas Refilling',         desc:'Refill refrigerant gas for better cooling.',      price:999, unit:'unit', featured:false},
  {id:'s17',catId:'c12',name:'General Pest Control',    desc:'Cockroach, ant and general pest treatment.',      price:599, unit:'visit', featured:false},
  {id:'s18',catId:'c8',name:'Laundry & Ironing',        desc:'Daily wash, dry and ironing service.',            price:299, unit:'visit',featured:false},
];

// ── LIVE SYNC: pull real categories/services from Supabase ─────
// (Customer-facing screens use CATEGORIES/SERVICES — keep them in
//  sync with whatever the admin panel edits in Supabase.)
const CAT_EMOJI_FALLBACK = ['💧','⚡','🧹','🖌️','🔨','❄️','👷','🧺','🔧','🏠'];
const CAT_BG_FALLBACK     = ['#DBEAFE','#FEF9C3','#DCFCE7','#FEE2E2','#FEF3C7','#E0F2FE','#F3E8FF','#F0FDF4','#FFE4E6','#E0E7FF'];

let currentServicesCatFilter = null; // remembers which category the customer is viewing
let isSyncingCatalog = false;
let syncDebounceTimer = null;

function showLiveSyncDot() {
  let dot = document.getElementById('live-sync-dot');
  if (!dot) {
    dot = document.createElement('div');
    dot.id = 'live-sync-dot';
    dot.style.cssText = 'position:fixed;top:10px;right:14px;z-index:200;background:var(--navy);color:white;font-size:10.5px;font-weight:700;padding:5px 11px;border-radius:var(--r-full);box-shadow:var(--shadow-sm);opacity:0;transition:opacity .25s;display:flex;align-items:center;gap:6px';
    dot.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--primary-mid)"></span> Updating…';
    document.body.appendChild(dot);
  }
  dot.style.opacity = '1';
  return dot;
}
function hideLiveSyncDot() {
  const dot = document.getElementById('live-sync-dot');
  if (dot) dot.style.opacity = '0';
}

async function syncCatalogFromSupabase(opts = {}) {
  const { silent = false, retriesLeft = 2 } = opts;
  if (!sb) return;
  if (isSyncingCatalog) return; // collapse concurrent calls into one
  isSyncingCatalog = true;
  if (!silent) showLiveSyncDot();

  // Preserve scroll position across the re-render
  const scrollY = window.scrollY;

  try {
    const { data: cats, error: catErr } = await sb
      .from('service_categories').select('*').eq('is_active', true).order('sort_order');
    const { data: svcs, error: svcErr } = await sb
      .from('services').select('*').eq('is_active', true).order('sort_order');

    if (catErr || svcErr || !cats || !svcs) {
      console.warn('[syncCatalogFromSupabase] failed', catErr, svcErr);
      if (retriesLeft > 0) {
        isSyncingCatalog = false;
        setTimeout(() => syncCatalogFromSupabase({ silent, retriesLeft: retriesLeft - 1 }), 1200);
        return;
      }
      hideLiveSyncDot();
      isSyncingCatalog = false;
      return;
    }

    const mappedCats = cats.map((c, i) => ({
      id: c.id,
      name: c.name,
      emoji: CAT_EMOJI_FALLBACK[i % CAT_EMOJI_FALLBACK.length],
      bg: CAT_BG_FALLBACK[i % CAT_BG_FALLBACK.length],
      img: c.image_url || '', // admin-uploaded photo takes priority over keyword fallback
    }));

    const mappedSvcs = svcs.map(s => ({
      id: s.id,
      catId: s.category_id,
      name: s.name,
      desc: s.description || '',
      price: s.base_price || 0,
      unit: s.price_unit || 'visit',
      featured: !!s.is_featured,
      img: s.image_url || '',
    }));

    CATEGORIES.length = 0; CATEGORIES.push(...mappedCats);
    SERVICES.length = 0;   SERVICES.push(...mappedSvcs);

    // Re-render whatever the customer is currently looking at, preserving
    // their category filter and scroll position so the update feels live
    // rather than like a page reload.
    if (S.user) {
      if (S.currentScreen === 'home') {
        const homeSearchEl = document.getElementById('home-search');
        if (!homeSearchEl || !homeSearchEl.value.trim()) renderHome();
      }
      if (S.currentScreen === 'services') {
        const svcSearchEl = document.getElementById('services-search');
        if (!svcSearchEl || !svcSearchEl.value.trim()) renderServices(currentServicesCatFilter);
      }
      if (S.currentScreen === 'service-detail' && S.selectedService) {
        const stillExists = SERVICES.find(s => s.id === S.selectedService.id);
        if (stillExists) openServiceDetail(stillExists.id);
        // if it was deleted, leave the customer on the page they're reading;
        // don't yank them away mid-read.
      }
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  } catch (e) {
    console.error('[syncCatalogFromSupabase] exception', e);
    if (retriesLeft > 0) {
      isSyncingCatalog = false;
      setTimeout(() => syncCatalogFromSupabase({ silent, retriesLeft: retriesLeft - 1 }), 1200);
      return;
    }
  }
  hideLiveSyncDot();
  isSyncingCatalog = false;
}

function syncCatalogDebounced(delay = 400) {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => syncCatalogFromSupabase({ silent: false }), delay);
}

let realtimeSubscribed = false;
function subscribeToCatalogRealtime() {
  if (!sb || realtimeSubscribed) return;
  realtimeSubscribed = true;
  try {
    sb.channel('catalog-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, () => syncCatalogDebounced())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'service_categories' }, () => syncCatalogDebounced())
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[subscribeToCatalogRealtime] channel issue:', status, '— falling back to manual sync only');
          realtimeSubscribed = false; // allow a retry later if init runs again
        }
      });
  } catch (e) {
    console.warn('[subscribeToCatalogRealtime] could not subscribe', e);
    realtimeSubscribed = false;
  }
}

const STATUS_CFG = {
  pending:    {label:'Pending',    color:'#F59E0B',bg:'#FFFBEB'},
  confirmed:  {label:'Confirmed',  color:'#3B82F6',bg:'#EFF6FF'},
  assigned:   {label:'Assigned',   color:'#8B5CF6',bg:'#F5F3FF'},
  in_progress:{label:'In Progress',color:'#F97316',bg:'#FFF7ED'},
  completed:  {label:'Completed',  color:'#10B981',bg:'#ECFDF5'},
  cancelled:  {label:'Cancelled',  color:'#EF4444',bg:'#FEF2F2'},
};

const TIME_SLOTS = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM'];

const PROMO_CODES = {
  'FIRST50': {discount:50,  type:'flat',    label:'₹50 off your first booking!'},
  'SAVE10':  {discount:10,  type:'percent', label:'10% discount applied!'},
  'WELCOME': {discount:100, type:'flat',    label:'₹100 welcome discount!'},
  'HOUSE20': {discount:20,  type:'percent', label:'20% off — special offer!'},
};

// ── TOAST ─────────────────────────────────────────────────────
function toast(msg, ms=2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function escapeAttr(value) {
  return escapeHTML(value).replace(/`/g, '&#96;');
}

function escapeJSString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

// ── NAVIGATION ────────────────────────────────────────────────
function showScreen(id) {
  if (S.currentScreen !== id) S.history.push(S.currentScreen);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
  S.currentScreen = id;
  window.scrollTo(0, 0);
}

function goBack() {
  const prev = S.history.pop();
  if (prev) showScreen(prev);
  else showTab('home');
}

function showTab(tab) {
  S.history = [];
  const map = { home: renderHome, services: () => renderServices(null), bookings: renderBookings, profile: renderProfile, notifications: () => {} };
  if (map[tab]) map[tab]();
  showScreen(tab);
  // Update bottom nav active state in every nav bar across all screens
  document.querySelectorAll('.bottom-nav .nav-item').forEach(el => {
    const label = el.querySelector('.nav-label')?.textContent?.toLowerCase().trim();
    const tabMap = { home:'home', bookings:'bookings', explore:'services', notifications:'notifications', profile:'profile' };
    el.classList.toggle('active', tabMap[label] === tab);
  });
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── AUTH ──────────────────────────────────────────────────────
let resendInterval = null;

function sendOTP() {
  const phone = document.getElementById('phone-input').value;
  if (phone.length < 10) { toast('Please enter a valid 10-digit number'); return; }
  document.getElementById('otp-subtitle').innerHTML = `Enter the 6-digit code sent to<br><strong>+91 ${phone}</strong>`;
  for (let i = 0; i < 6; i++) document.getElementById('otp' + i).value = '';
  showScreen('otp');
  let c = 30;
  const timerEl = document.getElementById('resend-timer');
  if (resendInterval) clearInterval(resendInterval);
  timerEl.innerHTML = `Resend OTP in <span id="rc">30</span>s`;
  resendInterval = setInterval(() => {
    c--;
    const rc = document.getElementById('rc');
    if (rc) rc.textContent = c;
    if (c <= 0) {
      clearInterval(resendInterval);
      if (timerEl) timerEl.innerHTML = '<a onclick="sendOTP()" style="color:var(--primary);font-weight:600;cursor:pointer">Resend OTP</a>';
    }
  }, 1000);
  setTimeout(() => document.getElementById('otp0').focus(), 300);
}

function otpInput(i, el) {
  el.value = el.value.replace(/\D/g, '');
  if (el.value && i < 5) document.getElementById('otp' + (i + 1)).focus();
  if (i === 5 && el.value) verifyOTP();
}

function verifyOTP() {
  const otp = Array.from({length:6}, (_, i) => document.getElementById('otp' + i).value).join('');
  if (otp.length < 6) { toast('Please enter all 6 digits'); return; }
  const phone = document.getElementById('phone-input').value;
  localStorage.setItem('hh_phone', phone);
  const savedName = localStorage.getItem('hh_name');
  if (savedName) loginUser(savedName, phone, localStorage.getItem('hh_email') || '');
  else showScreen('profile-setup');
}

function completeSetup() {
  const name = document.getElementById('setup-name').value.trim();
  if (!name) { toast('Please enter your name'); return; }
  const email = document.getElementById('setup-email').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Please enter a valid email address'); return; }
  const phone = document.getElementById('phone-input').value;
  localStorage.setItem('hh_name', name);
  localStorage.setItem('hh_phone', phone);
  if (email) localStorage.setItem('hh_email', email);
  loginUser(name, phone, email);
}

function loginUser(name, phone, email = '') {
  S.user = { name, phone: '+91' + phone, email, role: 'customer' };
  BOOKINGS = JSON.parse(localStorage.getItem('hh_bookings') || '[]');
  SAVED_ADDRESSES = JSON.parse(localStorage.getItem('hh_addresses') || '[]');
  RATINGS = JSON.parse(localStorage.getItem('hh_ratings') || '{}');
  // Analytics: identify user and track login
  if (typeof Analytics !== 'undefined') {
    Analytics.setUser('+91' + phone);
    Analytics.login('phone');
  }
  renderHome();
  showScreen('home');
  syncCatalogFromSupabase();
  loadBrandSettings();
}

function logout() {
  if (!confirm('Are you sure you want to sign out?')) return;
  if (typeof Analytics !== 'undefined') Analytics.logout();
  localStorage.removeItem('hh_name');
  localStorage.removeItem('hh_phone');
  localStorage.removeItem('hh_email');
  S.user = null; BOOKINGS = []; SAVED_ADDRESSES = []; RATINGS = {};
  showScreen('login');
}

// ── RATINGS HELPER ────────────────────────────────────────────
function getServiceRating(serviceId) {
  const all = Object.values(RATINGS).filter(r => r.serviceId === serviceId);
  if (!all.length) return { avg: 0, count: 0 };
  return { avg: all.reduce((s, r) => s + r.rating, 0) / all.length, count: all.length };
}

// ── HOME ──────────────────────────────────────────────────────
let statsAnimated = false;

function renderHome() {
  if (!S.user) return;
  document.getElementById('home-avatar').textContent = S.user.name.charAt(0).toUpperCase();

  BOOKINGS = JSON.parse(localStorage.getItem('hh_bookings') || '[]');
  const active = BOOKINGS.find(b => b.customerId === S.user.phone && ['pending','confirmed','assigned','in_progress'].includes(b.status));
  const widget = document.getElementById('active-booking-widget');
  if (active) {
    widget.style.display = 'block';
    document.getElementById('active-booking-name').textContent = active.serviceName;
    document.getElementById('active-booking-status').textContent = STATUS_CFG[active.status]?.label || active.status;
  } else {
    widget.style.display = 'none';
  }

  // Show first 7 cats + "More" tile — uses admin-uploaded photo when available
  const visibleCats = CATEGORIES.slice(0, 7);
  document.getElementById('home-categories').innerHTML = visibleCats.map(c => {
    const svcCount = SERVICES.filter(s => s.catId === c.id).length;
    const imgUrl = getCatImage(c);
    const safeCatId = escapeJSString(c.id);
    const safeCatName = escapeHTML(c.name);
    const safeCatNameAttr = escapeAttr(c.name);
    const safeImgUrl = escapeAttr(imgUrl);
    const circleContent = imgUrl
      ? `<img src="${safeImgUrl}" alt="${safeCatNameAttr}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<span style="font-size:26px;display:none;align-items:center;justify-content:center;width:100%;height:100%">${c.emoji || '🔧'}</span>`
      : `<span style="font-size:26px">${c.emoji || '🔧'}</span>`;
    return `<div onclick="renderServices('${safeCatId}');showScreen('services')" style="display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer">
      <div style="width:64px;height:64px;border-radius:50%;background:${c.bg || 'var(--primary-light)'};display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .15s;flex-shrink:0;box-shadow:var(--shadow-sm)" onmouseenter="this.style.transform='translateY(-2px) scale(1.05)'" onmouseleave="this.style.transform=''">${circleContent}</div>
      <div style="font-size:11px;font-weight:700;color:var(--navy);text-align:center;line-height:1.25;max-width:64px">${safeCatName}</div>
      <div style="font-size:9.5px;color:var(--text-3)">${svcCount} service${svcCount !== 1 ? 's' : ''}</div>
    </div>`;
  }).join('') + `
    <div onclick="showTab('services')" style="display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--surface-alt);display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--text-2);box-shadow:var(--shadow-xs)">···</div>
      <div style="font-size:11px;font-weight:700;color:var(--navy);text-align:center">More</div>
      <div style="font-size:9.5px;color:var(--text-3)">View all</div>
    </div>`;

  const featured = SERVICES.filter(s => s.featured);
  document.getElementById('home-featured').innerHTML = featured.map(s => popularServiceCardHTML(s)).join('');

  animateStatsOnce();
}

function popularServiceCardHTML(s) {
  const cat = CATEGORIES.find(c => c.id === s.catId);
  const r = getServiceRating(s.id);
  const ratingStr = r.count > 0 ? `⭐ ${r.avg.toFixed(1)} (${r.count})` : '⭐ New';
  const durationMap = { visit:'45-60 min', room:'2-3 hrs', unit:'45 min', day:'Full day' };
  const duration = durationMap[s.unit] || '45-60 min';
  const imgUrl = s.img || getCatImage(CATEGORIES.find(c=>c.id===s.catId));
  const safeServiceId = escapeJSString(s.id);
  const safeServiceName = escapeHTML(s.name);
  const safeServiceNameAttr = escapeAttr(s.name);
  const safeImgUrl = escapeAttr(imgUrl);
  return `<div class="pop-card" onclick="openServiceDetail('${safeServiceId}')">
    <div class="pop-card-photo" style="background:${cat?.bg || 'var(--primary-light)'}">
      ${imgUrl ? `<img src="${safeImgUrl}" alt="${safeServiceNameAttr}" onerror="this.style.display='none'">` : (cat?.emoji || '🔧')}
    </div>
    <div class="pop-card-body">
      <div class="pop-card-name">${safeServiceName}</div>
      <div class="pop-card-meta">${ratingStr} · ${duration}</div>
      <div class="pop-card-footer">
        <div class="pop-card-price">₹${s.price.toLocaleString('en-IN')}</div>
        <div class="pop-card-book" onclick="event.stopPropagation();openServiceDetail('${safeServiceId}')">Book Now</div>
      </div>
    </div>
  </div>`;
}

function animateStatsOnce() {
  if (statsAnimated) return;
  const boxes = document.querySelectorAll('.stat-box-num');
  if (!boxes.length) return;
  statsAnimated = true;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const decimals = parseInt(el.dataset.decimal || '0', 10);
      const suffix = el.dataset.suffix || '';
      const start = performance.now();
      const duration = 1300;
      function tick(now) {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = target * eased;
        el.textContent = decimals ? val.toFixed(decimals) : Math.floor(val).toLocaleString('en-IN');
        if (p < 1) requestAnimationFrame(tick);
        else el.innerHTML = (decimals ? target.toFixed(decimals) : target.toLocaleString('en-IN')) + `<span class="suffix">${suffix}</span>`;
      }
      requestAnimationFrame(tick);
      io.unobserve(el);
    });
  }, { threshold: 0.4 });
  boxes.forEach(b => io.observe(b));
}

function serviceCardHTML(s) {
  const cat = CATEGORIES.find(c => c.id === s.catId);
  const r = getServiceRating(s.id);
  const rStr = r.count > 0 ? ` · ⭐${r.avg.toFixed(1)} (${r.count})` : '';
  const imgUrl = s.img || getCatImage(CATEGORIES.find(c=>c.id===s.catId));
  const safeServiceId = escapeJSString(s.id);
  const safeServiceName = escapeHTML(s.name);
  const safeServiceNameAttr = escapeAttr(s.name);
  const safeCatName = escapeHTML(cat?.name || '');
  const safeImgUrl = escapeAttr(imgUrl);
  return `<div class="service-card" onclick="openServiceDetail('${safeServiceId}')">
    <div class="service-thumb" style="background:${cat?.bg||'var(--primary-light)'}">
      ${imgUrl ? `<img src="${safeImgUrl}" alt="${safeServiceNameAttr}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : cat?.emoji || '🔧'}
    </div>
    <div class="service-info">
      <div class="service-name">${safeServiceName}</div>
      <div class="service-cat">${safeCatName}${rStr}</div>
      <div class="service-price">Starting ₹${s.price.toLocaleString('en-IN')} / ${escapeHTML(s.unit)}</div>
    </div>
    <div style="font-size:20px;color:var(--text-3);align-self:center">›</div>
  </div>`;
}

// ── SEARCH ────────────────────────────────────────────────────
let _searchTrackTimer = null;
function handleSearch(q) {
  const results = document.getElementById('search-results');
  const main = document.getElementById('home-main-content');
  const clearBtn = document.getElementById('search-clear-btn');
  if (q.length >= 2) {
    clearBtn.style.display = 'block'; results.style.display = 'block'; main.style.display = 'none';
    const found = SERVICES.filter(s => s.name.toLowerCase().includes(q.toLowerCase()) || s.desc.toLowerCase().includes(q.toLowerCase()));
    results.innerHTML = found.length ? found.map(s => serviceCardHTML(s)).join('')
      : `<div class="empty"><div class="empty-icon">🔍</div><h3>No results</h3><p>No services found for "${escapeHTML(q)}"</p></div>`;
    // Track search with debounce (only after user stops typing for 1s)
    clearTimeout(_searchTrackTimer);
    _searchTrackTimer = setTimeout(() => {
      if (typeof Analytics !== 'undefined') Analytics.search(q, found.length);
    }, 1000);
  } else {
    clearBtn.style.display = 'none'; results.style.display = 'none'; main.style.display = 'block';
  }
}

function clearSearch() {
  document.getElementById('home-search').value = '';
  handleSearch('');
}

// ── SERVICES ──────────────────────────────────────────────────
// Category photos — keyed by lowercase name so they work with both
// static category IDs (c1/c2) AND real Supabase UUID IDs after sync.
// Image lookup — admin-uploaded only.
// No hardcoded fallbacks: if admin hasn't uploaded a photo, the emoji
// on a colored background shows instead. This keeps things clean and
// prevents wrong stock photos from showing for the wrong categories.
function getCatImage(cat) {
  return (cat && cat.img) ? cat.img : '';
}



function renderServices(catId) {
  currentServicesCatFilter = catId;
  const header = document.getElementById('services-header');
  const chipsBar = document.getElementById('services-chips-bar');
  const content = document.getElementById('services-content');

  // Clear search
  const si = document.getElementById('services-search');
  if (si) si.value = '';
  document.getElementById('svc-search-clear').style.display = 'none';

  if (!catId) {
    chipsBar.style.display = 'none';
    content.innerHTML = `
      <div class="cat-grid-new" style="margin-bottom:20px">${
        CATEGORIES.map(c => `
          <div class="cat-card-new" onclick="renderServices('${escapeJSString(c.id)}')">
            <div class="cat-card-img-wrap">
              <img src="${escapeAttr(getCatImage(c))}" alt="${escapeAttr(c.name)}" class="cat-card-img" loading="lazy"
                onload="this.nextElementSibling.style.display='none'"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex';this.parentElement.nextElementSibling.style.display='flex'">
              <div class="cat-card-icon-badge">${c.emoji}</div>
            </div>
            <div class="cat-card-img-placeholder" style="display:none;background:${c.bg}">${c.emoji}</div>
            <div class="cat-card-body">
              <div class="cat-card-name">${escapeHTML(c.name)}</div>
              <div class="cat-card-count">${SERVICES.filter(s => s.catId === c.id).length} services</div>
              <div class="cat-card-link">View services →</div>
            </div>
          </div>`).join('')}
      </div>
      <div style="background:linear-gradient(135deg,var(--primary-light),#C8EDE8);border-radius:var(--r-lg);padding:20px;display:flex;align-items:center;gap:14px;cursor:pointer;border:1px solid rgba(26,155,138,.2);overflow:hidden;position:relative" onclick="openWhatsApp()">
        <img src="https://images.unsplash.com/photo-1557804506-669a67965ba0?w=200&q=80" style="position:absolute;right:0;top:0;height:100%;width:140px;object-fit:cover;opacity:0.15" onerror="this.style.display='none'">
        <span style="font-size:32px;position:relative;z-index:1">💬</span>
        <div style="position:relative;z-index:1"><div style="font-size:15px;font-weight:800;color:var(--primary-darker)">Can't find what you need?</div><div style="font-size:13px;color:var(--primary);margin-top:2px">Chat with us on WhatsApp →</div></div>
      </div>`;
    return;
  }

  const cat = CATEGORIES.find(c => c.id === catId);
  chipsBar.style.display = 'block';
  document.getElementById('services-chips').innerHTML = CATEGORIES.map(c =>
    `<div class="chip ${c.id === catId ? 'active' : ''}" onclick="renderServices('${escapeJSString(c.id)}')">${c.emoji} ${escapeHTML(c.name)}</div>`).join('');

  const svcs = SERVICES.filter(s => s.catId === catId);
  if (!svcs.length) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">🔧</div><h3>No services yet</h3><p>This category has no services available at the moment.</p></div>`;
    return;
  }
  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="width:40px;height:40px;border-radius:10px;background:${cat.bg};display:flex;align-items:center;justify-content:center;font-size:20px">${cat.emoji}</div>
      <div><div style="font-size:17px;font-weight:900;color:var(--navy)">${escapeHTML(cat.name)}</div><div style="font-size:12px;color:var(--text-2)">${svcs.length} services available</div></div>
    </div>
    ${svcs.map(s => serviceCardHTML(s)).join('')}`;
}

function handleServicesSearch(q) {
  const clearBtn = document.getElementById('svc-search-clear');
  const content = document.getElementById('services-content');
  if (q.length >= 2) {
    clearBtn.style.display = 'block';
    const found = SERVICES.filter(s =>
      s.name.toLowerCase().includes(q.toLowerCase()) ||
      s.desc.toLowerCase().includes(q.toLowerCase()));
    content.innerHTML = found.length
      ? `<p style="font-size:13px;color:var(--text-2);margin-bottom:12px">${found.length} result${found.length !== 1 ? 's' : ''} for "${q}"</p>` + found.map(s => serviceCardHTML(s)).join('')
      : `<div class="empty"><div class="empty-icon">🔍</div><h3>No results</h3><p>No services found for "${q}"</p></div>`;
    document.getElementById('services-chips-bar').style.display = 'none';
  } else {
    clearBtn.style.display = 'none';
    renderServices(null);
  }
}

function clearServicesSearch() {
  document.getElementById('services-search').value = '';
  handleServicesSearch('');
}

// ── SERVICE DETAIL ────────────────────────────────────────────
function openServiceDetail(serviceId) {
  const s = SERVICES.find(sv => sv.id === serviceId);
  if (!s) return;
  const cat = CATEGORIES.find(c => c.id === s.catId);
  S.selectedService = s;
  // Analytics
  if (typeof Analytics !== 'undefined') Analytics.serviceViewed(s.id, s.name, cat?.name);
  const imgUrl = s.img || getCatImage(CATEGORIES.find(c=>c.id===s.catId));
  const heroEl = document.getElementById('service-detail-hero');
  if (imgUrl) {
    heroEl.style.backgroundImage = `url('${imgUrl}')`;
    heroEl.style.backgroundSize = 'cover';
    heroEl.style.backgroundPosition = 'center';
    heroEl.textContent = '';
    // Add gradient overlay
    heroEl.innerHTML = `<div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.4) 0%,transparent 60%)"></div>`;
    heroEl.style.position = 'relative';
  } else {
    heroEl.style.backgroundImage = '';
    heroEl.style.background = cat?.bg ? `linear-gradient(135deg,${cat.bg},white)` : 'linear-gradient(135deg,var(--primary-light),var(--primary-mid))';
    heroEl.textContent = cat?.emoji || '🔧';
  }
  document.getElementById('service-detail-cat').textContent = cat?.name || '';
  document.getElementById('service-detail-name').textContent = s.name;
  document.getElementById('service-detail-price').textContent = `₹${s.price.toLocaleString('en-IN')} / ${s.unit}`;
  document.getElementById('service-detail-desc').textContent = s.desc;
  const r = getServiceRating(s.id);
  if (r.count > 0) {
    document.getElementById('service-stars-display').textContent = '⭐'.repeat(Math.round(r.avg));
    document.getElementById('service-rating-text').textContent = `${r.avg.toFixed(1)} / 5 (${r.count} review${r.count > 1 ? 's' : ''})`;
  } else {
    document.getElementById('service-stars-display').textContent = '';
    document.getElementById('service-rating-text').textContent = 'No reviews yet';
  }
  document.getElementById('service-detail-footer-price').innerHTML = `
    <div style="font-size:11px;color:var(--text-2)">Starting from</div>
    <div style="font-size:20px;font-weight:800;color:var(--primary)">₹${s.price.toLocaleString('en-IN')}</div>`;
  showScreen('service-detail');
}

// ── BOOKING FLOW ──────────────────────────────────────────────
function startBooking() {
  if (!S.selectedService) return;
  S.bookingStep = 1; S.bookingPhotos = [];
  S.paymentMethod = 'pay_after'; S.paymentScreenshot = null;
  S.promoDiscount = 0; S.promoCode = ''; S.promoType = '';
  S.selectedTimeSlot = '';
  document.getElementById('booking-service-name').textContent = S.selectedService.name;
  ['b-addr1','b-addr2','b-city','b-pin','b-desc'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('b-phone').value = S.user?.phone?.replace('+91', '') || '';
  document.getElementById('promo-input').value = '';
  document.getElementById('promo-result').textContent = '';
  document.getElementById('booking-photos').innerHTML = `<div class="photo-add" onclick="addPhoto()"><span>📷</span><p>Add Photo</p><p id="photo-count" style="font-size:10px;color:var(--text-3)">0/3</p></div>`;
  selectPayment('pay_after');
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('b-date').min = today;
  document.getElementById('b-date').value = today;
  renderTimeSlots();
  renderSavedAddressesInBooking();
  renderBookingSteps();
  showBookingStep(1);
  showScreen('booking');
}

function renderSavedAddressesInBooking() {
  const el = document.getElementById('saved-addresses-list');
  if (!SAVED_ADDRESSES.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<p style="font-size:12px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Saved Addresses</p>`
    + SAVED_ADDRESSES.map((a, i) => `
    <div onclick="fillAddress(${i})" style="border:1.5px solid var(--border);border-radius:var(--r-md);padding:12px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;gap:10px;background:var(--surface)">
      <div style="flex:1"><div style="font-size:13px;font-weight:700">${a.label}</div><div style="font-size:12px;color:var(--text-2)">${a.line1}, ${a.city} — ${a.pincode}</div></div>
      <span style="font-size:14px;color:var(--primary);font-weight:700">Use</span>
    </div>`).join('')
    + `<p style="font-size:12px;color:var(--text-3);margin-bottom:12px;text-align:center">— or enter a new address —</p>`;
}

function fillAddress(idx) {
  const a = SAVED_ADDRESSES[idx];
  document.getElementById('b-addr1').value = a.line1;
  document.getElementById('b-addr2').value = a.line2 || '';
  document.getElementById('b-city').value = a.city;
  document.getElementById('b-pin').value = a.pincode;
  toast('Address filled ✓');
}

function renderTimeSlots() {
  document.getElementById('time-slots').innerHTML = TIME_SLOTS.map(t =>
    `<div class="time-slot ${S.selectedTimeSlot === t ? 'selected' : ''}" onclick="selectTimeSlot('${t}')">${t}</div>`).join('');
}

function selectTimeSlot(t) { S.selectedTimeSlot = t; renderTimeSlots(); }

function renderBookingSteps() {
  const steps = ['Address', 'Schedule', 'Problem', 'Payment', 'Review'];
  document.getElementById('booking-steps-bar').innerHTML = steps.map((s, i) => {
    const n = i + 1, done = n < S.bookingStep, curr = n === S.bookingStep;
    return `${i > 0 ? `<div class="step-line ${done || curr ? 'done' : ''}"></div>` : ''}
      <div class="step-dot ${done ? 'done' : curr ? 'current' : ''}">${done ? '✓' : n}</div>`;
  }).join('');
}

function showBookingStep(step) {
  for (let i = 1; i <= 5; i++) {
    document.getElementById('booking-step-' + i).style.display = i === step ? 'block' : 'none';
  }
  S.bookingStep = step;
  document.getElementById('booking-step-label').textContent = `Step ${step} of 5`;
  document.getElementById('booking-progress').style.width = (step / 5 * 100) + '%';
  renderBookingSteps();
  const labels = ['', 'Next: Schedule & Contact →', 'Next: Describe Problem →', 'Next: Payment Method →', 'Next: Review Booking →', '✓ Confirm Booking'];
  document.getElementById('booking-next-btn').textContent = labels[step];
}

function bookingNext() {
  if (S.bookingStep === 1) {
    if (!document.getElementById('b-addr1').value.trim()) { toast('Please enter your street address'); return; }
    if (!document.getElementById('b-city').value.trim()) { toast('Please enter your city'); return; }
    if (!/^\d{6}$/.test(document.getElementById('b-pin').value)) { toast('Please enter a valid 6-digit PIN code'); return; }
    if (document.getElementById('save-address-cb') && document.getElementById('save-address-cb').checked) {
      SAVED_ADDRESSES.push({
        label: 'Home',
        line1: document.getElementById('b-addr1').value,
        line2: document.getElementById('b-addr2').value,
        city: document.getElementById('b-city').value,
        pincode: document.getElementById('b-pin').value
      });
      localStorage.setItem('hh_addresses', JSON.stringify(SAVED_ADDRESSES));
      toast('Address saved ✓');
    }
    showBookingStep(2);
  } else if (S.bookingStep === 2) {
    if (document.getElementById('b-phone').value.replace(/\D/g, '').length < 10) { toast('Please enter a valid 10-digit phone number'); return; }
    if (!S.selectedTimeSlot) { toast('Please select a preferred time slot'); return; }
    showBookingStep(3);
  } else if (S.bookingStep === 3) {
    showBookingStep(4);
  } else if (S.bookingStep === 4) {
    if (S.paymentMethod === 'pay_before' && !S.paymentScreenshot) { toast('Please upload a screenshot of your payment'); return; }
    renderReview(); showBookingStep(5);
  } else if (S.bookingStep === 5) {
    confirmBooking();
  }
}

function bookingBack() {
  if (S.bookingStep > 1) showBookingStep(S.bookingStep - 1);
  else goBack();
}

function selectPayment(method) {
  S.paymentMethod = method;
  document.getElementById('pay-after-card').classList.toggle('selected', method === 'pay_after');
  document.getElementById('pay-before-card').classList.toggle('selected', method === 'pay_before');
  document.getElementById('upi-section').style.display = method === 'pay_before' ? 'block' : 'none';
  document.getElementById('upi-id-display').textContent = S.settings.upi_id;
  if (S.settings.upi_qr_url) {
    document.getElementById('upi-qr-display').innerHTML = `<img src="${S.settings.upi_qr_url}" style="width:100%;height:100%;object-fit:contain">`;
  }
}

function applyPromo() {
  const code = document.getElementById('promo-input').value.trim().toUpperCase();
  const result = document.getElementById('promo-result');
  if (!code) { result.textContent = ''; return; }
  const promo = PROMO_CODES[code];
  if (!promo) {
    result.innerHTML = `<span style="color:var(--error)">✕ Invalid promo code</span>`;
    S.promoDiscount = 0; S.promoCode = ''; return;
  }
  S.promoCode = code; S.promoType = promo.type;
  S.promoDiscount = promo.type === 'flat' ? promo.discount
    : Math.round(S.selectedService.price * promo.discount / 100);
  result.innerHTML = `<span style="color:var(--success)">✓ ${promo.label} (₹${S.promoDiscount} off)</span>`;
}

function addPhoto() {
  if (S.bookingPhotos.length >= 3) { toast('Maximum 3 photos allowed'); return; }
  document.getElementById('photo-input').click();
}

function handlePhoto(input) {
  Array.from(input.files).forEach(file => {
    if (S.bookingPhotos.length >= 3) return;
    const reader = new FileReader();
    reader.onload = e => { S.bookingPhotos.push(e.target.result); renderPhotoGrid(); };
    reader.readAsDataURL(file);
  });
}

function renderPhotoGrid() {
  const count = S.bookingPhotos.length;
  document.getElementById('booking-photos').innerHTML = S.bookingPhotos.map((uri, i) => `
    <div style="position:relative">
      <img src="${uri}" class="photo-thumb">
      <div onclick="removePhoto(${i})" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;cursor:pointer;color:white;font-size:11px;font-weight:800">✕</div>
    </div>`).join('')
    + (count < 3 ? `<div class="photo-add" onclick="addPhoto()"><span>📷</span><p>Add Photo</p><p style="font-size:10px;color:var(--text-3)">${count}/3</p></div>` : '');
}

function removePhoto(i) { S.bookingPhotos.splice(i, 1); renderPhotoGrid(); }

function handleScreenshot(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    S.paymentScreenshot = e.target.result;
    document.getElementById('screenshot-area').innerHTML = `
      <img src="${e.target.result}" style="width:100%;max-height:200px;object-fit:contain;border-radius:var(--r-md)">
      <button onclick="S.paymentScreenshot=null;document.getElementById('screenshot-area').innerHTML='<div style=\\'padding:24px;text-align:center\\'>📤 Upload Screenshot</div>'" style="background:none;border:none;color:var(--primary);font-size:13px;font-weight:600;cursor:pointer;margin-top:8px;display:block">Change Screenshot</button>`;
  };
  reader.readAsDataURL(file);
}

function renderReview() {
  const s = S.selectedService;
  const cat = CATEGORIES.find(c => c.id === s.catId);
  const finalPrice = Math.max(0, s.price - S.promoDiscount);
  document.getElementById('booking-review-content').innerHTML = `
    <div class="section-card"><div class="section-card-title">🔧 Service</div>
      <div class="detail-row"><span class="dl">Service</span><span class="dv">${s.name}</span></div>
      <div class="detail-row"><span class="dl">Category</span><span class="dv">${cat?.name}</span></div>
      <div class="detail-row"><span class="dl">Base price</span><span class="dv">₹${s.price.toLocaleString('en-IN')} / ${s.unit}</span></div>
      ${S.promoDiscount > 0 ? `<div class="detail-row"><span class="dl">Promo (${S.promoCode})</span><span class="dv" style="color:var(--success)">-₹${S.promoDiscount}</span></div>
      <div class="detail-row"><span class="dl" style="font-weight:700">You pay</span><span class="dv" style="color:var(--primary);font-weight:800;font-size:15px">₹${finalPrice.toLocaleString('en-IN')}</span></div>` : ''}
    </div>
    <div class="section-card"><div class="section-card-title">📍 Address</div>
      <p style="font-size:14px;line-height:1.7;margin-bottom:8px">${document.getElementById('b-addr1').value}${document.getElementById('b-addr2').value ? ', ' + document.getElementById('b-addr2').value : ''}<br>${document.getElementById('b-city').value} — ${document.getElementById('b-pin').value}</p>
      <div class="detail-row"><span class="dl">Contact</span><span class="dv">+91 ${document.getElementById('b-phone').value}</span></div>
    </div>
    <div class="section-card"><div class="section-card-title">📅 Schedule</div>
      <div class="detail-row"><span class="dl">Date</span><span class="dv">${document.getElementById('b-date').value}</span></div>
      <div class="detail-row"><span class="dl">Time</span><span class="dv">${S.selectedTimeSlot}</span></div>
    </div>
    ${document.getElementById('b-desc').value ? `<div class="section-card"><div class="section-card-title">📝 Problem</div><p style="font-size:14px;color:var(--text-2);line-height:1.6">${document.getElementById('b-desc').value}</p></div>` : ''}
    ${S.bookingPhotos.length ? `<div class="section-card"><div class="section-card-title">📷 Photos</div><p style="font-size:13px;color:var(--text-2)">${S.bookingPhotos.length} photo(s) attached</p></div>` : ''}
    <div class="section-card"><div class="section-card-title">💳 Payment</div>
      <div class="detail-row"><span class="dl">Method</span><span class="dv">${S.paymentMethod === 'pay_before' ? 'Pay Before Service' : 'Pay After Service'}</span></div>
      ${S.paymentMethod === 'pay_before' && S.paymentScreenshot ? `<div class="detail-row"><span class="dl">Screenshot</span><span class="dv" style="color:var(--success)">✅ Uploaded</span></div>` : ''}
    </div>`;
}

function confirmBooking() {
  const id = 'HH' + Date.now().toString(36).toUpperCase().slice(-6);
  const finalPrice = Math.max(0, S.selectedService.price - S.promoDiscount);
  const booking = {
    id,
    customerId: S.user.phone,
    serviceId: S.selectedService.id,
    serviceName: S.selectedService.name,
    categoryId: S.selectedService.catId,
    status: 'pending',
    address_line1: document.getElementById('b-addr1').value,
    address_line2: document.getElementById('b-addr2').value,
    address_city: document.getElementById('b-city').value,
    address_pincode: document.getElementById('b-pin').value,
    contact_phone: '+91' + document.getElementById('b-phone').value,
    problem_description: document.getElementById('b-desc').value,
    preferred_date: document.getElementById('b-date').value,
    preferred_time: S.selectedTimeSlot,
    payment_method: S.paymentMethod,
    payment_status: S.paymentMethod === 'pay_before' ? 'pending_verify' : 'unpaid',
    photos: S.bookingPhotos,
    screenshot: S.paymentScreenshot,
    promo_code: S.promoCode,
    discount: S.promoDiscount,
    final_price: finalPrice,
    admin_notes: '',
    assigned_worker_name: '',
    assigned_worker_phone: '',
    created_at: new Date().toISOString(),
  };
  BOOKINGS.unshift(booking);
  localStorage.setItem('hh_bookings', JSON.stringify(BOOKINGS));
  document.getElementById('confirmed-booking-id').textContent = '#' + id;
  // Analytics
  if (typeof Analytics !== 'undefined') {
    Analytics.bookingCompleted(id, S.selectedService.id, finalPrice);
  }
  showScreen('confirmed');
}

function viewBookings() { renderBookings(); showScreen('bookings'); }

// ── BOOKINGS ──────────────────────────────────────────────────
let activeBookingFilter = 'all';

function renderBookings() {
  BOOKINGS = JSON.parse(localStorage.getItem('hh_bookings') || '[]');
  // Migrate bookings that were made when phone wasn't persisted yet
  if (S.user?.phone && S.user.phone !== '+91XXXXXXXXXX') {
    let changed = false;
    BOOKINGS = BOOKINGS.map(b => {
      if (b.customerId === '+91XXXXXXXXXX') { changed = true; return { ...b, customerId: S.user.phone }; }
      return b;
    });
    if (changed) localStorage.setItem('hh_bookings', JSON.stringify(BOOKINGS));
  }
  const myBookings = BOOKINGS.filter(b => b.customerId === S.user?.phone);
  document.getElementById('bookings-count').textContent = `${myBookings.length} total booking${myBookings.length !== 1 ? 's' : ''}`;

  const filters = [
    {label:'All', value:'all'},
    {label:'Pending', value:'pending'},
    {label:'Confirmed', value:'confirmed'},
    {label:'In Progress', value:'in_progress'},
    {label:'Completed', value:'completed'},
    {label:'Cancelled', value:'cancelled'},
  ];
  document.getElementById('bookings-filter-chips').innerHTML = filters.map(f => {
    const count = f.value === 'all' ? myBookings.length : myBookings.filter(b => b.status === f.value).length;
    return `<div class="chip ${activeBookingFilter === f.value ? 'active' : ''}" onclick="setBookingFilter('${f.value}')">${f.label}${count > 0 ? ` (${count})` : ''}</div>`;
  }).join('');

  const filtered = activeBookingFilter === 'all' ? myBookings : myBookings.filter(b => b.status === activeBookingFilter);
  const content = document.getElementById('bookings-content');
  if (!filtered.length) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><h3>No bookings</h3>
      <p>${activeBookingFilter === 'all' ? "Book your first service and we'll take care of the rest." : `No ${activeBookingFilter} bookings.`}</p>
      ${activeBookingFilter === 'all' ? `<button class="btn btn-primary" style="margin-top:16px;width:auto;padding:12px 24px" onclick="showTab('services')">Browse Services</button>` : ''}
    </div>`;
    return;
  }
  content.innerHTML = filtered.map(b => bookingCardHTML(b)).join('');
}

function setBookingFilter(f) { activeBookingFilter = f; renderBookings(); }

function bookingCardHTML(b) {
  const cat = CATEGORIES.find(c => c.id === b.categoryId);
  const sc = STATUS_CFG[b.status] || STATUS_CFG.pending;
  const date = new Date(b.created_at).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
  const hasRating = RATINGS[b.id];
  return `<div class="booking-card" onclick="openBookingDetail('${b.id}')">
    <div class="booking-top">
      <div><div style="font-size:15px;font-weight:700">${b.serviceName}</div><div style="font-size:12px;color:var(--text-2)">${cat?.name || ''}</div></div>
      <span class="badge badge-${b.status}">${sc.label}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-2)">📍 ${b.address_city}, ${b.address_pincode}</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-2)">📅 ${date}${b.preferred_time ? ' · ' + b.preferred_time : ''}</div>
    </div>
    <div class="booking-bottom">
      <span class="booking-id">#${b.id}${hasRating ? ' · ⭐' + RATINGS[b.id].rating : ''}</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="badge badge-${b.payment_status}">${b.payment_status === 'unpaid' ? 'Unpaid' : b.payment_status === 'pending_verify' ? 'Verifying' : 'Paid'}</span>
        <span style="font-size:20px;color:var(--text-3)">›</span>
      </div>
    </div>
  </div>`;
}

function openBookingDetail(id) {
  const b = BOOKINGS.find(bk => bk.id === id);
  if (!b) return;
  const cat = CATEGORIES.find(c => c.id === b.categoryId);
  const sc = STATUS_CFG[b.status] || STATUS_CFG.pending;
  const date = new Date(b.created_at).toLocaleString('en-IN', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const TIMELINE = ['pending', 'confirmed', 'assigned', 'in_progress', 'completed'];
  const currIdx = b.status === 'cancelled' ? -1 : TIMELINE.indexOf(b.status);
  const canCancel = ['pending', 'confirmed'].includes(b.status);
  const canRate = b.status === 'completed' && !RATINGS[b.id];

  document.getElementById('bd-title').textContent = `#${b.id}`;
  document.getElementById('bd-date').textContent = date;

  document.getElementById('booking-detail-content').innerHTML = `
    <div class="section-card">
      <div class="section-card-title"><span>Status</span><span class="badge badge-${b.status}">${sc.label}</span></div>
      ${b.status === 'cancelled' ? `<div style="background:#FEF2F2;border-radius:var(--r-md);padding:12px;font-size:13px;color:var(--error)">🚫 This booking was cancelled.</div>` : `
        <div class="timeline">${TIMELINE.map((step, i) => {
          const scfg = STATUS_CFG[step]; const done = i <= currIdx; const curr = i === currIdx;
          return `<div class="tl-item"><div class="tl-left"><div class="tl-dot ${done ? 'done' : curr ? 'current' : ''}">${done ? '✓' : ''}</div>${i < TIMELINE.length - 1 ? `<div class="tl-line ${done && i < currIdx ? 'done' : ''}"></div>` : ''}</div><div class="tl-right"><div class="tl-label ${curr ? 'active' : ''}">${scfg.label}</div></div></div>`;
        }).join('')}</div>`}
      ${b.assigned_worker_name ? `<div style="background:var(--primary-light);border-radius:var(--r-md);padding:12px;display:flex;gap:10px;align-items:center;margin-top:12px"><span style="font-size:24px">👷</span><div><div style="font-size:11px;color:var(--text-2);font-weight:600">Assigned Worker</div><div style="font-size:15px;font-weight:700">${b.assigned_worker_name}</div>${b.assigned_worker_phone ? `<div style="font-size:13px;color:var(--text-2)">${b.assigned_worker_phone}</div>` : ''}</div></div>` : ''}
    </div>
    <div class="section-card"><div class="section-card-title">Service Details</div>
      <div class="detail-row"><span class="dl">Service</span><span class="dv">${b.serviceName}</span></div>
      <div class="detail-row"><span class="dl">Category</span><span class="dv">${cat?.name || ''}</span></div>
      ${b.final_price ? `<div class="detail-row"><span class="dl">Amount</span><span class="dv" style="color:var(--primary);font-weight:800">₹${b.final_price.toLocaleString('en-IN')}</span></div>` : ''}
      ${b.discount > 0 ? `<div class="detail-row"><span class="dl">Discount</span><span class="dv" style="color:var(--success)">-₹${b.discount} (${b.promo_code})</span></div>` : ''}
    </div>
    <div class="section-card"><div class="section-card-title">Address</div>
      <p style="font-size:14px;line-height:1.7;margin-bottom:8px">${b.address_line1}${b.address_line2 ? ', ' + b.address_line2 : ''}<br>${b.address_city} — ${b.address_pincode}</p>
      <div class="detail-row"><span class="dl">Contact</span><span class="dv">${b.contact_phone}</span></div>
    </div>
    ${b.preferred_date ? `<div class="section-card"><div class="section-card-title">Schedule</div>
      <div class="detail-row"><span class="dl">Date</span><span class="dv">${b.preferred_date}</span></div>
      <div class="detail-row"><span class="dl">Time</span><span class="dv">${b.preferred_time}</span></div>
    </div>` : ''}
    ${b.problem_description ? `<div class="section-card"><div class="section-card-title">Problem Description</div><p style="font-size:14px;color:var(--text-2);line-height:1.6">${b.problem_description}</p></div>` : ''}
    <div class="section-card"><div class="section-card-title"><span>Payment</span><span class="badge badge-${b.payment_status}">${b.payment_status === 'unpaid' ? 'Unpaid' : b.payment_status === 'pending_verify' ? 'Verifying' : 'Paid'}</span></div>
      <div class="detail-row"><span class="dl">Method</span><span class="dv">${b.payment_method === 'pay_before' ? 'Pay Before Service' : 'Pay After Service'}</span></div>
    </div>
    ${RATINGS[b.id] ? `<div class="section-card" style="background:#FFFBEB"><div class="section-card-title">Your Review</div><div style="font-size:20px;margin-bottom:4px">${'⭐'.repeat(RATINGS[b.id].rating)}</div><p style="font-size:13px;color:var(--text-2)">${RATINGS[b.id].comment || 'No comment'}</p></div>` : ''}
    ${b.admin_notes ? `<div class="section-card" style="background:#EFF6FF;border-left:3px solid var(--info)"><div style="font-size:12px;font-weight:700;color:var(--info);margin-bottom:4px">Note from our team</div><p style="font-size:13px;color:var(--text-2)">${b.admin_notes}</p></div>` : ''}
    <div class="section-card"><div class="section-card-title">Need help?</div>
      <div style="display:flex;gap:10px;margin-bottom:${canCancel || canRate || b.status === 'completed' ? '12px' : '0'}">
        <button class="btn btn-outline" style="flex:1" onclick="callSupport()">📞 Call Us</button>
        <button class="btn" style="flex:1;background:var(--primary-light);color:var(--primary)" onclick="openWhatsApp()">💬 WhatsApp</button>
      </div>
      ${canRate ? `<button class="btn btn-success" style="margin-bottom:10px" onclick="openRatingModal('${b.id}')">⭐ Rate This Service</button>` : ''}
      ${b.status === 'completed' ? `<button class="btn btn-outline" style="margin-bottom:10px" onclick="openInvoice('${b.id}')">🧾 View Invoice</button>` : ''}
      ${canCancel ? `<button class="btn btn-danger" onclick="cancelBooking('${b.id}')">Cancel Booking</button>` : ''}
    </div>`;

  showScreen('booking-detail');
}

function cancelBooking(id) {
  if (!confirm('Are you sure you want to cancel this booking?')) return;
  const idx = BOOKINGS.findIndex(b => b.id === id);
  if (idx === -1) return;
  BOOKINGS[idx].status = 'cancelled';
  BOOKINGS[idx].cancelled_at = new Date().toISOString();
  localStorage.setItem('hh_bookings', JSON.stringify(BOOKINGS));
  openBookingDetail(id);
  toast('Booking cancelled');
}

// ── RATINGS ───────────────────────────────────────────────────
function openRatingModal(bookingId) {
  S.currentRatingBookingId = bookingId;
  S.selectedRating = 0;
  document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
  document.getElementById('rating-comment').value = '';
  document.getElementById('rating-label').textContent = '';
  openModal('rating-modal');
}

function setRating(val) {
  S.selectedRating = val;
  const labels = ['', 'Poor 😞', 'Fair 😐', 'Good 🙂', 'Very Good 😊', 'Excellent 🤩'];
  document.getElementById('rating-label').textContent = labels[val];
  document.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('active', i < val));
}

function submitRating() {
  if (!S.selectedRating) { toast('Please select a rating'); return; }
  const b = BOOKINGS.find(bk => bk.id === S.currentRatingBookingId);
  RATINGS[S.currentRatingBookingId] = {
    bookingId: S.currentRatingBookingId,
    serviceId: b?.serviceId,
    rating: S.selectedRating,
    comment: document.getElementById('rating-comment').value.trim(),
    date: new Date().toISOString()
  };
  localStorage.setItem('hh_ratings', JSON.stringify(RATINGS));
  closeModal('rating-modal');
  toast('Thank you for your review! ⭐');
  openBookingDetail(S.currentRatingBookingId);
}

// ── INVOICE ───────────────────────────────────────────────────
function openInvoice(bookingId) {
  const b = BOOKINGS.find(bk => bk.id === bookingId);
  if (!b) return;
  const date = new Date(b.created_at).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'});
  document.getElementById('invoice-content').innerHTML = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:36px;margin-bottom:6px">🏠</div>
      <h2 style="font-size:20px;font-weight:900">${S.settings.business_name}</h2>
      <p style="font-size:13px;color:var(--text-2)">Tax Invoice</p>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:20px">
      <div><p style="font-size:12px;color:var(--text-2)">INVOICE #</p><p style="font-size:14px;font-weight:700">${b.id}</p></div>
      <div style="text-align:right"><p style="font-size:12px;color:var(--text-2)">DATE</p><p style="font-size:14px;font-weight:700">${date}</p></div>
    </div>
    <div style="background:var(--surface-alt);border-radius:var(--r-md);padding:14px;margin-bottom:16px">
      <p style="font-size:12px;color:var(--text-2);margin-bottom:4px">BILL TO</p>
      <p style="font-size:14px;font-weight:700">${S.user.name}</p>
      <p style="font-size:13px;color:var(--text-2)">${b.contact_phone}</p>
      <p style="font-size:13px;color:var(--text-2)">${b.address_line1}, ${b.address_city}</p>
    </div>
    <div style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:12px 0;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600">${b.serviceName}</span>
        <span style="font-size:13px">₹${(SERVICES.find(s=>s.id===b.serviceId)?.price||0).toLocaleString('en-IN')}</span>
      </div>
      ${b.discount > 0 ? `<div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;color:var(--success)">Discount (${b.promo_code})</span>
        <span style="font-size:13px;color:var(--success)">-₹${b.discount}</span>
      </div>` : ''}
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="font-size:15px;font-weight:800">Total</span>
      <span style="font-size:18px;font-weight:900;color:var(--primary)">₹${(b.final_price||0).toLocaleString('en-IN')}</span>
    </div>
    <button class="btn btn-whatsapp" onclick="shareInvoice('${b.id}')">📤 Share via WhatsApp</button>
    <p style="font-size:11px;color:var(--text-3);text-align:center;margin-top:12px">Thank you for choosing ${S.settings.business_name}!</p>`;
  openModal('invoice-modal');
}

function shareInvoice(bookingId) {
  const b = BOOKINGS.find(bk => bk.id === bookingId);
  if (!b) return;
  const msg = `🧾 *Invoice from ${S.settings.business_name}*\n\nBooking ID: #${b.id}\nService: ${b.serviceName}\nAmount: ₹${(b.final_price||0).toLocaleString('en-IN')}\nStatus: ${STATUS_CFG[b.status].label}\n\nThank you for your business! 🏠`;
  window.open(`https://wa.me/${S.settings.support_whatsapp.replace('+','')}?text=${encodeURIComponent(msg)}`);
}

// ── PROFILE ───────────────────────────────────────────────────
function renderProfile() {
  if (!S.user) return;
  const initials = S.user.name.split(' ').map(n => n[0].toUpperCase()).slice(0, 2).join('');
  document.getElementById('profile-avatar-display').textContent = initials;
  document.getElementById('profile-name-display').textContent = S.user.name;
  document.getElementById('profile-phone-display').textContent = S.user.phone;
  document.getElementById('profile-email-display').textContent = S.user.email || '';
  document.getElementById('support-phone-display').textContent = S.settings.support_phone;
}

function saveProfile() {
  const name = document.getElementById('edit-name').value.trim();
  if (!name) { toast('Name cannot be empty'); return; }
  S.user.name = name;
  S.user.email = document.getElementById('edit-email').value.trim();
  localStorage.setItem('hh_name', name);
  localStorage.setItem('hh_email', S.user.email);
  closeModal('edit-profile-modal');
  renderProfile(); renderHome();
  toast('Profile updated ✓');
}

// ── SAVED ADDRESSES ───────────────────────────────────────────
function showSavedAddresses() {
  renderAddressesList();
  openModal('addresses-modal');
}

function renderAddressesList() {
  document.getElementById('addresses-list').innerHTML = SAVED_ADDRESSES.length
    ? SAVED_ADDRESSES.map((a, i) => `
      <div style="border:1.5px solid var(--border);border-radius:var(--r-md);padding:12px;margin-bottom:8px;display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1"><div style="font-size:13px;font-weight:700;margin-bottom:2px">${a.label}</div>
        <div style="font-size:12px;color:var(--text-2)">${a.line1}${a.line2 ? ', ' + a.line2 : ''}, ${a.city} — ${a.pincode}</div></div>
        <button onclick="deleteAddress(${i})" style="background:none;border:none;color:var(--error);font-size:18px;cursor:pointer;padding:0">🗑️</button>
      </div>`).join('')
    : `<p style="color:var(--text-2);text-align:center;padding:20px">No saved addresses yet.</p>`;
}

function deleteAddress(i) {
  SAVED_ADDRESSES.splice(i, 1);
  localStorage.setItem('hh_addresses', JSON.stringify(SAVED_ADDRESSES));
  renderAddressesList();
  toast('Address deleted');
}

function saveNewAddress() {
  const line1 = document.getElementById('new-addr-line1').value.trim();
  const city = document.getElementById('new-addr-city').value.trim();
  const pin = document.getElementById('new-addr-pin').value;
  if (!line1 || !city) { toast('Please fill in required fields'); return; }
  if (!/^\d{6}$/.test(pin)) { toast('Invalid PIN code'); return; }
  SAVED_ADDRESSES.push({
    label: document.getElementById('new-addr-label').value || 'Home',
    line1, line2: document.getElementById('new-addr-line2').value, city, pincode: pin
  });
  localStorage.setItem('hh_addresses', JSON.stringify(SAVED_ADDRESSES));
  closeModal('add-address-modal');
  toast('Address saved ✓');
}

// ── SUPPORT ───────────────────────────────────────────────────
function callSupport() { window.open('tel:' + S.settings.support_phone); }
function openWhatsApp(msg) {
  const phone = S.settings.support_whatsapp.replace('+', '');
  const text = msg || 'Hello! I need help with House Helper services.';
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`);
}

// ── VERSION TAP → ADMIN ───────────────────────────────────────
function versionTap() {
  S.versionTaps++;
  if (S.versionTimer) clearTimeout(S.versionTimer);
  S.versionTimer = setTimeout(() => { S.versionTaps = 0; }, 2000);
  if (S.versionTaps >= 5) {
    S.versionTaps = 0;
    toast('House Helper v2.0 · Admin: open admin.html');
  }
}

// ── SERVICE WORKER ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Re-check for a newer sw.js whenever the app regains focus —
      // covers the "reopened an installed mobile PWA" case.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});

    // When a new service worker takes control, the page it controls is
    // running on stale assets fetched before the update — reload once so
    // the person always sees the latest version automatically, with no
    // manual hard refresh required.
    let hasReloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hasReloadedForUpdate) return;
      hasReloadedForUpdate = true;
      window.location.reload();
    });
  });
}

// ── INIT ──────────────────────────────────────────────────────
function hideAppLoadingGate() {
  const gate = document.getElementById('app-loading-gate');
  if (gate) gate.style.display = 'none';
}

function restoreCustomerSession() {
  const savedName = localStorage.getItem('hh_name');
  if (savedName) {
    const savedPhone = localStorage.getItem('hh_phone');
    S.user = {
      name: savedName,
      phone: savedPhone ? '+91' + savedPhone : '+91XXXXXXXXXX',
      email: localStorage.getItem('hh_email') || '',
      role: 'customer'
    };
    BOOKINGS = JSON.parse(localStorage.getItem('hh_bookings') || '[]');
    SAVED_ADDRESSES = JSON.parse(localStorage.getItem('hh_addresses') || '[]');
    RATINGS = JSON.parse(localStorage.getItem('hh_ratings') || '{}');
    renderHome();
    showScreen('home');
    syncCatalogFromSupabase();
  }
  // No saved customer session either — default screen (login) stays as-is from markup.
}

window.addEventListener('DOMContentLoaded', () => {
  // Init native Android features (back button, safe area, transitions, etc.)
  if (typeof initNative === 'function') initNative();

  // Init analytics (no user yet — set after login)
  if (typeof Analytics !== 'undefined' && sb) Analytics.init(sb, null);
  if (typeof Analytics !== 'undefined') Analytics.appOpened();
  renderAllLogoSlots(); // show animated default logo immediately
  loadBrandSettings();  // then swap in admin's custom logo if one is set
  subscribeToCatalogRealtime(); // live-sync services/categories across all clients

  // Restore customer session.
  restoreCustomerSession();
  hideAppLoadingGate();
});
