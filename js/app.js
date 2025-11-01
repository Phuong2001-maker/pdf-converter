import {
  state,
  events,
  setActiveTool,
  setActiveImage,
  setActiveLayer,
  addImage,
  addLayer,
  updateLayer,
  removeLayer,
  reorderLayers,
  getActiveImage,
  getImage,
  getLayer,
  layerTypes,
  loadPresets,
  ensureDefaultPreset,
  addPreset,
  removePreset,
  updatePreset,
  undo,
  redo,
  pushHistory,
  updateImage,
} from './state.js';
import { CanvasRenderer } from './render.js';
import {
  initUI,
  renderToolTabs,
  updateToolSelection,
  renderLayerList,
  markActiveLayer,
  renderPresetList,
  togglePresetPanel,
  showToast,
  showConfirm,
  showQrPreview,
  hideQrPreview,
  updateStatusBar,
  updateActiveFileName,
  toggleTips,
  toggleOfflineBanner,
  registerOfflineBanner,
} from './ui.js';

const canvas = document.getElementById('editorCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const dropzone = document.getElementById('canvasDropzone');
const fileInput = document.getElementById('imageInput');
const logoInput = document.getElementById('logoInput');
const canvasBoard = document.getElementById('canvasBoard');
const toolbarButtons = document.querySelectorAll('.canvas-toolbar [data-action]');
const selectFilesButton = document.querySelector('[data-action="select-files"]');
const useSampleButton = document.querySelector('[data-action="use-sample"]');
const layerAddTextButton = document.querySelector('[data-action="add-layer-text"]');
const duplicateLayerButton = document.querySelector('[data-action="duplicate-layer"]');
const deleteLayerButton = document.querySelector('[data-action="delete-layer"]');
const savePresetButton = document.querySelector('[data-action="save-preset"]');

const renderer = new CanvasRenderer(canvas, overlayCanvas);
let toolPanelCleanup = null;
let penStroke = null;
let blurSelection = null;
let dragLayer = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const toolDefaults = {
  [layerTypes.TEXT]: {
    content: 'Ký tên mẫu',
    fontFamily: "'Great Vibes', cursive",
    fontSize: 72,
    fontWeight: 600,
    italic: false,
    uppercase: false,
    color: '#0F172A',
    opacity: 1,
    strokeWidth: 0,
    strokeColor: '#ffffff',
    shadow: {
      enabled: true,
      blur: 14,
      offsetX: 0,
      offsetY: 8,
      color: 'rgba(15, 23, 42, 0.35)',
    },
    align: 'center',
    position: { x: 0.5, y: 0.65 },
    maxWidthRatio: null,
    letterSpacing: 0,
    snap: true,
  },
  [layerTypes.PEN]: {
    color: '#0F172A',
    size: 4,
    smoothing: 0.65,
    roundCap: true,
  },
  [layerTypes.LOGO]: {
    scale: 0.6,
    rotation: 0,
    opacity: 1,
    position: { x: 0.85, y: 0.8 },
  },
  [layerTypes.WATERMARK]: {
    text: 'Ký ảnh • Client-side',
    fontFamily: 'Inter',
    fontSize: 36,
    opacity: 0.22,
    angle: -45,
    spacingX: 260,
    spacingY: 180,
    color: 'rgba(37, 99, 235, 0.28)',
  },
  [layerTypes.QR]: {
    text: 'Dr. Huỳnh – Implant – 0972 000 000',
    size: 220,
    margin: 12,
    opacity: 0.95,
    position: { x: 0.16, y: 0.84 },
    applyAll: false,
  },
  [layerTypes.BLUR]: {
    mode: 'blur',
    intensity: 12,
  },
};

const TOOL_DEFINITIONS = [
  { id: layerTypes.TEXT, icon: 'icon-type' },
  { id: layerTypes.PEN, icon: 'icon-pen' },
  { id: layerTypes.LOGO, icon: 'icon-sticker' },
  { id: layerTypes.WATERMARK, icon: 'icon-watermark' },
  { id: layerTypes.QR, icon: 'icon-qr' },
  { id: layerTypes.BLUR, icon: 'icon-blur' },
  { id: 'export', icon: 'icon-export' },
  { id: 'batch', icon: 'icon-batch' },
];

function scheduleRendererResize(image = null) {
  const container = canvas.parentElement;
  if (!container) return;
  let attempts = 0;
  const attemptResize = () => {
    const rect = container.getBoundingClientRect();
    const hasSize = rect.width > 0 && rect.height > 0;
    if (!hasSize && attempts < 10) {
      attempts += 1;
      requestAnimationFrame(attemptResize);
      return;
    }
    if (!hasSize) {
      return;
    }
    renderer.resize(rect.width, rect.height);
    if (image) {
      renderer.fitToBounds(image.width, image.height);
    }
  };
  requestAnimationFrame(attemptResize);
}

function init() {
  initUI();
  loadPresets();
  ensureDefaultPreset();
  renderPresetList(state.presets);
  renderToolTabs(TOOL_DEFINITIONS);
  renderToolPanel(state.activeTool);
  updateToolSelection(state.activeTool);
  registerEvents();
  const container = canvas.parentElement;
  if (container) {
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      renderer.resize(rect.width, rect.height);
    }
  }
  toggleTips(true);
  registerOfflineBanner(() => toggleOfflineBanner(false));
  if (!navigator.onLine) {
    toggleOfflineBanner(true);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      console.warn('Service worker registration failed', error);
    });
  }
}

