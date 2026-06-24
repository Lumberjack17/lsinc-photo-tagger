import {
  getAllParts, createPart, updatePart, deletePart, addPhotoToPart, deletePartPhoto, updatePartPhoto,
  reorderPhotos, signInWithGoogle, signOut, getSession, isEmailApproved, approveEmail, validateInviteKey, onAuthStateChange,
} from './supabase.js';
import { PhotoEditor } from './editor.js';

const PRINTERS = ['PeriOne', 'PeriQ360', 'Perivallo360m', 'PeriH'];

// ── State ──────────────────────────────────────────────────────────────────
let allParts = [];
let currentPart = null;
let capturedImageDataUrl = null;
let targetPartId = null;
let activePrinterFilter = null;
let isAuthorized = false;
let currentEditingPhoto = null;

// ── Auth ───────────────────────────────────────────────────────────────────
function updateAuthUI() {
  document.getElementById('btn-open-camera').hidden = !isAuthorized;
  document.getElementById('btn-login').hidden = isAuthorized;
  document.getElementById('btn-logout').hidden = !isAuthorized;
  document.getElementById('btn-detail-add-photo').hidden = !isAuthorized;
  document.getElementById('btn-detail-edit').hidden = !isAuthorized;
  document.getElementById('btn-detail-delete').hidden = !isAuthorized;
}

async function handleSession(session) {
  if (!session) {
    isAuthorized = false;
    updateAuthUI();
    return;
  }
  if (localStorage.getItem('photo_tagger_pending_approval') === '1') {
    localStorage.removeItem('photo_tagger_pending_approval');
    try {
      await approveEmail(session.user.email);
    } catch (err) {
      console.error('Approval error:', err);
    }
  }
  isAuthorized = await isEmailApproved(session.user.email);
  const badge = document.getElementById('auth-badge');
  badge.textContent = session.user.email;
  badge.hidden = !isAuthorized;
  updateAuthUI();
}

// Login modal
document.getElementById('btn-login').addEventListener('click', () => {
  document.getElementById('modal-login').hidden = false;
});
document.getElementById('btn-login-cancel').addEventListener('click', () => {
  document.getElementById('modal-login').hidden = true;
});
document.getElementById('btn-google-signin').addEventListener('click', async () => {
  try { await signInWithGoogle(); }
  catch (err) { alert('Sign in failed: ' + err.message); }
});
document.getElementById('btn-register-google').addEventListener('click', async () => {
  const key = document.getElementById('input-invite-key').value.trim();
  if (!key) { alert('Enter the invite key.'); return; }
  if (!validateInviteKey(key)) {
    alert('Incorrect invite key. Contact your admin.');
    return;
  }
  localStorage.setItem('photo_tagger_pending_approval', '1');
  try { await signInWithGoogle(); }
  catch (err) {
    localStorage.removeItem('photo_tagger_pending_approval');
    alert('Sign in failed: ' + err.message);
  }
});
document.getElementById('btn-logout').addEventListener('click', async () => {
  await signOut();
  isAuthorized = false;
  document.getElementById('auth-badge').hidden = true;
  updateAuthUI();
});

// ── View routing ───────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.getElementById(id).hidden = false;
}

// ── Printer checkbox helpers ───────────────────────────────────────────────
function renderPrinterCheckboxes(containerId, selected = []) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  PRINTERS.forEach(p => {
    const label = document.createElement('label');
    label.className = 'printer-option';
    label.innerHTML = `<input type="checkbox" value="${p}" ${selected.includes(p) ? 'checked' : ''}><span>${p}</span>`;
    el.appendChild(label);
  });
}

function getCheckedPrinters(containerId) {
  return [...document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)].map(cb => cb.value);
}

// ── Camera ─────────────────────────────────────────────────────────────────
function showCaptureChoice() {
  document.getElementById('capture-choice').hidden = false;
  document.getElementById('camera-feed').hidden = true;
  document.getElementById('capture-actions').hidden = true;
}

function showCaptureView() {
  showView('view-capture');
  showCaptureChoice();
}

async function startCameraFeed() {
  const video = document.getElementById('camera-feed');
  document.getElementById('capture-choice').hidden = true;
  video.hidden = false;
  document.getElementById('capture-actions').hidden = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    video.play();
  } catch (err) {
    // Camera denied — go back to choice screen
    showCaptureChoice();
  }
}

function stopCamera() {
  const video = document.getElementById('camera-feed');
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
}

