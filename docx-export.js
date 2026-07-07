// docx-export.js — Word (.docx) export for part photo reports.
//
// A .docx is a ZIP of Open XML parts + image files, so this file includes
// its own tiny ZIP writer (STORE / no compression) — no npm install needed.
//
// Export:
//   buildPartDocx(part)   → Blob  (single part)
//   buildAllDocx(parts)   → Blob  (all parts, one section each)
//   downloadBlob(blob, filename)

// ── CRC-32 table (needed by ZIP) ─────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Minimal ZIP writer (STORE / no compression) ───────────────────────────────
function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint16(6, 0x0800, true);
    lfh.setUint16(8, 0, true);
    lfh.setUint16(10, 0, true);
    lfh.setUint16(12, 0x21, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, size, true);
    lfh.setUint32(22, size, true);
    lfh.setUint16(26, nameBytes.length, true);
    lfh.setUint16(28, 0, true);
    const lfhArr = new Uint8Array(lfh.buffer);
    parts.push(lfhArr, nameBytes, e.data);

    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true);
    cdh.setUint16(6, 20, true);
    cdh.setUint16(8, 0x0800, true);
    cdh.setUint16(10, 0, true);
    cdh.setUint16(12, 0, true);
    cdh.setUint16(14, 0x21, true);
    cdh.setUint32(16, crc, true);
    cdh.setUint32(20, size, true);
    cdh.setUint32(24, size, true);
    cdh.setUint16(28, nameBytes.length, true);
    cdh.setUint16(30, 0, true);
    cdh.setUint16(32, 0, true);
    cdh.setUint16(34, 0, true);
    cdh.setUint16(36, 0, true);
    cdh.setUint32(38, 0, true);
    cdh.setUint32(42, offset, true);
    central.push(new Uint8Array(cdh.buffer), nameBytes);

    offset += lfhArr.length + nameBytes.length + size;
  }

  const centralSize = central.reduce((s, a) => s + a.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  return new Blob(
    [...parts.map(p => p.buffer), ...central.map(c => c.buffer), eocd.buffer],
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  );
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function docxPara(text, { bold = false, size = 22, color = null, spaceAfter = 80, spaceBefore = 0 } = {}) {
  const rpr = [
    bold ? '<w:b/>' : '',
    `<w:sz w:val="${size}"/>`,
    color ? `<w:color w:val="${color}"/>` : '',
  ].join('');
  return (
    `<w:p>` +
    `<w:pPr><w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}"/></w:pPr>` +
    `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>` +
    `</w:p>`
  );
}

function docxImage(relId, id, cx, cy) {
  return (
    `<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Photo ${id}"/>` +
    `<wp:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
    `</wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Photo ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic>` +
    `</wp:inline></w:drawing></w:r></w:p>`
  );
}

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

// Load a URL via <img> + canvas → JPEG bytes + dimensions.
// Uses the same approach as the PDF exporter so CORS isn't a problem.
function loadImageAsJpeg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Canvas toBlob failed')); return; }
        blob.arrayBuffer().then(buf => resolve({
          bytes: new Uint8Array(buf),
          w: img.naturalWidth,
          h: img.naturalHeight,
        })).catch(reject);
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = url;
  });
}

// ── Core builder ──────────────────────────────────────────────────────────────
// parts: array of { part_number, description, printers, photos: [{ image_url, machine_label }] }
async function buildDocx(parts) {
  const enc = new TextEncoder();
  const entries = [];
  const rels = [];
  const body = [];
  let imgIdx = 0;

  const MAX_W_EMU = 5486400; // 6 inches @ 914400 EMU/inch

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];

    body.push(docxPara(part.part_number, { bold: true, size: 32, spaceBefore: pi === 0 ? 0 : 0, spaceAfter: 60 }));
    if (part.printers?.length) {
      body.push(docxPara(`Printers: ${part.printers.join(', ')}`, { size: 18, color: '666666', spaceAfter: 40 }));
    }
    if (part.description) {
      body.push(docxPara(part.description, { size: 18, color: '444444', spaceAfter: 80 }));
    }

    for (const photo of part.photos) {
      imgIdx++;
      try {
        const { bytes, w, h } = await loadImageAsJpeg(photo.image_url);
        const scale = Math.min(1, MAX_W_EMU / (w * 9525));
        const cx = Math.round(w * 9525 * scale);
        const cy = Math.round(h * 9525 * scale);
        const mediaName = `image${imgIdx}.jpeg`;
        const relId = `rIdImg${imgIdx}`;
        entries.push({ name: `word/media/${mediaName}`, data: bytes });
        rels.push(
          `<Relationship Id="${relId}" ` +
          `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
          `Target="media/${mediaName}"/>`
        );
        body.push(docxImage(relId, imgIdx, cx, cy));
        if (photo.machine_label) {
          body.push(docxPara(photo.machine_label, { size: 16, color: '555555', spaceAfter: 100 }));
        }
      } catch (e) {
        body.push(docxPara(`[Image unavailable: ${photo.machine_label || photo.image_url}]`, { size: 16, color: 'AA0000' }));
      }
    }

    if (pi < parts.length - 1) body.push(PAGE_BREAK);
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr>` +
    `<w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr>` +
    `</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `${rels.join('')}` +
    `</Relationships>`;

  entries.push({ name: '[Content_Types].xml', data: enc.encode(contentTypes) });
  entries.push({ name: '_rels/.rels', data: enc.encode(rootRels) });
  entries.push({ name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) });
  entries.push({ name: 'word/document.xml', data: enc.encode(documentXml) });

  return makeZip(entries);
}

export function buildPartDocx(part) {
  return buildDocx([part]);
}

export function buildAllDocx(parts) {
  return buildDocx(parts);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