function registerEvents() {
  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('pointerup', handlePointerUp, { passive: true });
  window.addEventListener('keydown', handleKeyDown);

  dropzone?.addEventListener('click', () => fileInput?.click());
  dropzone?.addEventListener('dragover', handleDragOver);
  dropzone?.addEventListener('dragleave', handleDragLeave);
  dropzone?.addEventListener('drop', handleDrop);

  fileInput?.addEventListener('change', handleFileSelection);
  logoInput?.addEventListener('change', handleLogoSelection);

  canvas.addEventListener('pointerdown', handleCanvasPointerDown);
  overlayCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
  overlayCanvas.addEventListener('pointermove', handleCanvasPointerMove);
  overlayCanvas.addEventListener('pointerup', handleCanvasPointerUp);
  overlayCanvas.addEventListener('pointerleave', handleCanvasPointerUp);

  toolbarButtons.forEach(button => button.addEventListener('click', handleToolbarAction));
  layerAddTextButton?.addEventListener('click', createTextLayer);
  duplicateLayerButton?.addEventListener('click', handleDuplicateLayer);
  deleteLayerButton?.addEventListener('click', handleDeleteLayer);
  savePresetButton?.addEventListener('click', handleSavePreset);
  selectFilesButton?.addEventListener('click', () => fileInput?.click());
  useSampleButton?.addEventListener('click', handleUseSample);

  events.addEventListener('ui:toolselected', event => {
    const { toolId } = event.detail;
    setActiveTool(toolId);
  });

  events.addEventListener('ui:layerselected', event => {
    const { layerId } = event.detail;
    setActiveLayer(layerId);
  });

  events.addEventListener('imagelistchange', () => {
    const image = getActiveImage();
    renderLayerList(image);
    renderPresetList(state.presets);
    updateActiveFileName(image?.name || null);
    canvasBoard.dataset.state = image ? 'loaded' : 'empty';
    if (image) {
      updateStatusBar({
        dimensions: `${image.width} × ${image.height}px`,
        zoom: `Zoom: ${(image.zoom * 100).toFixed(0)}%`,
        memory: estimateMemoryUsage(image),
      });
      scheduleRendererResize(image);
    } else {
      updateStatusBar({
        dimensions: 'Kích thước: —',
        zoom: 'Zoom: 100%',
        memory: 'RAM ước tính: —',
      });
    }
    renderer.render();
  });

  events.addEventListener('imagechange', () => {
    const image = getActiveImage();
    renderLayerList(image);
    updateActiveFileName(image?.name || null);
    canvasBoard.dataset.state = image ? 'loaded' : 'empty';
    if (image) {
      updateStatusBar({
        dimensions: `${image.width} × ${image.height}px`,
        zoom: `Zoom: ${(image.zoom * 100).toFixed(0)}%`,
        memory: estimateMemoryUsage(image),
      });
      scheduleRendererResize(image);
    }
    renderer.render();
  });

  events.addEventListener('layerlistchange', () => {
    const image = getActiveImage();
    renderLayerList(image);
    renderer.render();
  });

  events.addEventListener('layerchange', () => {
    markActiveLayer(state.activeLayerId);
    renderToolPanel(state.activeTool);
  });

  events.addEventListener('presetchange', () => {
    renderPresetList(state.presets);
  });

  window.addEventListener('online', () => toggleOfflineBanner(false));
  window.addEventListener('offline', () => toggleOfflineBanner(true));
}

function handleResize() {
  const container = canvas.parentElement;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  renderer.resize(rect.width, rect.height);
  const image = getActiveImage();
  if (image) {
    renderer.render();
  }
}

function handleDragOver(event) {
  event.preventDefault();
  dropzone?.classList.add('is-hover');
}

function handleDragLeave(event) {
  event.preventDefault();
  dropzone?.classList.remove('is-hover');
}

function handleDrop(event) {
  event.preventDefault();
  dropzone?.classList.remove('is-hover');
  const files = Array.from(event.dataTransfer?.files || []).filter(file => file.type.startsWith('image/'));
  if (files.length) {
    loadFiles(files);
  }
}

function handleFileSelection(event) {
  const files = Array.from(event.target?.files || []).filter(file => file.type.startsWith('image/'));
  if (files.length) {
    loadFiles(files);
  }
  event.target.value = '';
}

async function loadFiles(files) {
  toggleTips(false);
  for (const file of files) {
    const imageState = await createImageStateFromFile(file);
    if (!imageState) continue;
    addImage(imageState);
  }
}

async function createImageStateFromFile(file) {
  try {
    const blob = file.slice();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    let width = bitmap.width;
    let height = bitmap.height;
    let scaleFactor = 1;
    const pixelCount = width * height;
    if (pixelCount > 20_000_000) {
      const confirm = await showConfirm({
        message: state.locale === 'vi'
          ? 'Ảnh lớn hơn 20MP. Giảm 50% để thao tác mượt hơn?'
          : 'Image exceeds 20MP. Downscale 50% for smoother editing?',
        confirmLabel: state.locale === 'vi' ? 'Giảm ảnh' : 'Downscale',
        cancelLabel: state.locale === 'vi' ? 'Giữ nguyên' : 'Keep original',
      });
      if (confirm) {
        scaleFactor = 0.5;
      }
    }

    let baseCanvas;
    if (scaleFactor !== 1) {
      width = Math.round(width * scaleFactor);
      height = Math.round(height * scaleFactor);
      baseCanvas = document.createElement('canvas');
      baseCanvas.width = width;
      baseCanvas.height = height;
      const ctx = baseCanvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
    }

    const objectUrl = URL.createObjectURL(blob);
    const sizeMb = (file.size / 1024 / 1024).toFixed(2);
    const imageState = {
      name: file.name,
      type: file.type,
      width,
      height,
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      bitmap: scaleFactor === 1 ? bitmap : await createImageBitmap(baseCanvas),
      baseCanvas,
      objectUrl,
      sizeBytes: file.size,
      sizeLabel: `${sizeMb} MB`,
      layers: [],
      zoom: 1,
      pan: { x: 0, y: 0 },
      grid: false,
      snap: true,
      ruler: false,
      createdAt: Date.now(),
    };

    updateStatusBar({
      dimensions: `${width} × ${height}px`,
      zoom: 'Zoom: 100%',
      memory: estimateMemoryUsage(imageState),
    });

    updateActiveFileName(imageState.name);
    canvasBoard.dataset.state = 'loaded';
    renderer.render();
    return imageState;
  } catch (error) {
    console.error('Failed to load image', error);
    showToast({
      title: state.locale === 'vi' ? 'Không thể mở ảnh' : 'Unable to open image',
      message: error.message,
      tone: 'danger',
    });
    return null;
  }
}