document.getElementById('btn-open-camera').addEventListener('click', () => {
  targetPartId = null;
  showCaptureView();
});

document.getElementById('btn-start-camera').addEventListener('click', () => startCameraFeed());

document.getElementById('btn-cancel-capture').addEventListener('click', () => {
  targetPartId = null;
  showView(currentPart ? 'view-part-detail' : 'view-gallery');
});

document.getElementById('btn-stop-camera').addEventListener('click', () => {
  stopCamera();
  showCaptureChoice();
});

document.getElementById('btn-capture').addEventListener('click', () => {
  const video = document.getElementById('camera-feed');

  // Crop to what's visible on screen (match object-fit: cover)
  const displayW = video.clientWidth;
  const displayH = video.clientHeight;
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  const displayRatio = displayW / displayH;

  let cropW, cropH, cropX, cropY;
  if (videoW / videoH > displayRatio) {
    // Video wider than display — crop the sides
    cropH = videoH;
    cropW = videoH * displayRatio;
    cropX = (videoW - cropW) / 2;
    cropY = 0;
  } else {
    // Video taller than display — crop top/bottom
    cropW = videoW;
    cropH = videoW / displayRatio;
    cropX = 0;
    cropY = (videoH - cropH) / 2;
  }

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  canvas.getContext('2d').drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  capturedImageDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  stopCamera();
  openPreview();
});

document.getElementById('btn-retake').addEventListener('click', () => { capturedImageDataUrl = null; startCameraFeed(); });

document.getElementById('btn-edit-photo').addEventListener('click', () => {
  if (!capturedImageDataUrl) return;
  new PhotoEditor({
    imageDataUrl: capturedImageDataUrl,
    onDone: result => { capturedImageDataUrl = result; openPreview(); },
    onCancel: () => openPreview(),
  });
});
document.getElementById('btn-cancel-preview').addEventListener('click', () => {
  capturedImageDataUrl = null;
  targetPartId = null;
  showView(currentPart ? 'view-part-detail' : 'view-gallery');
});

document.getElementById('btn-use-file').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { capturedImageDataUrl = ev.target.result; openPreview(); };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ── Preview form ───────────────────────────────────────────────────────────
function openPreview() {
  document.getElementById('preview-img').src = capturedImageDataUrl;
  document.getElementById('preview-machine-label').value = '';
  document.getElementById('select-position').value = 'bottom-left';

  if (targetPartId) {
    const part = allParts.find(p => p.id === targetPartId);
    document.getElementById('input-part-number').value = part.part_number;
    document.getElementById('input-part-number').readOnly = true;
    setNewPartFieldsVisible(false);
    document.getElementById('preview-existing-info').hidden = false;
    document.getElementById('preview-existing-name').textContent = part.part_number;
  } else {
    document.getElementById('input-part-number').value = '';
    document.getElementById('input-part-number').readOnly = false;
    setNewPartFieldsVisible(true);
    document.getElementById('preview-existing-info').hidden = true;
    renderPrinterCheckboxes('preview-printers');
    document.getElementById('input-description').value = '';
  }

  showView('view-preview');
}

function setNewPartFieldsVisible(visible) {
  document.getElementById('new-part-fields').hidden = !visible;
}

document.getElementById('input-part-number').addEventListener('input', e => {
  const val = e.target.value.trim().toLowerCase();
  const match = allParts.find(p => p.part_number.toLowerCase() === val);
  if (match) {
    targetPartId = match.id;
    setNewPartFieldsVisible(false);
    document.getElementById('preview-existing-info').hidden = false;
    document.getElementById('preview-existing-name').textContent = match.part_number;
  } else {
    targetPartId = null;
    setNewPartFieldsVisible(true);
    document.getElementById('preview-existing-info').hidden = true;
  }
});

