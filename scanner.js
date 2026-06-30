// scanner.js - Barcode scanner tuned for warehouse bin labels.
//
// Works on BOTH platforms:
//   • Android / Chrome / Edge → uses the browser's built-in BarcodeDetector (fast).
//   • iPhone Safari / Firefox / others → falls back to the ZXing library (loaded on demand).
//
// Reliability features (so it reads small / sideways / crowded labels correctly):
//   • Region of interest - only the centered aim box is decoded, so a neighbouring bin's
//     barcode can't be picked up by mistake. Aim the box at the barcode itself.
//   • Rotation - each pass also tries a 90°-rotated decode, so sideways barcodes read.
//   • Confirmation - the same value must be read twice in a row before it's accepted,
//     which kills the occasional misread / "wrong number".
//   • High capture resolution + optional torch and zoom controls for small / dim labels.
//
// Export:
//   scanBarcode() → opens a fullscreen scanner. Resolves { code, frame } or null (cancelled).
//                   `frame` is a full-resolution JPEG data URL of the moment the code was read
//                   (used as the image for Claude Vision when a part isn't in the catalog).

const ZXING_CDN = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';

// 1-D symbologies used on inventory labels (Code 128 is what yours use). Dropping 2-D/QR
// avoids decorative patterns being misread as codes.
const NATIVE_FORMATS = ['code_128', 'code_39', 'code_93', 'itf', 'ean_13', 'ean_8', 'upc_a', 'upc_e'];

const ROI_FRAC = 0.7;        // fraction of the short edge the aim box covers
const DECODE_MAX = 1100;     // cap the decode canvas size for speed
const DECODE_EVERY_MS = 110; // throttle decode attempts
const CONFIRMATIONS = 2;     // identical reads required before accepting

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

// Full-resolution still of the current frame (used for Claude Vision fallback).
function grabFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c.toDataURL('image/jpeg', 0.9);
}