function estimateMemoryUsage(image) {
  const pixels = image.width * image.height;
  const bytes = pixels * 4;
  const mb = bytes / 1024 / 1024;
  return `${state.locale === 'vi' ? 'RAM ước tính:' : 'Estimated RAM:'} ${mb.toFixed(1)} MB`;
}

function handleCanvasPointerDown(event) {
  const image = getActiveImage();
  if (!image) return;
  const tool = state.activeTool;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  if (tool === layerTypes.PEN) {
    startPenStroke(pointer);
  } else if (tool === layerTypes.BLUR) {
    startBlurSelection(pointer);
  } else {
    startLayerDrag(pointer);
  }
}

function handleCanvasPointerMove(event) {
  const image = getActiveImage();
  if (!image) return;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  if (penStroke) {
    extendPenStroke(pointer);
  } else if (blurSelection) {
    updateBlurSelection(pointer);
  } else if (dragLayer) {
    updateLayerDrag(pointer);
  }
}

function handleCanvasPointerUp() {
  if (penStroke) {
    finishPenStroke();
  }
  if (blurSelection) {
    finalizeBlurSelection();
  }
  if (dragLayer) {
    finalizeLayerDrag();
  }
}

function handlePointerUp() {
  handleCanvasPointerUp();
}

function handleKeyDown(event) {
  const image = getActiveImage();
  if (!image) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key === 'z' || event.key === 'Z') {
      event.preventDefault();
      undo(image.id);
      renderer.render();
    } else if (event.key === 'y' || (event.shiftKey && (event.key === 'z' || event.key === 'Z'))) {
      event.preventDefault();
      redo(image.id);
      renderer.render();
    }
  }
}

function startPenStroke(pointer) {
  const image = getActiveImage();
  if (!image) return;
  const activeLayer = getLayer(image.id, state.activeLayerId);
  if (!activeLayer || activeLayer.type !== layerTypes.PEN) {
    const newLayer = addLayer(image.id, {
      type: layerTypes.PEN,
      name: 'Pen',
      strokes: [],
      opacity: 1,
    });
    setActiveLayer(newLayer.id);
    penStroke = { layerId: newLayer.id, points: [] };
  } else {
    penStroke = { layerId: activeLayer.id, points: [] };
  }
  addPenPoint(pointer);
}

function addPenPoint(pointer) {
  const image = getActiveImage();
  if (!image || !penStroke) return;
  const { color, size } = toolDefaults[layerTypes.PEN];
  penStroke.points.push({
    x: clamp(pointer.x / image.width, 0, 1),
    y: clamp(pointer.y / image.height, 0, 1),
  });
  const layer = getLayer(image.id, penStroke.layerId);
  if (!layer) return;
  const strokes = Array.isArray(layer.strokes) ? layer.strokes.slice() : [];
  if (!penStroke.stroke) {
    penStroke.stroke = { color, size, points: [] };
    strokes.push(penStroke.stroke);
  }
  penStroke.stroke.points = penStroke.points.slice();
  updateLayer(image.id, layer.id, { strokes });
  renderer.render();
}

function extendPenStroke(pointer) {
  addPenPoint(pointer);
}

function finishPenStroke() {
  const image = getActiveImage();
  if (image && penStroke) {
    pushHistory(image.id);
  }
  penStroke = null;
}

function startBlurSelection(pointer) {
  const image = getActiveImage();
  if (!image) return;
  blurSelection = { start: pointer, current: pointer };
}

function updateBlurSelection(pointer) {
  const image = getActiveImage();
  if (!image || !blurSelection) return;
  blurSelection.current = pointer;
  const x1 = clamp(blurSelection.start.x, 0, image.width);
  const y1 = clamp(blurSelection.start.y, 0, image.height);
  const x2 = clamp(pointer.x, 0, image.width);
  const y2 = clamp(pointer.y, 0, image.height);
  const rect = {
    x: Math.min(x1, x2) / image.width,
    y: Math.min(y1, y2) / image.height,
    width: Math.abs(x2 - x1) / image.width,
    height: Math.abs(y2 - y1) / image.height,
  };
  renderer.setSelection(rect);
}

function finalizeBlurSelection() {
  const image = getActiveImage();
  if (!image || !blurSelection) return;
  const x1 = clamp(blurSelection.start.x, 0, image.width);
  const y1 = clamp(blurSelection.start.y, 0, image.height);
  const x2 = clamp(blurSelection.current.x, 0, image.width);
  const y2 = clamp(blurSelection.current.y, 0, image.height);
  if (Math.abs(x2 - x1) < 10 || Math.abs(y2 - y1) < 10) {
    renderer.setSelection(null);
    blurSelection = null;
    return;
  }
  const rect = {
    x: Math.min(x1, x2) / image.width,
    y: Math.min(y1, y2) / image.height,
    width: Math.abs(x2 - x1) / image.width,
    height: Math.abs(y2 - y1) / image.height,
  };
  const layer = addLayer(image.id, {
    type: layerTypes.BLUR,
    rect,
    mode: toolDefaults[layerTypes.BLUR].mode,
    intensity: toolDefaults[layerTypes.BLUR].intensity,
  });
  setActiveLayer(layer.id);
  renderer.setSelection(null);
  blurSelection = null;
  renderer.render();
}

function startLayerDrag(pointer) {
  const image = getActiveImage();
  if (!image) return;
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer || !layer.position) return;
  dragLayer = {
    layerId: layer.id,
    pointerStart: pointer,
    original: { ...layer.position },
  };
}