document.getElementById('btn-burn-save').addEventListener('click', async () => {
  const partNumber = document.getElementById('input-part-number').value.trim();
  const machineLabel = document.getElementById('preview-machine-label').value.trim();
  const position = document.getElementById('select-position').value;

  if (!partNumber) { alert('Enter a part number.'); return; }
  if (!capturedImageDataUrl) { alert('No image captured.'); return; }

  const btn = document.getElementById('btn-burn-save');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    let partId = targetPartId;

    if (!partId) {
      const printers = getCheckedPrinters('preview-printers');
      const description = document.getElementById('input-description').value.trim();
      const part = await createPart({ part_number: partNumber, description, printers });
      partId = part.id;
    }

    await addPhotoToPart(partId, partNumber, {
      imageDataUrl: capturedImageDataUrl,
      machine_label: machineLabel,
      position,
    });

    capturedImageDataUrl = null;
    targetPartId = null;

    await loadGallery();

    if (currentPart) {
      currentPart = allParts.find(p => p.id === currentPart.id);
      renderPartDetail();
      showView('view-part-detail');
    } else {
      showView('view-gallery');
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.textContent = 'Burn & Save'; btn.disabled = false;
  }
});

// ── Gallery ────────────────────────────────────────────────────────────────
async function loadGallery() {
  allParts = await getAllParts();
  renderFilterBar();
  applyFilters();
}

function renderFilterBar() {
  const bar = document.getElementById('printer-filter-bar');
  bar.innerHTML = '';
  const chips = [{ label: 'All', value: null }, ...PRINTERS.map(p => ({ label: p, value: p }))];
  chips.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.className = 'filter-chip' + (activePrinterFilter === value ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { activePrinterFilter = value; applyFilters(); });
    bar.appendChild(btn);
  });
}

function applyFilters() {
  const q = document.getElementById('input-search').value.toLowerCase();
  let filtered = allParts;
  if (activePrinterFilter) filtered = filtered.filter(p => p.printers?.includes(activePrinterFilter));
  if (q) filtered = filtered.filter(p =>
    p.part_number.toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q) ||
    p.printers?.some(pr => pr.toLowerCase().includes(q))
  );
  renderGallery(filtered);
  renderFilterBar();
  const dl = document.getElementById('part-number-list');
  dl.innerHTML = allParts.map(p => `<option value="${escHtml(p.part_number)}">`).join('');
}

function renderGallery(parts) {
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  grid.innerHTML = '';
  if (!parts.length) { empty.hidden = false; return; }
  empty.hidden = true;

  parts.forEach(part => {
    const thumb = part.photos[0]?.image_url || '';
    const count = part.photos.length;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-img-wrap">
        ${thumb ? `<img src="${thumb}" loading="lazy" alt="Part photo">` : '<div class="card-no-img">No photos</div>'}
        <div class="card-img-overlay">View ${count} photo${count !== 1 ? 's' : ''}</div>
        ${count > 1 ? `<span class="photo-count">${count}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="part-number-label">${escHtml(part.part_number)}</div>
        ${part.printers?.length ? `<div class="printer-list">${part.printers.map(p => `<span class="printer-badge">${escHtml(p)}</span>`).join('')}</div>` : ''}
        ${part.description ? `<p class="desc">${escHtml(part.description)}</p>` : ''}
      </div>`;
    card.addEventListener('click', () => openPartDetail(part));
    grid.appendChild(card);
  });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Part Detail ────────────────────────────────────────────────────────────
function openPartDetail(part) {
  currentPart = part;
  renderPartDetail();
  showView('view-part-detail');
}

function renderPartDetail() {
  const part = currentPart;
  document.getElementById('detail-part-number').textContent = part.part_number;
  document.getElementById('detail-description').textContent = part.description || '';
  document.getElementById('detail-description').hidden = !part.description;

  const printerEl = document.getElementById('detail-printers');
  printerEl.innerHTML = (part.printers || []).map(p => `<span class="printer-badge">${escHtml(p)}</span>`).join('');

  const grid = document.getElementById('detail-photos-grid');
  grid.innerHTML = '';

  if (!part.photos.length) {
    grid.innerHTML = '<p class="no-photos-msg">No photos yet. Add one below.</p>';
    return;
  }

  part.photos.forEach(photo => {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.innerHTML = `
      <div class="photo-card-img-wrap">
        <img src="${photo.image_url}" loading="lazy" alt="Part photo">
        <div class="card-img-overlay">🔍 Preview</div>
      </div>
      ${photo.machine_label ? `<div class="photo-machine-label">${escHtml(photo.machine_label)}</div>` : ''}
      ${isAuthorized ? `<div class="photo-card-actions">
        <button class="btn-sm btn-photo-up" data-id="${photo.id}" title="Move left">◀</button>
        <button class="btn-sm btn-photo-down" data-id="${photo.id}" title="Move right">▶</button>
        <button class="btn-sm btn-edit-existing-photo" data-id="${photo.id}">Edit</button>
        <button class="btn-sm btn-edit-photo-label" data-id="${photo.id}">Label</button>
        <button class="btn-sm danger btn-delete-photo" data-id="${photo.id}">Delete</button>
      </div>` : ''}`;
    card.querySelector('.photo-card-img-wrap').addEventListener('click', () => openLightbox(photo.image_url));
    if (isAuthorized) {
      card.querySelector('.btn-delete-photo').addEventListener('click', () => confirmDeletePhoto(photo.id));
      card.querySelector('.btn-edit-existing-photo').addEventListener('click', () => editExistingPhoto(photo));
      card.querySelector('.btn-edit-photo-label').addEventListener('click', () => openEditPhotoLabel(photo));
      card.querySelector('.btn-photo-up').addEventListener('click', () => movePhoto(photo.id, -1));
      card.querySelector('.btn-photo-down').addEventListener('click', () => movePhoto(photo.id, 1));
    }
    grid.appendChild(card);
  });
}

document.getElementById('btn-back-gallery').addEventListener('click', () => {
  currentPart = null;
  showView('view-gallery');
});

document.getElementById('btn-detail-add-photo').addEventListener('click', () => {
  targetPartId = currentPart.id;
  showCaptureView();
});

document.getElementById('btn-detail-pdf').addEventListener('click', () => exportPdfForPart(currentPart));

document.getElementById('btn-detail-delete').addEventListener('click', async () => {
  if (!confirm(`Delete part "${currentPart.part_number}" and ALL its photos? This cannot be undone.`)) return;
  await deletePart(currentPart.id);
  currentPart = null;
  await loadGallery();
  showView('view-gallery');
});

document.getElementById('btn-detail-edit').addEventListener('click', () => {
  document.getElementById('edit-part-number').value = currentPart.part_number;
  document.getElementById('edit-part-description').value = currentPart.description || '';
  renderPrinterCheckboxes('edit-part-printers', currentPart.printers || []);
  document.getElementById('modal-edit-part').hidden = false;
});

document.getElementById('btn-edit-part-cancel').addEventListener('click', () => {
  document.getElementById('modal-edit-part').hidden = true;
});

document.getElementById('btn-edit-part-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-edit-part-save');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    await updatePart(currentPart.id, {
      description: document.getElementById('edit-part-description').value.trim(),
      printers: getCheckedPrinters('edit-part-printers'),
    });
    document.getElementById('modal-edit-part').hidden = true;
    await loadGallery();
    currentPart = allParts.find(p => p.id === currentPart.id);
    renderPartDetail();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.textContent = 'Save'; btn.disabled = false;
  }
});