export function scanBarcode() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'scanner-overlay';
    overlay.innerHTML = `
      <video class="scanner-video" autoplay playsinline muted></video>
      <div class="scanner-frame"><div class="scanner-laser"></div></div>
      <div class="scanner-hint">Aim the box at the barcode</div>
      <div class="scanner-controls">
        <button class="scanner-ctl" id="scanner-torch" type="button" hidden>Light</button>
        <input class="scanner-zoom" id="scanner-zoom" type="range" hidden>
      </div>
      <button class="scanner-cancel" type="button">✕ Cancel</button>`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('.scanner-video');
    const hint = overlay.querySelector('.scanner-hint');

    let stream = null, rafId = null, done = false;
    let detector = null, zxing = null, zxingReader = null, zxingHints = null;
    let lastDecodeAt = 0, lastValue = null, confirmCount = 0;

    const roiCanvas = document.createElement('canvas');
    const rotCanvas = document.createElement('canvas');

    function cleanup(result) {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach(t => t.stop());
      overlay.remove();
      resolve(result);
    }
    overlay.querySelector('.scanner-cancel').addEventListener('click', () => cleanup(null));

    // Accept a value only after it repeats - a misread rarely repeats identically.
    function consider(value) {
      if (!value) return;
      if (value === lastValue) confirmCount++;
      else { lastValue = value; confirmCount = 1; }
      if (confirmCount >= CONFIRMATIONS) cleanup({ code: value, frame: grabFrame(video) });
    }

    // Draw the centered region of interest into a canvas (optionally rotated 90°).
    function drawROI() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const side = Math.floor(Math.min(vw, vh) * ROI_FRAC);
      const sx = Math.floor((vw - side) / 2), sy = Math.floor((vh - side) / 2);
      const scale = Math.min(1, DECODE_MAX / side);
      const cw = Math.max(1, Math.round(side * scale));
      roiCanvas.width = cw; roiCanvas.height = cw;
      roiCanvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, cw, cw);
      return roiCanvas;
    }
    function rotate90(src) {
      rotCanvas.width = src.height; rotCanvas.height = src.width;
      const ctx = rotCanvas.getContext('2d');
      ctx.save();
      ctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
      ctx.restore();
      return rotCanvas;
    }

    function decodeZXing(canvas) {
      try {
        const src = new zxing.HTMLCanvasElementLuminanceSource(canvas);
        const bmp = new zxing.BinaryBitmap(new zxing.HybridBinarizer(src));
        return zxingReader.decode(bmp, zxingHints).getText();
      } catch (e) { return null; }
    }

    async function tick(now) {
      if (done) return;
      if (!now || now - lastDecodeAt >= DECODE_EVERY_MS) {
        lastDecodeAt = now || 0;
        const roi = drawROI();
        if (roi) {
          if (detector) {
            // Native detector handles rotation internally.
            try {
              const codes = await detector.detect(roi);
              if (codes && codes.length) consider(codes[0].rawValue);
            } catch (e) { /* transient */ }
          } else if (zxing) {
            let v = decodeZXing(roi);
            if (!v) v = decodeZXing(rotate90(roi)); // sideways barcodes
            consider(v);
          }
        }
      }
      if (!done) rafId = requestAnimationFrame(tick);
    }

    function setupCameraControls() {
      const track = stream.getVideoTracks()[0];
      if (!track) return;

      // Try autofocus via applyConstraints regardless of what getCapabilities reports —
      // some Android browsers under-report focus capabilities.
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});

      // Show torch button optimistically; hide it only if the constraint actually fails.
      const torchBtn = overlay.querySelector('#scanner-torch');
      torchBtn.hidden = false;
      let torchOn = false;
      torchBtn.addEventListener('click', () => {
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).then(() => {
          torchBtn.classList.toggle('active', torchOn);
        }).catch(() => {
          // Constraint rejected — toggle back but keep button visible.
          torchOn = !torchOn;
          torchBtn.textContent = 'Light (N/A)';
        });
      });

      // Zoom slider — only show when the device reports zoom support.
      if (track.getCapabilities) {
        let caps = {};
        try { caps = track.getCapabilities(); } catch (e) {}
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          const slider = overlay.querySelector('#scanner-zoom');
          slider.hidden = false;
          slider.min = caps.zoom.min; slider.max = caps.zoom.max;
          slider.step = caps.zoom.step || 0.1; slider.value = track.getSettings().zoom || caps.zoom.min;
          slider.addEventListener('input', () => {
            track.applyConstraints({ advanced: [{ zoom: parseFloat(slider.value) }] }).catch(() => {});
          });
        }
      }
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
        // Let the camera settle before reading capabilities
        await new Promise(r => setTimeout(r, 600));
        setupCameraControls();
      } catch (e) {
        hint.textContent = 'Camera unavailable, check permissions';
        setTimeout(() => cleanup(null), 1800);
        return;
      }

      if ('BarcodeDetector' in window) {
        try {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const formats = NATIVE_FORMATS.filter(f => supported.includes(f));
          detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);
        } catch (e) { detector = null; }
      }

      if (!detector) {
        try {
          zxing = await loadScript(ZXING_CDN, 'ZXing');
          zxingReader = new zxing.MultiFormatReader();
          zxingHints = new Map();
          zxingHints.set(zxing.DecodeHintType.TRY_HARDER, true);
          zxingHints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [
            zxing.BarcodeFormat.CODE_128, zxing.BarcodeFormat.CODE_39, zxing.BarcodeFormat.CODE_93,
            zxing.BarcodeFormat.ITF, zxing.BarcodeFormat.EAN_13, zxing.BarcodeFormat.EAN_8,
            zxing.BarcodeFormat.UPC_A, zxing.BarcodeFormat.UPC_E,
          ]);
        } catch (e) {
          hint.textContent = 'Scanner failed to load';
          setTimeout(() => cleanup(null), 1800);
          return;
        }
      }

      rafId = requestAnimationFrame(tick);
    })();
  });
}