function updateLayerDrag(pointer) {
  const image = getActiveImage();
  if (!image || !dragLayer) return;
  const layer = getLayer(image.id, dragLayer.layerId);
  if (!layer || !layer.position) return;
  const dx = (pointer.x - dragLayer.pointerStart.x) / image.width;
  const dy = (pointer.y - dragLayer.pointerStart.y) / image.height;
  const snap = layer.snap ?? toolDefaults[layer.type]?.snap;
  const position = {
    x: clamp(dragLayer.original.x + dx, 0, 1),
    y: clamp(dragLayer.original.y + dy, 0, 1),
  };
  if (snap) {
    const step = 0.01;
    position.x = Math.round(position.x / step) * step;
    position.y = Math.round(position.y / step) * step;
  }
  updateLayer(image.id, layer.id, { position });
  renderer.render();
}

function finalizeLayerDrag() {
  const image = getActiveImage();
  if (image && dragLayer) {
    pushHistory(image.id);
  }
  dragLayer = null;
}

function handleToolbarAction(event) {
  const action = event.currentTarget.dataset.action;
  const image = getActiveImage();
  if (!image) return;
  switch (action) {
    case 'zoom-in':
      setZoom(image, image.zoom * 1.2);
      break;
    case 'zoom-out':
      setZoom(image, image.zoom / 1.2);
      break;
    case 'fit':
      renderer.fitToBounds(image.width, image.height);
      updateZoomLabel(image);
      break;
    case 'fill':
      setZoom(image, computeFillZoom(image));
      break;
    case 'center':
      renderer.fitToBounds(image.width, image.height);
      break;
    case 'toggle-grid':
      updateImage(image.id, { grid: !image.grid });
      renderer.render();
      break;
    case 'toggle-snap':
      updateImage(image.id, { snap: !image.snap });
      renderer.render();
      break;
    case 'toggle-ruler':
      updateImage(image.id, { ruler: !image.ruler });
      renderer.render();
      break;
    default:
      break;
  }
}

function setZoom(image, zoom) {
  const next = clamp(zoom, 0.1, 8);
  updateImage(image.id, { zoom: next });
  renderer.setView({ scale: next, offset: renderer.view.offset });
  updateZoomLabel(image);
  renderer.render();
}

function computeFillZoom(image) {
  const padding = 24;
  const availableWidth = renderer.bounds.width - padding * 2;
  const availableHeight = renderer.bounds.height - padding * 2;
  return Math.max(availableWidth / image.width, availableHeight / image.height);
}

function updateZoomLabel(image) {
  updateStatusBar({ zoom: `Zoom: ${(image.zoom * 100).toFixed(0)}%` });
}

async function handleDeleteLayer() {
  const image = getActiveImage();
  if (!image || !state.activeLayerId) return;
  const confirmed = await showConfirm({
    message: state.locale === 'vi'
      ? 'Xoá layer này? Thao tác không thể hoàn tác.'
      : 'Delete this layer? This cannot be undone.',
  });
  if (!confirmed) return;
  removeLayer(image.id, state.activeLayerId);
  renderer.render();
}

function handleDuplicateLayer() {
  const image = getActiveImage();
  if (!image || !state.activeLayerId) return;
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer) return;
  const duplicate = JSON.parse(JSON.stringify(layer));
  duplicate.id = undefined;
  if (duplicate.position) {
    duplicate.position = {
      x: clamp(duplicate.position.x + 0.03, 0, 1),
      y: clamp(duplicate.position.y + 0.03, 0, 1),
    };
  }
  const newLayer = addLayer(image.id, duplicate);
  setActiveLayer(newLayer.id);
  renderer.render();
}

async function handleSavePreset() {
  const tool = state.activeTool;
  const payload = collectToolState(tool);
  if (!payload) {
    showToast({
      title: state.locale === 'vi' ? 'Không có cấu hình' : 'No configuration',
      message: state.locale === 'vi'
        ? 'Chọn công cụ và thiết lập thông số trước khi lưu preset.'
        : 'Pick a tool and configure it before saving a preset.',
      tone: 'warn',
    });
    return;
  }
  const name = prompt(state.locale === 'vi' ? 'Đặt tên preset' : 'Preset name', payload.name || '');
  if (!name) return;
  addPreset({
    name,
    tool,
    payload,
  });
  showToast({
    title: state.locale === 'vi' ? 'Preset đã lưu' : 'Preset saved',
    tone: 'success',
  });
}

function collectToolState(tool) {
  if (tool === layerTypes.TEXT) {
    const layer = getCurrentTextLayer();
    return layer ? layer : toolDefaults[layerTypes.TEXT];
  }
  if (tool === layerTypes.PEN) {
    return toolDefaults[layerTypes.PEN];
  }
  if (tool === layerTypes.LOGO) {
    return toolDefaults[layerTypes.LOGO];
  }
  if (tool === layerTypes.WATERMARK) {
    return toolDefaults[layerTypes.WATERMARK];
  }
  if (tool === layerTypes.QR) {
    return toolDefaults[layerTypes.QR];
  }
  if (tool === layerTypes.BLUR) {
    return toolDefaults[layerTypes.BLUR];
  }
  return null;
}

function getCurrentTextLayer() {
  const image = getActiveImage();
  if (!image) return null;
  const layer = getLayer(image.id, state.activeLayerId);
  if (layer && layer.type === layerTypes.TEXT) {
    return layer;
  }
  return null;
}

function createTextLayer() {
  const image = getActiveImage();
  if (!image) return;
  const layer = addLayer(image.id, {
    type: layerTypes.TEXT,
    ...toolDefaults[layerTypes.TEXT],
  });
  setActiveLayer(layer.id);
  renderer.render();
  renderToolPanel(layerTypes.TEXT);
}