async function confirmDeletePhoto(photoId) {
  if (!confirm('Delete this photo?')) return;
  await deletePartPhoto(photoId, currentPart.id);
  await loadGallery();
  currentPart = allParts.find(p => p.id === currentPart.id);
  renderPartDetail();
}

async function editExistingPhoto(photo) {
  const srcUrl = photo.original_url || photo.image_url;
  // Fetch the image as a data URL (needed for canvas editing due to CORS)
  const blob = await fetch(srcUrl).then(r => r.blob());
  const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.readAsDataURL(blob); });

  const partId = currentPart.id;
  const partNumber = currentPart.part_number;

  new PhotoEditor({
    imageDataUrl: dataUrl,
    onDone: async edited => {
      // Immediately swap the card image so the user sees changes right away
      const card = document.querySelector(`.btn-edit-existing-photo[data-id="${photo.id}"]`)?.closest('.photo-card');
      if (card) {
        const img = card.querySelector('img');
        if (img) img.src = edited;
        const btn = card.querySelector('.btn-edit-existing-photo');
        if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
      }
      try {
        await updatePartPhoto(photo.id, partId, partNumber, {
          imageDataUrl: edited,
          machine_label: photo.machine_label,
          position: photo.position || 'bottom-left',
        });
        await loadGallery();
        // Re-render part detail if still on that part (guard against back-navigation)
        if (currentPart?.id === partId) {
          currentPart = allParts.find(p => p.id === partId);
          renderPartDetail();
          showView('view-part-detail');
        }
      } catch (err) {
        alert('Save failed: ' + err.message);
        const btn = document.querySelector(`.btn-edit-existing-photo[data-id="${photo.id}"]`);
        if (btn) { btn.textContent = 'Edit'; btn.disabled = false; }
      }
    },
    onCancel: () => {},
  });
}

