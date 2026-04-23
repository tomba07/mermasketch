'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const previewImg     = document.getElementById('preview-img');
const dzIdle         = document.getElementById('dz-idle');
const btnConvert     = document.getElementById('btn-convert');
const btnClear       = document.getElementById('btn-clear');
const btnCopy        = document.getElementById('btn-copy');
const btnRerender    = document.getElementById('btn-rerender');
const errorBox       = document.getElementById('error-box');
const loadingOverlay = document.getElementById('loading-overlay');
const mermaidCode    = document.getElementById('mermaid-code');
const diagramPreview = document.getElementById('diagram-preview');

// ── State ─────────────────────────────────────────────────────────────────────
let currentFile = null;
let renderTimer = null;
let _mermaidId  = 0;   // unique ID counter for mermaid.render()

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_BYTES   = 5 * 1024 * 1024;
const ACCEPTED    = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// ── Utilities ─────────────────────────────────────────────────────────────────
function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden      = false;
}

function clearError() {
  errorBox.textContent = '';
  errorBox.hidden      = true;
}

function setLoading(on) {
  loadingOverlay.hidden = !on;
  btnConvert.disabled   = on || !currentFile;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Read File as base64 data, returns { base64, mimeType } */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const comma = reader.result.indexOf(',');
      resolve({ base64: reader.result.slice(comma + 1), mimeType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── File handling ─────────────────────────────────────────────────────────────
function loadFile(file) {
  clearError();

  if (!ACCEPTED.includes(file.type)) {
    showError(`Unsupported file type: ${file.type}. Please upload a JPEG, PNG, GIF, or WEBP.`);
    return;
  }
  if (file.size > MAX_BYTES) {
    showError(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — maximum is 5 MB.`);
    return;
  }

  currentFile = file;

  const url = URL.createObjectURL(file);
  previewImg.src    = url;
  previewImg.hidden = false;
  dzIdle.hidden     = true;

  btnConvert.disabled = false;
  btnClear.hidden     = false;
}

function clearFile() {
  currentFile = null;

  if (previewImg.src) URL.revokeObjectURL(previewImg.src);
  previewImg.src    = '';
  previewImg.hidden = true;
  dzIdle.hidden     = false;

  fileInput.value     = '';
  btnConvert.disabled = true;
  btnClear.hidden     = true;

  clearError();
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

['dragleave', 'dragend'].forEach(evt =>
  dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'))
);

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

// Keyboard accessibility
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

btnClear.addEventListener('click', clearFile);

// ── Convert ───────────────────────────────────────────────────────────────────
btnConvert.addEventListener('click', async () => {
  if (!currentFile) return;
  clearError();
  setLoading(true);

  try {
    const { base64, mimeType } = await fileToBase64(currentFile);

    const res = await fetch('/convert', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ imageBase64: base64, mimeType }),
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`);

    mermaidCode.value  = data.mermaid;
    btnCopy.disabled   = false;
    btnRerender.hidden = false;

    await renderDiagram(data.mermaid);
  } catch (err) {
    showError(err.message || 'An unexpected error occurred. Please try again.');
  } finally {
    setLoading(false);
  }
});

// ── Copy ──────────────────────────────────────────────────────────────────────
btnCopy.addEventListener('click', async () => {
  const text = mermaidCode.value.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const orig = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = orig; }, 1800);
  } catch {
    mermaidCode.select();
    document.execCommand('copy');
  }
});

// ── Mermaid rendering ─────────────────────────────────────────────────────────
async function renderDiagram(code) {
  const mermaid = window.__mermaid;
  if (!mermaid) {
    diagramPreview.innerHTML = '<p class="placeholder-text">Mermaid library not ready — try again in a moment.</p>';
    return;
  }
  if (!code.trim()) {
    diagramPreview.innerHTML = '<p class="placeholder-text">No code to render.</p>';
    return;
  }

  try {
    const id = `mermaid-svg-${++_mermaidId}`;
    const { svg } = await mermaid.render(id, code.trim());
    diagramPreview.innerHTML = svg;
  } catch (err) {
    diagramPreview.innerHTML =
      `<p class="placeholder-text" style="color:#d93025">
         Diagram syntax error — fix the code above and click Re-render.<br>
         <small>${escapeHtml(err.message ?? '')}</small>
       </p>`;
  }
}

// Debounced live re-render as user edits the textarea
mermaidCode.addEventListener('input', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderDiagram(mermaidCode.value), 600);
});

btnRerender.addEventListener('click', () => renderDiagram(mermaidCode.value));