function handleLogoSelection(event) {
  const files = Array.from(event.target?.files || []);
  if (!files.length) return;
  const file = files[0];
  const image = getActiveImage();
  if (!image) return;
  const reader = new FileReader();
  reader.onload = () => {
    const asset = new Image();
    asset.onload = () => {
      const layer = addLayer(image.id, {
        type: layerTypes.LOGO,
        asset,
        assetName: file.name,
        width: asset.width,
        height: asset.height,
        ...toolDefaults[layerTypes.LOGO],
      });
      layer.asset = asset;
      setActiveLayer(layer.id);
      renderer.render();
      renderToolPanel(layerTypes.LOGO);
    };
    asset.src = reader.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function handleUseSample() {
  const sample = new Image();
  sample.crossOrigin = 'anonymous';
  sample.src = 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&w=1600&q=80';
  sample.onload = async () => {
    const offscreen = document.createElement('canvas');
    offscreen.width = sample.width;
    offscreen.height = sample.height;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(sample, 0, 0);
    offscreen.toBlob(async blob => {
      if (!blob) return;
      const file = new File([blob], 'sample.jpg', { type: 'image/jpeg' });
      const imageState = await createImageStateFromFile(file);
      if (!imageState) return;
      addImage(imageState);
      const layer = addLayer(imageState.id, {
        type: layerTypes.TEXT,
        ...toolDefaults[layerTypes.TEXT],
        content: 'Ký ảnh demo',
      });
      setActiveLayer(layer.id);
      renderer.render();
    }, 'image/jpeg', 0.92);
  };
}

function renderToolPanel(toolId) {
  const container = document.getElementById('toolPanelContent');
  if (!container) return;
  if (toolPanelCleanup) {
    toolPanelCleanup();
    toolPanelCleanup = null;
  }
  container.innerHTML = '';
  switch (toolId) {
    case layerTypes.TEXT:
      toolPanelCleanup = renderTextPanel(container);
      break;
    case layerTypes.PEN:
      toolPanelCleanup = renderPenPanel(container);
      break;
    case layerTypes.LOGO:
      toolPanelCleanup = renderLogoPanel(container);
      break;
    case layerTypes.WATERMARK:
      toolPanelCleanup = renderWatermarkPanel(container);
      break;
    case layerTypes.QR:
      toolPanelCleanup = renderQrPanel(container);
      break;
    case layerTypes.BLUR:
      toolPanelCleanup = renderBlurPanel(container);
      break;
    case 'export':
      toolPanelCleanup = renderExportPanel(container);
      break;
    case 'batch':
      toolPanelCleanup = renderBatchPanel(container);
      break;
    default:
      break;
  }
}

function renderTextPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const current = layer?.type === layerTypes.TEXT ? layer : toolDefaults[layerTypes.TEXT];
  const disabled = !(layer && layer.type === layerTypes.TEXT);
  container.innerHTML = `
    <form id="textToolForm" class="form-grid" autocomplete="off">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Nội dung chữ ký' : 'Signature content'}</span>
        <textarea name="content" rows="3" ${disabled ? 'disabled' : ''}>${current.content || ''}</textarea>
      </label>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Phông chữ' : 'Font family'}</span>
          <select name="fontFamily" ${disabled ? 'disabled' : ''}>
            <option value="Inter"${current.fontFamily === 'Inter' ? ' selected' : ''}>Inter</option>
            <option value="Roboto"${current.fontFamily === 'Roboto' ? ' selected' : ''}>Roboto</option>
            <option value="'Great Vibes', cursive"${current.fontFamily.includes('Great Vibes') ? ' selected' : ''}>Great Vibes</option>
            <option value="'Pacifico', cursive"${current.fontFamily.includes('Pacifico') ? ' selected' : ''}>Pacifico</option>
            <option value="system-ui"${current.fontFamily === 'system-ui' ? ' selected' : ''}>System UI</option>
          </select>
        </label>
      </div>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Kích thước (px)' : 'Font size (px)'}</span>
          <input type="number" name="fontSize" min="8" max="220" value="${current.fontSize || 72}" ${disabled ? 'disabled' : ''}>
        </label>
        <label>
          <span>${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
          <input type="range" name="opacity" min="10" max="100" value="${Math.round((current.opacity ?? 1) * 100)}" ${disabled ? 'disabled' : ''}>
        </label>
      </div>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Màu chữ' : 'Fill color'}</span>
          <input type="color" name="color" value="${current.color || '#0F172A'}" ${disabled ? 'disabled' : ''}>
        </label>
        <label>
          <span>${state.locale === 'vi' ? 'Viền (px)' : 'Stroke (px)'}</span>
          <input type="number" name="strokeWidth" min="0" max="12" value="${current.strokeWidth || 0}" ${disabled ? 'disabled' : ''}>
        </label>
      </div>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Màu viền' : 'Stroke color'}</span>
        <input type="color" name="strokeColor" value="${current.strokeColor || '#ffffff'}" ${disabled ? 'disabled' : ''}>
      </label>
      <label class="switch field">
        <input type="checkbox" name="shadow" ${current.shadow?.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span>${state.locale === 'vi' ? 'Đổ bóng chữ' : 'Drop shadow'}</span>
      </label>
      <div class="field">
        <span>${state.locale === 'vi' ? 'Căn lề' : 'Align'}</span>
        <div class="chip-set">
          <button type="button" class="chip${current.align === 'left' ? ' is-active' : ''}" data-align="left"${disabled ? ' disabled' : ''}>${state.locale === 'vi' ? 'Trái' : 'Left'}</button>
          <button type="button" class="chip${current.align === 'center' ? ' is-active' : ''}" data-align="center"${disabled ? ' disabled' : ''}>${state.locale === 'vi' ? 'Giữa' : 'Center'}</button>
          <button type="button" class="chip${current.align === 'right' ? ' is-active' : ''}" data-align="right"${disabled ? ' disabled' : ''}>${state.locale === 'vi' ? 'Phải' : 'Right'}</button>
        </div>
      </div>
    </form>
  `;
  const form = container.querySelector('#textToolForm');
  if (!form) return;
  const handleChange = () => {
    const data = new FormData(form);
    const updates = {
      content: data.get('content'),
      fontFamily: data.get('fontFamily'),
      fontSize: parseFloat(data.get('fontSize')),
      opacity: parseFloat(data.get('opacity')) / 100,
      color: data.get('color'),
      strokeWidth: parseFloat(data.get('strokeWidth')) || 0,
      strokeColor: data.get('strokeColor'),
      shadow: {
        ...(current.shadow || {}),
        enabled: form.elements.shadow.checked,
      },
    };
    if (layer && layer.type === layerTypes.TEXT) {
      updateLayer(image.id, layer.id, updates);
      renderer.render();
    } else {
      Object.assign(toolDefaults[layerTypes.TEXT], updates);
    }
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  form.querySelectorAll('[data-align]').forEach(button => {
    button.addEventListener('click', () => {
      form.querySelectorAll('[data-align]').forEach(btn => btn.classList.remove('is-active'));
      button.classList.add('is-active');
      if (layer && layer.type === layerTypes.TEXT) {
        updateLayer(image.id, layer.id, { align: button.dataset.align });
        renderer.render();
      } else {
        toolDefaults[layerTypes.TEXT].align = button.dataset.align;
      }
    });
  });
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderPenPanel(container) {
  const form = document.createElement('form');
  form.className = 'form-grid';
  form.innerHTML = `
    <label class="field">
      <span>${state.locale === 'vi' ? 'Màu bút' : 'Pen color'}</span>
      <input type="color" name="color" value="${toolDefaults[layerTypes.PEN].color}">
    </label>
    <label class="field">
      <span>${state.locale === 'vi' ? 'Độ dày nét' : 'Stroke width'}</span>
      <input type="range" name="size" min="1" max="48" value="${toolDefaults[layerTypes.PEN].size}">
    </label>
    <label class="field">
      <span>${state.locale === 'vi' ? 'Smooth' : 'Smoothing'}</span>
      <input type="range" name="smoothing" min="0" max="1" step="0.05" value="${toolDefaults[layerTypes.PEN].smoothing}">
    </label>
    <label class="switch field">
      <input type="checkbox" name="roundCap" ${toolDefaults[layerTypes.PEN].roundCap ? 'checked' : ''}>
      <span>${state.locale === 'vi' ? 'Đầu tròn' : 'Round cap'}</span>
    </label>
    <div class="chip-set">
      <button type="button" class="chip" data-action="pen-undo">Undo</button>
      <button type="button" class="chip" data-action="pen-clear">${state.locale === 'vi' ? 'Xoá nét' : 'Clear'}</button>
    </div>
  `;
  container.appendChild(form);
  const handleChange = () => {
    const data = new FormData(form);
    toolDefaults[layerTypes.PEN] = {
      color: data.get('color'),
      size: parseFloat(data.get('size')),
      smoothing: parseFloat(data.get('smoothing')),
      roundCap: form.elements.roundCap.checked,
    };
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  form.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      const image = getActiveImage();
      if (!image) return;
      const layer = getLayer(image.id, state.activeLayerId);
      if (!layer || layer.type !== layerTypes.PEN) return;
      if (action === 'pen-clear') {
        updateLayer(image.id, layer.id, { strokes: [] });
      } else if (action === 'pen-undo') {
        const strokes = layer.strokes?.slice() || [];
        strokes.pop();
        updateLayer(image.id, layer.id, { strokes });
      }
      renderer.render();
    });
  });
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderLogoPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const disabled = !(layer && layer.type === layerTypes.LOGO);
  container.innerHTML = `
    <div class="upload-card">
      <p>${state.locale === 'vi' ? 'Tải logo PNG/SVG' : 'Upload PNG/SVG logo'}</p>
      <button type="button" class="btn primary" data-action="pick-logo">
        <svg class="icon"><use href="#icon-upload"></use></svg>
        <span>${state.locale === 'vi' ? 'Chọn logo' : 'Choose logo'}</span>
      </button>
    </div>
    <form id="logoForm" class="form-grid">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Scale (%)' : 'Scale (%)'}</span>
        <input type="range" name="scale" min="10" max="200" value="${Math.round((layer?.scale ?? toolDefaults[layerTypes.LOGO].scale) * 100)}" ${disabled ? 'disabled' : ''}>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
        <input type="range" name="opacity" min="10" max="100" value="${Math.round((layer?.opacity ?? toolDefaults[layerTypes.LOGO].opacity) * 100)}" ${disabled ? 'disabled' : ''}>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Góc xoay' : 'Rotation'}</span>
        <input type="range" name="rotation" min="-180" max="180" value="${layer?.rotation ?? toolDefaults[layerTypes.LOGO].rotation}" ${disabled ? 'disabled' : ''}>
      </label>
    </form>
  `;
  container.querySelector('[data-action="pick-logo"]')?.addEventListener('click', () => logoInput?.click());
  const form = container.querySelector('#logoForm');
  if (!form) return;
  const handleChange = () => {
    const imageState = getActiveImage();
    if (!imageState) return;
    const activeLayer = getLayer(imageState.id, state.activeLayerId);
    const values = {
      scale: parseFloat(form.elements.scale.value) / 100,
      opacity: parseFloat(form.elements.opacity.value) / 100,
      rotation: parseFloat(form.elements.rotation.value),
    };
    if (activeLayer && activeLayer.type === layerTypes.LOGO) {
      updateLayer(imageState.id, activeLayer.id, values);
      renderer.render();
    } else {
      Object.assign(toolDefaults[layerTypes.LOGO], values);
    }
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderWatermarkPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const current = layer?.type === layerTypes.WATERMARK ? layer : toolDefaults[layerTypes.WATERMARK];
  const disabled = !(layer && layer.type === layerTypes.WATERMARK);
  container.innerHTML = `
    <form id="watermarkForm" class="form-grid">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Nội dung watermark' : 'Watermark text'}</span>
        <textarea name="text" rows="2" ${disabled ? 'disabled' : ''}>${current.text}</textarea>
      </label>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Kích thước' : 'Font size'}</span>
          <input type="number" name="fontSize" min="12" max="140" value="${current.fontSize}" ${disabled ? 'disabled' : ''}>
        </label>
        <label>
          <span>${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
          <input type="range" name="opacity" min="5" max="80" value="${Math.round((current.opacity ?? 0.25) * 100)}" ${disabled ? 'disabled' : ''}>
        </label>
      </div>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Góc xoay' : 'Angle'}</span>
          <select name="angle"${disabled ? ' disabled' : ''}>
            <option value="-45"${current.angle === -45 ? ' selected' : ''}>-45°</option>
            <option value="45"${current.angle === 45 ? ' selected' : ''}>45°</option>
          </select>
        </label>
        <label>
          <span>${state.locale === 'vi' ? 'Cách ngang' : 'Spacing X'}</span>
          <input type="number" name="spacingX" min="60" max="400" value="${current.spacingX}" ${disabled ? 'disabled' : ''}>
        </label>
      </div>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Cách dọc' : 'Spacing Y'}</span>
        <input type="number" name="spacingY" min="40" max="400" value="${current.spacingY}" ${disabled ? 'disabled' : ''}>
      </label>
    </form>
    <button type="button" class="btn primary" data-action="add-watermark"${disabled ? '' : ' hidden'}>
      ${state.locale === 'vi' ? 'Thêm watermark' : 'Add watermark'}
    </button>
  `;
  const form = container.querySelector('#watermarkForm');
  if (!form) return;
  const handleChange = () => {
    const values = {
      text: form.elements.text.value,
      fontSize: parseFloat(form.elements.fontSize.value),
      opacity: parseFloat(form.elements.opacity.value) / 100,
      angle: parseFloat(form.elements.angle.value),
      spacingX: parseFloat(form.elements.spacingX.value),
      spacingY: parseFloat(form.elements.spacingY.value),
    };
    if (layer && layer.type === layerTypes.WATERMARK) {
      updateLayer(image.id, layer.id, values);
      renderer.render();
    } else {
      Object.assign(toolDefaults[layerTypes.WATERMARK], values);
    }
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  container.querySelector('[data-action="add-watermark"]')?.addEventListener('click', () => {
    const imageState = getActiveImage();
    if (!imageState) return;
    const newLayer = addLayer(imageState.id, {
      type: layerTypes.WATERMARK,
      ...toolDefaults[layerTypes.WATERMARK],
    });
    setActiveLayer(newLayer.id);
    renderer.render();
    renderToolPanel(layerTypes.WATERMARK);
  });
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderQrPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const current = layer?.type === layerTypes.QR ? layer : toolDefaults[layerTypes.QR];
  const disabled = !(layer && layer.type === layerTypes.QR);
  container.innerHTML = `
    <form id="qrForm" class="form-grid">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Nội dung chữ ký' : 'Signature content'}</span>
        <textarea name="text" rows="3" ${disabled ? 'disabled' : ''}>${current.text}</textarea>
      </label>
      <div class="field two-col">
        <label>
          <span>${state.locale === 'vi' ? 'Kích thước' : 'Size'}</span>
          <input type="number" name="size" min="80" max="480" value="${current.size}" ${disabled ? 'disabled' : ''}>
        </label>
        <label>
          <span>Margin</span>
          <input type="number" name="margin" min="0" max="40" value="${current.margin}" ${disabled ? 'disabled' : ''}>
        </label>
      </div>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
        <input type="range" name="opacity" min="10" max="100" value="${Math.round((current.opacity ?? 1) * 100)}" ${disabled ? 'disabled' : ''}>
      </label>
      <label class="switch field">
        <input type="checkbox" name="applyAll" ${current.applyAll ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span>${state.locale === 'vi' ? 'Áp dụng cho batch' : 'Apply to batch'}</span>
      </label>
      <button type="button" class="btn secondary" data-action="preview"${disabled ? ' disabled' : ''}>
        <svg class="icon"><use href="#icon-camera"></use></svg>
        <span>${state.locale === 'vi' ? 'Quét thử bằng camera' : 'Preview'}</span>
      </button>
    </form>
    <button type="button" class="btn primary" data-action="create"${disabled ? '' : ' hidden'}>
      ${state.locale === 'vi' ? 'Tạo QR chữ ký' : 'Create signature QR'}
    </button>
  `;
  const form = container.querySelector('#qrForm');
  if (!form) return;
  const handleChange = async () => {
    const data = new FormData(form);
    const values = {
      text: data.get('text'),
      size: parseInt(data.get('size'), 10),
      margin: parseInt(data.get('margin'), 10),
      opacity: parseFloat(data.get('opacity')) / 100,
      applyAll: form.elements.applyAll.checked,
    };
    if (layer && layer.type === layerTypes.QR) {
      const generated = await generateQr(values);
      updateLayer(image.id, layer.id, { ...values, ...generated });
      renderer.render();
    } else {
      Object.assign(toolDefaults[layerTypes.QR], values);
    }
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  container.querySelector('[data-action="preview"]')?.addEventListener('click', () => {
    if (!(layer && layer.type === layerTypes.QR && layer.dataUrl)) return;
    const canvas = document.getElementById('qrPreviewCanvas');
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const size = Math.min(canvas.width, canvas.height) - 24;
      ctx.drawImage(img, (canvas.width - size) / 2, (canvas.height - size) / 2, size, size);
      showQrPreview();
    };
    img.src = layer.dataUrl;
  });
  container.querySelector('[data-action="create"]')?.addEventListener('click', async () => {
    const imageState = getActiveImage();
    if (!imageState) return;
    const values = toolDefaults[layerTypes.QR];
    const generated = await generateQr(values);
    const newLayer = addLayer(imageState.id, {
      type: layerTypes.QR,
      ...values,
      ...generated,
    });
    setActiveLayer(newLayer.id);
    renderer.render();
    renderToolPanel(layerTypes.QR);
  });
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

async function generateQr(values) {
  return new Promise(resolve => {
    if (!window.QRCode) {
      resolve({});
      return;
    }
    const temp = document.createElement('div');
    const qr = new window.QRCode(temp, {
      text: values.text || '',
      width: values.size,
      height: values.size,
      margin: values.margin ?? 12,
    });
    setTimeout(() => {
      const dataUrl = temp.querySelector('img')?.src || temp.querySelector('canvas')?.toDataURL('image/png');
      temp.remove();
      resolve({ dataUrl });
    }, 40);
  });
}

function renderBlurPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const current = layer?.type === layerTypes.BLUR ? layer : toolDefaults[layerTypes.BLUR];
  const disabled = !(layer && layer.type === layerTypes.BLUR);
  container.innerHTML = `
    <form id="blurForm" class="form-grid">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Chế độ' : 'Mode'}</span>
        <select name="mode"${disabled ? ' disabled' : ''}>
          <option value="blur"${current.mode === 'blur' ? ' selected' : ''}>Blur</option>
          <option value="pixelate"${current.mode === 'pixelate' ? ' selected' : ''}>Pixelate</option>
        </select>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Cường độ' : 'Intensity'}</span>
        <input type="range" name="intensity" min="2" max="40" value="${current.intensity}" ${disabled ? 'disabled' : ''}>
      </label>
      <p class="empty-hint">${state.locale === 'vi' ? 'Kéo trên canvas để chọn vùng cần làm mờ.' : 'Drag on canvas to select region.'}</p>
    </form>
  `;
  const form = container.querySelector('#blurForm');
  if (!form) return;
  const handleChange = () => {
    const values = {
      mode: form.elements.mode.value,
      intensity: parseFloat(form.elements.intensity.value),
    };
    if (layer && layer.type === layerTypes.BLUR) {
      updateLayer(image.id, layer.id, values);
      renderer.render();
    } else {
      Object.assign(toolDefaults[layerTypes.BLUR], values);
    }
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderExportPanel(container) {
  const image = getActiveImage();
  container.innerHTML = `
    <form id="exportForm" class="form-grid">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Định dạng' : 'Format'}</span>
        <select name="format">
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
        </select>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Scale (%)' : 'Scale (%)'}</span>
        <input type="range" name="scale" min="25" max="200" value="100">
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Quality' : 'Quality'}</span>
        <input type="range" name="quality" min="60" max="100" value="92">
      </label>
      <button type="button" class="btn primary" data-action="download"${image ? '' : ' disabled'}>
        <svg class="icon"><use href="#icon-download"></use></svg>
        <span>${state.locale === 'vi' ? 'Tải ảnh' : 'Download'}</span>
      </button>
    </form>
  `;
  const form = container.querySelector('#exportForm');
  if (!form) return;
  form.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action !== 'download') return;
    const imageState = getActiveImage();
    if (!imageState) return;
    const formData = new FormData(form);
    const options = {
      format: formData.get('format'),
      scale: parseInt(formData.get('scale'), 10) / 100,
      quality: parseInt(formData.get('quality'), 10) / 100,
    };
    const blob = await exportImageToBlob(imageState, options);
    if (blob) {
      window.saveAs(blob, buildExportFileName(imageState.name, options.format));
    }
  });
}

async function exportImageToBlob(image, options) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * options.scale);
  canvas.height = Math.round(image.height * options.scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);
  for (const layer of image.layers) {
    if (!layer.visible) continue;
    drawLayerForExport(ctx, image, layer, options.scale);
  }
  const type = options.format === 'png' ? 'image/png' : options.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), type, options.quality);
  });
}

