// scanner.js — Barcode scanner.
//
// Works on BOTH platforms:
//   • Android / Chrome / Edge → uses the browser's built-in BarcodeDetector (fast, no download).
//   • iPhone Safari / Firefox / older browsers → falls back to the ZXing library (loaded on demand).
//
// The barcode is read from the WHOLE camera frame — it does not need to be centered. The on-screen
// box is just an aiming guide; a barcode anywhere in view will be picked up.
//
// Exports:
//   scanBarcode() → opens a fullscreen camera scanner. Resolves { code, frame } or null (cancelled).
//                   `frame` is a full-resolution JPEG data URL of the moment the code was read
//                   (used as the image for Claude Vision when a part isn't in the catalog).

// Pinned CDN build of the ZXing barcode library (iPhone / Firefox fallback path).
const ZXING_CDN = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';

// Barcode symbologies we try to read. Your label is Code 128, but we accept the common ones too.
const FORMATS = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];

// ── Lazy script loaders ──────────────────────────────────────────────────────
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(globalName + ' did not load'));
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// ── Grab the current video frame as a JPEG data URL ──────────────────────────
function grabFrame(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// ── Main: open the scanner overlay ───────────────────────────────────────────
export function scanBarcode() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = `
      <video class="scanner-video" autoplay playsinline muted></video>
      <div class="scanner-frame"><div class="scanner-laser"></div></div>
      <div class="scanner-hint">Aim at the label — the barcode can be anywhere in view</div>
      <button class="scanner-cancel" type="button">✕ Cancel</button>`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('.scanner-video');
    const hint = overlay.querySelector('.scanner-hint');

    let stream = null, zxingReader = null, rafId = null, done = false;

    function cleanup(result) {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (zxingReader) { try { zxingReader.reset(); } catch (e) {} }
      if (stream) stream.getTracks().forEach(t => t.stop());
      overlay.remove();
      resolve(result);
    }

    overlay.querySelector('.scanner-cancel').addEventListener('click', () => cleanup(null));

    (async () => {
      // ── Path 1: native BarcodeDetector (Android Chrome/Edge etc.) ──
      if ('BarcodeDetector' in window) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
          });
          video.srcObject = stream;
          await video.play();

          const supported = await window.BarcodeDetector.getSupportedFormats();
          const formats = FORMATS.filter(f => supported.includes(f));
          const detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);

          const tick = async () => {
            if (done) return;
            try {
              const codes = await detector.detect(video);
              if (codes && codes.length) { cleanup({ code: codes[0].rawValue, frame: grabFrame(video) }); return; }
            } catch (e) { /* transient — keep scanning */ }
            rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
          return;
        } catch (e) {
          // Native path unavailable/failed — release and fall through to ZXing.
          if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        }
      }

      // ── Path 2: ZXing fallback (iPhone Safari, Firefox, desktop without BarcodeDetector) ──
      try {
        const ZXing = await loadScript(ZXING_CDN, 'ZXing');
        zxingReader = new ZXing.BrowserMultiFormatReader();
        await zxingReader.decodeFromConstraints(
          { video: { facingMode: 'environment' }, audio: false },
          video,
          (res) => { if (res && !done) cleanup({ code: res.getText(), frame: grabFrame(video) }); }
        );
      } catch (e) {
        hint.textContent = 'Camera unavailable — check permissions';
        setTimeout(() => cleanup(null), 1800);
      }
    })();
  });
}