async function movePhoto(photoId, direction) {
  const photos = currentPart.photos;
  const idx = photos.findIndex(p => p.id === photoId);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= photos.length) return;

  // Swap in local state for instant re-render
  [photos[idx], photos[newIdx]] = [photos[newIdx], photos[idx]];
  renderPartDetail();

  // Persist new order to DB
  try {
    await reorderPhotos(photos.map(p => p.id));
    // Refresh gallery so cover image updates too
    await loadGallery();
    currentPart = allParts.find(p => p.id === currentPart.id);
    renderPartDetail();
  } catch (err) {
    alert('Reorder failed: ' + err.message);
  }
}

function openEditPhotoLabel(photo) {
  currentEditingPhoto = photo;
  document.getElementById('edit-photo-label-input').value = photo.machine_label || '';
  document.getElementById('edit-photo-position-select').value = photo.position || 'bottom-left';
  document.getElementById('modal-edit-photo-label').hidden = false;
}

document.getElementById('btn-edit-photo-label-cancel').addEventListener('click', () => {
  document.getElementById('modal-edit-photo-label').hidden = true;
  currentEditingPhoto = null;
});

document.getElementById('btn-edit-photo-label-save').addEventListener('click', async () => {
  const photo = currentEditingPhoto;
  if (!photo) return;
  const machine_label = document.getElementById('edit-photo-label-input').value.trim();
  const position = document.getElementById('edit-photo-position-select').value;
  const btn = document.getElementById('btn-edit-photo-label-save');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const srcUrl = photo.original_url || photo.image_url;
    const blob = await fetch(srcUrl).then(r => r.blob());
    const dataUrl = await new Promise(res => {
      const fr = new FileReader(); fr.onload = e => res(e.target.result); fr.readAsDataURL(blob);
    });
    await updatePartPhoto(photo.id, currentPart.id, currentPart.part_number, {
      imageDataUrl: dataUrl, machine_label, position,
    });
    document.getElementById('modal-edit-photo-label').hidden = true;
    currentEditingPhoto = null;
    await loadGallery();
    currentPart = allParts.find(p => p.id === currentPart.id);
    renderPartDetail();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.textContent = 'Burn & Save'; btn.disabled = false;
  }
});

// ── Lightbox ───────────────────────────────────────────────────────────────
let lbScale = 1, lbPanX = 0, lbPanY = 0, lbDragStart = null, lbPinchDist = 0;

function resetLightboxTransform() {
  lbScale = 1; lbPanX = 0; lbPanY = 0;
  applyLightboxTransform();
}

