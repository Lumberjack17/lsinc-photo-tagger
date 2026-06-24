// Photo editor
// this.base is always the authoritative composite — every stroke is baked in immediately.
// this._history is a stack of ImageData snapshots for undo.

export class PhotoEditor {
  constructor({ imageDataUrl, onDone, onCancel }) {
    this.onDone = onDone;
    this.onCancel = onCancel;
    this._history = [];
    this.tool = 'rect';
    this.strokeColor = '#ff0000';
    this.strokeWidth = 8;   // base pixels
    this.fontSize = 36;     // base pixels
    this.isDrawing = false;
    this.drawStart = null;  // base coords, for live preview only
    this.previewEnd = null; // base coords, for live preview only
    this.cropRect = null;   // display coords
    this.cropMode = false;

    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');

    this._buildUI();

    const img = new Image();
    img.onload = () => {
      this.base.width = img.naturalWidth;
      this.base.height = img.naturalHeight;
      this.baseCtx.drawImage(img, 0, 0);
      this._render();
    };
    img.src = imageDataUrl;
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  _buildUI() {
    this.root = document.createElement('div');
    this.root.className = 'editor-overlay';
    this.root.innerHTML = `
      <div class="editor-toolbar">
        <div class="editor-tool-group">
          <button class="etool active" data-tool="rect" title="Rectangle">▭</button>
          <button class="etool" data-tool="circle" title="Circle">◯</button>
          <button class="etool" data-tool="arrow" title="Arrow">↗</button>
          <button class="etool" data-tool="text" title="Text">T</button>
        </div>
        <div class="editor-tool-group">
          <button class="etool" id="e-rotate-ccw" title="Rotate Left">↺</button>
          <button class="etool" id="e-rotate-cw" title="Rotate Right">↻</button>
          <button class="etool" id="e-crop-btn" title="Crop — drag to select, click Crop again to apply">⊡</button>
        </div>
        <div class="editor-tool-group">
          <input type="color" id="e-color" value="#ff0000" title="Color">
          <input type="range" id="e-size" min="1" max="12" value="4" title="Size">
        </div>
        <div class="editor-tool-group editor-actions-group">
          <button class="etool" id="e-undo" title="Undo">⟲</button>
          <button class="btn-secondary" id="e-cancel">Cancel</button>
          <button class="btn-primary" id="e-done">Done</button>
        </div>
      </div>
      <div class="editor-canvas-wrap">
        <canvas id="e-canvas"></canvas>
        <div id="e-text-box" class="e-text-box" hidden>
          <input id="e-text-input" type="text" placeholder="Type text, press Enter">
          <button id="e-text-ok" class="btn-primary">✓</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('#e-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.textBox = this.root.querySelector('#e-text-box');
    this.textInput = this.root.querySelector('#e-text-input');
    this._bindEvents();
  }

  _bindEvents() {
    this.root.querySelectorAll('.etool[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.root.querySelectorAll('.etool[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tool = btn.dataset.tool;
        this.textBox.hidden = true;
        this.canvas.style.cursor = this.tool === 'text' ? 'text' : 'crosshair';
      });
    });
    this.root.querySelector('#e-rotate-ccw').addEventListener('click', () => this._rotate(-90));
    this.root.querySelector('#e-rotate-cw').addEventListener('click', () => this._rotate(90));
    this.root.querySelector('#e-crop-btn').addEventListener('click', () => this._toggleCrop());
    this.root.querySelector('#e-undo').addEventListener('click', () => this._undo());
    this.root.querySelector('#e-color').addEventListener('input', e => this.strokeColor = e.target.value);
    this.root.querySelector('#e-size').addEventListener('input', e => {
      const v = +e.target.value;
      this.strokeWidth = v * 5;
      this.fontSize = v * 8 + 20;
    });
    this.root.querySelector('#e-cancel').addEventListener('click', () => { this._destroy(); this.onCancel(); });
    this.root.querySelector('#e-done').addEventListener('click', () => this._done());
    this.root.querySelector('#e-text-ok').addEventListener('click', () => this._commitText());
    this.textInput.addEventListener('keydown', e => { if (e.key === 'Enter') this._commitText(); });

    const c = this.canvas;
    c.addEventListener('mousedown', e => this._down(e));
    c.addEventListener('mousemove', e => this._move(e));
    c.addEventListener('mouseup', e => this._up(e));
    c.addEventListener('touchstart', e => { e.preventDefault(); this._down(e.touches[0]); }, { passive: false });
    c.addEventListener('touchmove', e => { e.preventDefault(); this._move(e.touches[0]); }, { passive: false });
    c.addEventListener('touchend', e => { e.preventDefault(); this._up(e.changedTouches[0]); }, { passive: false });

    this._resizeHandler = () => this._render();
    window.addEventListener('resize', this._resizeHandler);
  }

  // ── Coords ───────────────────────────────────────────────────────────────

  _dispPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Display pixel → base pixel
  _toBase(dp) {
    return {
      x: dp.x * this.base.width / this.canvas.width,
      y: dp.y * this.base.height / this.canvas.height,
    };
  }

  // Base pixel → display pixel
  _toDisp(bp) {
    return {
      x: bp.x * this.canvas.width / this.base.width,
      y: bp.y * this.canvas.height / this.base.height,
    };
  }

  // ── Pointer ─────────────────────────────────────────────────────────────

  _down(e) {
    const dp = this._dispPos(e);
    if (this.tool === 'text') { this._startText(dp); return; }
    this.isDrawing = true;
    if (this.cropMode) {
      this.cropRect = { x1: dp.x, y1: dp.y, x2: dp.x, y2: dp.y };
    } else {
      this.drawStart = this._toBase(dp);
    }
  }

  _move(e) {
    if (!this.isDrawing) return;
    const dp = this._dispPos(e);
    if (this.cropMode && this.cropRect) {
      this.cropRect.x2 = dp.x; this.cropRect.y2 = dp.y;
    } else {
      this.previewEnd = this._toBase(dp);
    }
    this._render();
  }

  _up(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    const dp = this._dispPos(e);
    if (!this.cropMode && this.drawStart) {
      const end = this._toBase(dp);
      const dx = Math.abs(end.x - this.drawStart.x);
      const dy = Math.abs(end.y - this.drawStart.y);
      if (dx > 2 || dy > 2) {
        // Snapshot before baking so undo works
        this._saveHistory();
        // Bake stroke directly onto base — this.base is now the truth
        this._drawShape(this.baseCtx, this.tool,
          this.drawStart, end,
          this.strokeColor, this.strokeWidth
        );
      }
    }
    this.drawStart = null;
    this.previewEnd = null;
    this._render();
  }

  // ── Text ────────────────────────────────────────────────────────────────

  _startText(dp) {
    this._pendingTextBase = this._toBase(dp);
    const wRect = this.root.querySelector('.editor-canvas-wrap').getBoundingClientRect();
    const cRect = this.canvas.getBoundingClientRect();
    this.textBox.style.left = `${cRect.left - wRect.left + dp.x}px`;
    this.textBox.style.top = `${cRect.top - wRect.top + dp.y + 8}px`;
    this.textInput.value = '';
    this.textBox.hidden = false;
    this.textInput.focus();
  }

  _commitText() {
    const text = this.textInput.value.trim();
    this.textBox.hidden = true;
    if (!text || !this._pendingTextBase) return;
    this._saveHistory();
    // Bake text directly onto base
    this._drawShape(this.baseCtx, 'text',
      this._pendingTextBase, this._pendingTextBase,
      this.strokeColor, this.strokeWidth, text, this.fontSize
    );
    this._pendingTextBase = null;
    this._render();
  }

  // ── History ──────────────────────────────────────────────────────────────

  _saveHistory() {
    const snap = {
      imageData: this.baseCtx.getImageData(0, 0, this.base.width, this.base.height),
      width: this.base.width,
      height: this.base.height,
    };
    this._history.push(snap);
    if (this._history.length > 20) this._history.shift();
  }

  _undo() {
    if (!this._history.length) return;
    const snap = this._history.pop();
    this.base.width = snap.width;
    this.base.height = snap.height;
    this.baseCtx.putImageData(snap.imageData, 0, 0);
    // Exit crop mode on undo
    this.cropMode = false;
    this.cropRect = null;
    this.root.querySelector('#e-crop-btn').classList.remove('active');
    this._render();
  }

  // ── Transform ────────────────────────────────────────────────────────────

  _rotate(deg) {
    this._saveHistory();
    const rad = deg * Math.PI / 180;
    const sw = this.base.width, sh = this.base.height;
    const nw = Math.round(Math.abs(sw * Math.cos(rad)) + Math.abs(sh * Math.sin(rad)));
    const nh = Math.round(Math.abs(sw * Math.sin(rad)) + Math.abs(sh * Math.cos(rad)));
    const tmp = document.createElement('canvas');
    tmp.width = nw; tmp.height = nh;
    const tc = tmp.getContext('2d');
    tc.translate(nw / 2, nh / 2);
    tc.rotate(rad);
    tc.drawImage(this.base, -sw / 2, -sh / 2);
    this.base.width = nw; this.base.height = nh;
    this.baseCtx.drawImage(tmp, 0, 0);
    this._render();
  }

  _toggleCrop() {
    if (this.cropMode) {
      if (this.cropRect) this._applyCrop();
      this.cropMode = false;
      this.cropRect = null;
    } else {
      this.cropMode = true;
    }
    this.root.querySelector('#e-crop-btn').classList.toggle('active', this.cropMode);
    this._render();
  }

  _applyCrop() {
    const x = Math.min(this.cropRect.x1, this.cropRect.x2);
    const y = Math.min(this.cropRect.y1, this.cropRect.y2);
    const w = Math.abs(this.cropRect.x2 - this.cropRect.x1);
    const h = Math.abs(this.cropRect.y2 - this.cropRect.y1);
    if (w < 10 || h < 10) return;
    this._saveHistory();
    const sx = this.base.width / this.canvas.width;
    const sy = this.base.height / this.canvas.height;
    const bx = Math.round(x * sx), by = Math.round(y * sy);
    const bw = Math.round(w * sx), bh = Math.round(h * sy);
    const tmp = document.createElement('canvas');
    tmp.width = bw; tmp.height = bh;
    tmp.getContext('2d').drawImage(this.base, bx, by, bw, bh, 0, 0, bw, bh);
    this.base.width = bw; this.base.height = bh;
    this.baseCtx.drawImage(tmp, 0, 0);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  _render() {
    const wrap = this.root.querySelector('.editor-canvas-wrap');
    const maxW = wrap.clientWidth || 600;
    const maxH = wrap.clientHeight || 500;
    const scale = Math.min(maxW / this.base.width, maxH / this.base.height);
    this.canvas.width = Math.round(this.base.width * scale);
    this.canvas.height = Math.round(this.base.height * scale);

    // Draw the authoritative base (has all committed strokes baked in)
    this.ctx.drawImage(this.base, 0, 0, this.canvas.width, this.canvas.height);

    // Draw in-progress stroke preview (not yet baked)
    if (this.drawStart && this.previewEnd) {
      this._drawShape(this.ctx, this.tool,
        this._toDisp(this.drawStart), this._toDisp(this.previewEnd),
        this.strokeColor, this.strokeWidth * scale
      );
    }

    if (this.cropMode && this.cropRect) this._drawCropOverlay();
  }

  _drawCropOverlay() {
    const x = Math.min(this.cropRect.x1, this.cropRect.x2);
    const y = Math.min(this.cropRect.y1, this.cropRect.y2);
    const w = Math.abs(this.cropRect.x2 - this.cropRect.x1);
    const h = Math.abs(this.cropRect.y2 - this.cropRect.y1);
    this.ctx.fillStyle = 'rgba(0,0,0,0.5)';
    this.ctx.fillRect(0, 0, this.canvas.width, y);
    this.ctx.fillRect(0, y, x, h);
    this.ctx.fillRect(x + w, y, this.canvas.width - x - w, h);
    this.ctx.fillRect(0, y + h, this.canvas.width, this.canvas.height - y - h);
    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([6, 3]);
    this.ctx.strokeRect(x, y, w, h);
    this.ctx.setLineDash([]);
  }

  // ── Draw primitive ───────────────────────────────────────────────────────
  // Accepts both base coords (when drawing to baseCtx) and display coords (when previewing)

  _drawShape(ctx, type, start, end, color, width, text, size) {
    ctx.save();
    ctx.strokeStyle = color || '#ff0000';
    ctx.fillStyle = color || '#ff0000';
    ctx.lineWidth = width || 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    if (type === 'rect') {
      ctx.beginPath();
      ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
      ctx.stroke();
    } else if (type === 'circle') {
      const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2, ry = Math.abs(end.y - start.y) / 2;
      if (rx > 1 && ry > 1) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (type === 'arrow') {
      this._drawArrow(ctx, start.x, start.y, end.x, end.y, width || 2);
    } else if (type === 'text' && text) {
      const fs = size || 36;
      ctx.font = `bold ${fs}px sans-serif`;
      // Dark outline for readability on any background
      ctx.lineWidth = Math.max(2, fs * 0.12);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(text, start.x, start.y);
      ctx.fillStyle = color || '#ffffff';
      ctx.fillText(text, start.x, start.y);
    }
    ctx.restore();
  }

  _drawArrow(ctx, x1, y1, x2, y2, width) {
    const head = Math.max(12, width * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  // ── Export ───────────────────────────────────────────────────────────────

  _done() {
    // this.base is already the complete composite — just export it
    const result = this.base.toDataURL('image/jpeg', 0.92);
    this._destroy();
    this.onDone(result);
  }

  _destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    this.root.remove();
  }
}