function drawLayerForExport(ctx, image, layer, scale) {
  const tempRenderer = new CanvasRenderer(ctx.canvas, ctx.canvas);
  tempRenderer.ctx = ctx;
  tempRenderer.dpr = 1;
  tempRenderer.view = { scale, offset: { x: 0, y: 0 } };
  tempRenderer.drawLayer(ctx, { width: image.width * scale, height: image.height * scale }, layer);
}

function buildExportFileName(name, format) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}-signed.${format}`;
}

function renderBatchPanel(container) {
  container.innerHTML = `
    <div class="batch-summary">
      <p>${state.locale === 'vi' ? 'Ảnh đã nạp' : 'Loaded photos'}: <strong>${state.images.length}</strong></p>
      <div class="chip-set">
        <button type="button" class="chip" data-action="batch-preset">${state.locale === 'vi' ? 'Áp dụng preset' : 'Apply preset'}</button>
        <button type="button" class="chip" data-action="batch-export"${state.images.length ? '' : ' disabled'}>${state.locale === 'vi' ? 'Ký tất cả → ZIP' : 'Sign all → ZIP'}</button>
      </div>
    </div>
  `;
  container.querySelector('[data-action="batch-preset"]')?.addEventListener('click', handleApplyPresetBatch);
  container.querySelector('[data-action="batch-export"]')?.addEventListener('click', handleExportZip);
}

function handleApplyPresetBatch() {
  if (!state.presets.length) {
    togglePresetPanel(true);
    showToast({
      title: state.locale === 'vi' ? 'Chưa có preset' : 'No preset available',
      tone: 'warn',
    });
    return;
  }
  const preset = state.presets[0];
  state.images.forEach(image => {
    addLayer(image.id, { type: layerTypes.TEXT, ...preset.payload });
  });
  renderer.render();
  showToast({
    title: state.locale === 'vi' ? 'Preset áp dụng' : 'Preset applied',
    tone: 'success',
  });
}

async function handleExportZip() {
  if (!state.images.length) return;
  const zip = new window.JSZip();
  for (const image of state.images) {
    const blob = await exportImageToBlob(image, { format: 'png', scale: 1, quality: 0.95 });
    if (blob) {
      zip.file(buildExportFileName(image.name, 'png'), blob);
    }
  }
  const content = await zip.generateAsync({ type: 'blob' });
  window.saveAs(content, 'ky-anh-batch.zip');
  showToast({
    title: state.locale === 'vi' ? 'ZIP đã sẵn sàng' : 'ZIP ready',
    tone: 'success',
  });
}

document.addEventListener('DOMContentLoaded', init);