function applyLightboxTransform() {
  const img = document.getElementById('lightbox-img');
  img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbScale})`;
  img.style.cursor = lbScale > 1 ? 'grab' : 'zoom-in';
}

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('modal-lightbox').hidden = false;
  resetLightboxTransform();
}

// Scroll to zoom
document.getElementById('modal-lightbox').addEventListener('wheel', e => {
  e.preventDefault();
  lbScale = Math.min(Math.max(lbScale * (e.deltaY > 0 ? 0.85 : 1.15), 1), 6);
  if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
  applyLightboxTransform();
}, { passive: false });

// Mouse drag to pan
document.getElementById('lightbox-img').addEventListener('mousedown', e => {
  if (lbScale <= 1) return;
  e.preventDefault();
  lbDragStart = { x: e.clientX - lbPanX, y: e.clientY - lbPanY };
  e.currentTarget.style.cursor = 'grabbing';
});
document.addEventListener('mousemove', e => {
  if (!lbDragStart) return;
  lbPanX = e.clientX - lbDragStart.x;
  lbPanY = e.clientY - lbDragStart.y;
  applyLightboxTransform();
});
document.addEventListener('mouseup', () => {
  if (!lbDragStart) return;
  lbDragStart = null;
  if (lbScale > 1) document.getElementById('lightbox-img').style.cursor = 'grab';
});

// Pinch to zoom on mobile
document.getElementById('modal-lightbox').addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    lbPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }
}, { passive: true });
document.getElementById('modal-lightbox').addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  lbScale = Math.min(Math.max(lbScale * (dist / lbPinchDist), 1), 6);
  lbPinchDist = dist;
  if (lbScale === 1) { lbPanX = 0; lbPanY = 0; }
  applyLightboxTransform();
}, { passive: false });

document.getElementById('modal-lightbox').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.id === 'btn-lightbox-close') {
    document.getElementById('modal-lightbox').hidden = true;
    document.getElementById('lightbox-img').src = '';
    resetLightboxTransform();
  }
});

// ── PDF ────────────────────────────────────────────────────────────────────
async function exportPdfForPart(part) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  await renderPartPage(doc, part, false);
  doc.save(`${part.part_number}.pdf`);
}

document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  const parts = activePrinterFilter
    ? allParts.filter(p => p.printers?.includes(activePrinterFilter))
    : allParts;
  if (!parts.length) { alert('No parts to export.'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) doc.addPage();
    await renderPartPage(doc, parts[i], true);
  }
  const filename = activePrinterFilter ? `${activePrinterFilter}-parts.pdf` : 'all-parts.pdf';
  doc.save(filename);
});

async function renderPartPage(doc, part, includePageNum) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;
  const gap = 3;
  const contentW = pageW - margin * 2;

  // Header
  doc.setFontSize(14); doc.setFont(undefined, 'bold');
  doc.text(part.part_number, margin, margin + 8);
  doc.setFont(undefined, 'normal'); doc.setFontSize(9); doc.setTextColor(100);
  let headerY = margin + 14;
  if (part.printers?.length) {
    doc.text(`Printers: ${part.printers.join(', ')}`, margin, headerY);
    headerY += 5;
  }
  if (part.description) {
    doc.text(part.description, margin, headerY, { maxWidth: contentW });
    headerY += 5;
  }
  doc.setTextColor(0);

  const photos = part.photos;
  if (!photos.length) return;

  const startY = headerY + 4;
  const footerH = includePageNum ? 8 : 0;
  const availH = pageH - startY - margin - footerH;

  // Pick grid: 1 = full page, 2-4 = 2 cols, 5+ = 3 cols
  const count = photos.length;
  const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const cellW = (contentW - gap * (cols - 1)) / cols;
  const cellH = (availH - gap * (rows - 1)) / rows;

  for (let i = 0; i < photos.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = margin + col * (cellW + gap);
    const y = startY + row * (cellH + gap);
    await addPdfImage(doc, photos[i], x, y, cellW, cellH);
  }

  if (includePageNum) {
    doc.setFontSize(7); doc.setTextColor(150);
    doc.text(new Date().toLocaleDateString(), margin, pageH - 4);
    doc.setTextColor(0);
  }
}

async function addPdfImage(doc, photo, x, y, cellW, cellH) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Contain: fit image within cell, preserve aspect ratio
      const imgRatio = img.width / img.height;
      let drawW = cellW;
      let drawH = cellW / imgRatio;
      if (drawH > cellH) { drawH = cellH; drawW = cellH * imgRatio; }

      // Center within the cell
      const drawX = x + (cellW - drawW) / 2;
      const drawY = y + (cellH - drawH) / 2;

      doc.addImage(img, 'JPEG', drawX, drawY, drawW, drawH);

      // Machine label below the image
      if (photo.machine_label) {
        doc.setFontSize(6); doc.setTextColor(80);
        doc.text(photo.machine_label, drawX, drawY + drawH + 3, { maxWidth: drawW });
        doc.setTextColor(0);
      }
      resolve();
    };
    img.onerror = resolve;
    img.src = photo.image_url;
  });
}

// ── Search & Nav ───────────────────────────────────────────────────────────
document.getElementById('input-search').addEventListener('input', applyFilters);

document.getElementById('btn-nav-gallery').addEventListener('click', () => {
  stopCamera(); currentPart = null; showView('view-gallery');
});
document.querySelector('nav h1').addEventListener('click', () => {
  stopCamera(); currentPart = null; showView('view-gallery');
});


// ── Init ───────────────────────────────────────────────────────────────────
(async () => {
  // Detect OAuth errors returned in URL hash
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.get('error')) {
    const desc = hashParams.get('error_description') || hashParams.get('error');
    alert('Auth error: ' + decodeURIComponent(desc.replace(/\+/g, ' ')));
    history.replaceState(null, '', window.location.pathname);
  }
  // Listen for auth changes (handles OAuth redirect callback too)
  onAuthStateChange(async (_event, session) => {
    await handleSession(session);
    // Re-render current view to reflect auth state
    if (currentPart) renderPartDetail();
  });

  // Check existing session on load
  const session = await getSession();
  await handleSession(session);

  await loadGallery();
  showView('view-gallery');
})();
