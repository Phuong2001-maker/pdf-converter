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
  renderFontShowcase,
  markActiveFont,
  renderSignatureStyles,
  markActiveSignaturePreset,
  bindLayerReorder,
} from './ui.js';

const canvas = document.getElementById('editorCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const dropzone = document.getElementById('canvasDropzone');
const fileInput = document.getElementById('imageInput');
const logoInput = document.getElementById('logoInput');
const canvasBoard = document.getElementById('canvasBoard');
const selectionOverlay = document.getElementById('selectionOverlay');
const workspaceToolbar = document.getElementById('workspaceToolbar');
const selectFilesButton = document.querySelector('[data-action="select-files"]');
const useSampleButton = document.querySelector('[data-action="use-sample"]');
const layerAddTextButton = document.querySelector('[data-action="add-layer-text"]');
const deleteLayerButton = document.querySelector('[data-action="delete-layer"]');
const savePresetButton = document.querySelector('[data-action="save-preset"]');
const textStyleToolbar = document.getElementById('textStyleToolbar');
const textToolbarDivider = document.getElementById('textToolbarDivider');
const textFontSizeInput = document.getElementById('textFontSize');
const textFillColorInput = document.getElementById('textFillColor');
const textStrokeWidthInput = document.getElementById('textStrokeWidth');
const textStrokeColorInput = document.getElementById('textStrokeColor');
const textShadowToggle = document.getElementById('textShadowToggle');
const textAlignButtons = Array.from(document.querySelectorAll('.text-align-btn'));
const textLetterSpacingInput = document.getElementById('textLetterSpacing');
const textStyleToggleButtons = Array.from(document.querySelectorAll('[data-text-style]'));
const fontPickerSelect = document.getElementById('fontPickerSelect');
const fontPickerControl = document.getElementById('fontPickerControl');

const renderer = new CanvasRenderer(canvas, overlayCanvas);
const immediateRender = renderer.render.bind(renderer);
renderer.renderNow = (...args) => {
  immediateRender(...args);
  syncSelectionOverlay();
};
renderer.render = function renderWithOverlay(...args) {
  immediateRender(...args);
  queueOverlaySync();
};
let toolPanelCleanup = null;
let penStroke = null;
let blurSelection = null;
let dragLayer = null;
let panSession = null;
let resizeSession = null;
let isSpacePressed = false;
let renderScheduled = false;
const pointerCache = new Map();
let pinchState = null;
let activeSignaturePresetId = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const isEditableTarget = target => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (!tag) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
};
const MIN_TEXT_FONT = 12;
const MAX_TEXT_FONT = 640;
const MIN_TEXT_BOUNDS = 24;
const getLayerBounds = (layer, image) => {
  if (!layer?.bounds || !image) return null;
  return {
    x: layer.bounds.x * image.width,
    y: layer.bounds.y * image.height,
    width: layer.bounds.width * image.width,
    height: layer.bounds.height * image.height,
  };
};
const isPointInsideBounds = (bounds, px, py) => {
  if (!bounds) return false;
  return px >= bounds.x && px <= bounds.x + bounds.width && py >= bounds.y && py <= bounds.y + bounds.height;
};
const reanchorTextLayerToAlign = (image, layer, alignOverride) => {
  if (!image || !layer || layer.type !== layerTypes.TEXT) return false;
  const bounds = layer.bounds;
  if (!bounds) return false;
  const align = alignOverride || layer.align || 'center';
  const widthRatio = clamp(bounds.width ?? 0, 0, 1);
  let minX = 0.5;
  let maxX = 0.5;
  if (widthRatio > 0 && widthRatio < 1) {
    minX = widthRatio / 2;
    maxX = 1 - widthRatio / 2;
  }
  let desiredX = layer.position?.x ?? 0.5;
  if (align === 'left') {
    desiredX = minX;
  } else if (align === 'right') {
    desiredX = maxX;
  } else if (align === 'center') {
    desiredX = 0.5;
  } else {
    return false;
  }
  const clampedX = clamp(desiredX, minX, maxX);
  const currentX = layer.position?.x ?? 0.5;
  if (Math.abs(currentX - clampedX) < 1e-4) return false;
  if (!layer.position) {
    layer.position = { x: clampedX, y: 0.5 };
  } else {
    layer.position = { ...layer.position, x: clampedX };
  }
  return true;
};
const hideSelectionOverlay = () => {
  if (!selectionOverlay) return;
  selectionOverlay.classList.remove('is-active');
  selectionOverlay.style.width = '0px';
  selectionOverlay.style.height = '0px';
  selectionOverlay.dataset.layerId = '';
};
const syncSelectionOverlay = () => {
  if (!selectionOverlay) return;
  const image = getActiveImage();
  if (!image) {
    hideSelectionOverlay();
    return;
  }
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer || layer.type !== layerTypes.TEXT || layer.visible === false) {
    hideSelectionOverlay();
    return;
  }
  const bounds = getLayerBounds(layer, image);
  if (!bounds || bounds.width < 1 || bounds.height < 1) {
    hideSelectionOverlay();
    return;
  }
  const topLeft = renderer.imageToScreen(bounds.x, bounds.y);
  const bottomRight = renderer.imageToScreen(bounds.x + bounds.width, bounds.y + bounds.height);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    hideSelectionOverlay();
    return;
  }
  selectionOverlay.style.transform = `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`;
  selectionOverlay.style.width = `${width}px`;
  selectionOverlay.style.height = `${height}px`;
  selectionOverlay.dataset.layerId = layer.id;
  selectionOverlay.classList.add('is-active');
};
const queueOverlaySync = () => {
  if (!selectionOverlay) return;
  syncSelectionOverlay();
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    syncSelectionOverlay();
  });
};
const findLayerAtPoint = (image, pointer) => {
  if (!image || !pointer) return null;
  const px = pointer.x / image.width;
  const py = pointer.y / image.height;
  for (let i = image.layers.length - 1; i >= 0; i -= 1) {
    const layer = image.layers[i];
    if (!layer || layer.visible === false) continue;
    if (layer.type === layerTypes.TEXT) {
      const bounds = layer.bounds;
      if (!bounds) continue;
      if (
        px >= bounds.x &&
        px <= bounds.x + bounds.width &&
        py >= bounds.y &&
        py <= bounds.y + bounds.height
      ) {
        return layer;
      }
    } else if (layer.position) {
      const distance = Math.hypot(px - layer.position.x, py - layer.position.y);
      if (distance < 0.04) {
        return layer;
      }
    }
  }
  return null;
};
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;

const FONT_SUGGESTIONS = [
  { value: "'Great Vibes', cursive", label: 'Great Vibes', sample: 'Nguyễn Văn A' },
  { value: "'Dancing Script', cursive", label: 'Dancing Script', sample: 'Trần Minh Khoa', weight: 600 },
  { value: "'Pacifico', cursive", label: 'Pacifico', sample: 'Thiên Ân' },
  { value: "'Sacramento', cursive", label: 'Sacramento', sample: 'Ngô Hải Đăng' },
  { value: "'Allura', cursive", label: 'Allura', sample: 'Phạm Bảo Trâm' },
  { value: "'Playball', cursive", label: 'Playball', sample: 'Lê Hữu Phát' },
];

const SIGNATURE_PRESETS = [
  {
    id: 'royal-blue',
    name: 'Royal Blue',
    tagline: 'Elegant',
    previewText: 'Nguyễn Văn A',
    fontFamily: "'Great Vibes', cursive",
    fontWeight: 400,
    color: '#0F172A',
    previewColor: '#0F172A',
    text: 'Nguyễn Văn A',
    letterSpacing: 1,
    fontSize: 118,
    shadow: {
      enabled: true,
      blur: 18,
      offsetX: 0,
      offsetY: 12,
      color: 'rgba(15, 23, 42, 0.28)',
    },
    background: 'linear-gradient(135deg, #DBEAFE, #EFF6FF)',
    borderColor: '#93C5FD',
  },
  {
    id: 'sunset-rose',
    name: 'Sunset Rose',
    tagline: 'Romantic',
    previewText: 'Trần Bảo Ngọc',
    fontFamily: "'Dancing Script', cursive",
    fontWeight: 600,
    color: '#B91C1C',
    previewColor: '#B91C1C',
    text: 'Trần Bảo Ngọc',
    letterSpacing: 2,
    fontSize: 110,
    shadow: {
      enabled: true,
      blur: 16,
      offsetX: 0,
      offsetY: 10,
      color: 'rgba(185, 28, 28, 0.28)',
    },
    background: 'linear-gradient(135deg, #FEE2E2, #FDE68A)',
    borderColor: '#FCA5A5',
  },
  {
    id: 'midnight-gold',
    name: 'Midnight Gold',
    tagline: 'Luxury',
    previewText: 'Lê Gia Huy',
    fontFamily: "'Sacramento', cursive",
    fontWeight: 400,
    color: '#F59E0B',
    previewColor: '#F59E0B',
    text: 'Lê Gia Huy',
    letterSpacing: 3,
    fontSize: 122,
    shadow: {
      enabled: true,
      blur: 20,
      offsetX: 0,
      offsetY: 14,
      color: 'rgba(17, 24, 39, 0.35)',
    },
    strokeWidth: 1,
    strokeColor: 'rgba(17, 24, 39, 0.45)',
    background: 'linear-gradient(135deg, #0F172A, #1F2937)',
    borderColor: '#F59E0B',
    tone: 'dark',
  },
  {
    id: 'silver-stream',
    name: 'Silver Stream',
    tagline: 'Modern',
    previewText: 'Phạm Thu Hà',
    fontFamily: "'Allura', cursive",
    fontWeight: 400,
    color: '#2563EB',
    previewColor: '#2563EB',
    text: 'Phạm Thu Hà',
    letterSpacing: 0.5,
    fontSize: 112,
    shadow: {
      enabled: true,
      blur: 14,
      offsetX: 0,
      offsetY: 9,
      color: 'rgba(37, 99, 235, 0.24)',
    },
    background: 'linear-gradient(135deg, #EEF2FF, #E0E7FF)',
    borderColor: '#93C5FD',
  },
  {
    id: 'sport-vibe',
    name: 'Sport Vibe',
    tagline: 'Bold',
    previewText: 'Ngô Quang Vũ',
    fontFamily: "'Playball', cursive",
    fontWeight: 400,
    color: '#111827',
    previewColor: '#111827',
    text: 'Ngô Quang Vũ',
    letterSpacing: 1,
    fontSize: 108,
    shadow: {
      enabled: true,
      blur: 12,
      offsetX: 0,
      offsetY: 8,
      color: 'rgba(17, 24, 39, 0.22)',
    },
    background: 'linear-gradient(135deg, #F3F4F6, #E5E7EB)',
    borderColor: '#94A3B8',
  },
];

const PEN_COLOR_PRESETS = [
  '#0F172A',
  '#1E293B',
  '#2563EB',
  '#0EA5E9',
  '#9333EA',
  '#F97316',
  '#FACC15',
  '#FFFFFF',
];

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
    underline: false,
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
  },
  [layerTypes.BLUR]: {
    mode: 'blur',
    intensity: 12,
  },
};

function resolveTextContext() {
  const image = getActiveImage();
  if (!image) {
    return { image: null, layer: null, style: toolDefaults[layerTypes.TEXT] };
  }
  const layer = getLayer(image.id, state.activeLayerId);
  if (layer && layer.type === layerTypes.TEXT) {
    return { image, layer, style: layer };
  }
  return { image, layer: null, style: toolDefaults[layerTypes.TEXT] };
}

function toggleTextToolbar(visible) {
  if (textStyleToolbar) {
    textStyleToolbar.hidden = !visible;
  }
  if (textToolbarDivider) {
    textToolbarDivider.hidden = !visible;
  }
  if (fontPickerControl) {
    fontPickerControl.hidden = !visible;
  }
}

function applyTextStyleUpdates(updates = {}) {
  activeSignaturePresetId = null;
  markActiveSignaturePreset(null);
  delete toolDefaults[layerTypes.TEXT].signaturePresetId;
  delete toolDefaults[layerTypes.TEXT].signaturePresetName;
  const { image, layer, style } = resolveTextContext();
  const nextUpdates = { ...updates };
  nextUpdates.signaturePresetId = null;
  nextUpdates.signaturePresetName = null;
  if (Object.prototype.hasOwnProperty.call(nextUpdates, 'shadow')) {
    nextUpdates.shadow = {
      ...(style.shadow || {}),
      ...(nextUpdates.shadow || {}),
    };
  }
  if (layer && Object.prototype.hasOwnProperty.call(nextUpdates, 'align') && image) {
    const normalizedBounds = layer.bounds;
    const bounds = normalizedBounds
      ? {
          width: normalizedBounds.width * image.width,
          height: normalizedBounds.height * image.height,
        }
      : getLayerBounds(layer, image);
    const widthRatio = bounds && image.width ? clamp((bounds.width || 0) / image.width, 0, 1) : 0;
    if (widthRatio > 0 && widthRatio < 1) {
      let targetX = layer.position?.x ?? 0.5;
      if (nextUpdates.align === 'left') {
        targetX = widthRatio / 2;
      } else if (nextUpdates.align === 'right') {
        targetX = 1 - widthRatio / 2;
      } else {
        targetX = 0.5;
      }
      const clampedX = clamp(targetX, widthRatio / 2, 1 - widthRatio / 2);
      nextUpdates.position = {
        ...(layer.position || {}),
        x: clampedX,
      };
    } else if (nextUpdates.align === 'center') {
      nextUpdates.position = {
        ...(layer.position || {}),
        x: 0.5,
      };
    }
  }
  const alignChange = Object.prototype.hasOwnProperty.call(nextUpdates, 'align');
  const uppercaseChange = Object.prototype.hasOwnProperty.call(nextUpdates, 'uppercase');
  if (layer) {
    const updatedLayer = updateLayer(image.id, layer.id, nextUpdates);
    renderer.render();
    if (updatedLayer && image && (alignChange || uppercaseChange)) {
      const didAdjust = reanchorTextLayerToAlign(image, updatedLayer, nextUpdates.align);
      if (didAdjust) {
        renderer.render();
      }
    }
  } else {
    Object.assign(toolDefaults[layerTypes.TEXT], nextUpdates);
  }
  if (state.activeTool === layerTypes.TEXT) {
    syncTextStyleControls();
  }
}

function syncTextStyleControls() {
  if (!textStyleToolbar) return;
  const { layer, style } = resolveTextContext();
  const hasLayer = Boolean(layer);
  const fontValue = style.fontFamily || 'Inter';
  const fillColor = typeof style.color === 'string' && style.color.startsWith('#') ? style.color : '#0F172A';
  const outlineColor = typeof style.strokeColor === 'string' && style.strokeColor.startsWith('#') ? style.strokeColor : '#ffffff';
  if (textFontSizeInput) {
    textFontSizeInput.value = Math.round(style.fontSize || 72);
    textFontSizeInput.disabled = !hasLayer;
  }
  if (textFillColorInput) {
    textFillColorInput.value = fillColor;
    textFillColorInput.disabled = !hasLayer;
  }
  if (textStrokeWidthInput) {
    textStrokeWidthInput.value = style.strokeWidth ?? 0;
    textStrokeWidthInput.disabled = !hasLayer;
  }
  if (textStrokeColorInput) {
    textStrokeColorInput.value = outlineColor;
    textStrokeColorInput.disabled = !hasLayer;
  }
  if (textLetterSpacingInput) {
    textLetterSpacingInput.value = style.letterSpacing ?? 0;
    textLetterSpacingInput.disabled = !hasLayer;
  }
  if (textShadowToggle) {
    const active = Boolean(style.shadow?.enabled);
    textShadowToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    textShadowToggle.classList.toggle('is-active', active);
    textShadowToggle.disabled = !hasLayer;
  }
  if (textStyleToggleButtons.length) {
    textStyleToggleButtons.forEach(button => {
      const styleKey = button.dataset.textStyle;
      let isActive = false;
      if (styleKey === 'bold') {
        isActive = (style.fontWeight ?? 400) >= 600;
      } else if (styleKey === 'italic') {
        isActive = Boolean(style.italic);
      } else if (styleKey === 'underline') {
        isActive = Boolean(style.underline);
      } else if (styleKey === 'uppercase') {
        isActive = Boolean(style.uppercase);
      }
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.classList.toggle('is-active', isActive);
      button.disabled = !hasLayer;
    });
  }
  if (textAlignButtons.length) {
    textAlignButtons.forEach(button => {
      button.classList.toggle('is-active', style.align === button.dataset.align);
      button.disabled = !hasLayer;
    });
  }
  if (fontPickerSelect) {
    const matchingOption = Array.from(fontPickerSelect.options).some(option => option.value === fontValue);
    fontPickerSelect.value = matchingOption ? fontValue : 'Inter';
    fontPickerSelect.disabled = !hasLayer;
  }
  markActiveFont(fontValue);
  const presetId = layer?.signaturePresetId ?? activeSignaturePresetId;
  markActiveSignaturePreset(presetId);
  const textForm = document.getElementById('textToolForm');
  if (textForm) {
    const contentField = textForm.elements.content;
    if (contentField && document.activeElement !== contentField) {
      contentField.value = style.content || '';
    }
    const opacityField = textForm.elements.opacity;
    if (opacityField) {
      const opacityValue = Math.round((style.opacity ?? 1) * 100);
      opacityField.value = opacityValue;
      const display = textForm.querySelector('[data-field="opacity-display"]');
      if (display) {
        display.textContent = `${opacityValue}%`;
      }
    }
  }
}

function setupTextToolbar() {
  textFontSizeInput?.addEventListener('input', event => {
    if (textFontSizeInput.disabled) return;
    const value = parseFloat(event.target.value);
    if (Number.isNaN(value)) return;
    const clamped = clamp(value, parseFloat(textFontSizeInput.min) || 8, parseFloat(textFontSizeInput.max) || 220);
    textFontSizeInput.value = clamped;
    applyTextStyleUpdates({ fontSize: clamped });
  });

  textFillColorInput?.addEventListener('input', event => {
    if (textFillColorInput.disabled) return;
    applyTextStyleUpdates({ color: event.target.value });
  });

  textStrokeWidthInput?.addEventListener('input', event => {
    if (textStrokeWidthInput.disabled) return;
    const min = parseFloat(textStrokeWidthInput.min) || 0;
    const max = parseFloat(textStrokeWidthInput.max) || 12;
    const value = clamp(parseFloat(event.target.value) || 0, min, max);
    textStrokeWidthInput.value = value;
    applyTextStyleUpdates({ strokeWidth: value });
  });

  textStrokeColorInput?.addEventListener('input', event => {
    if (textStrokeColorInput.disabled) return;
    applyTextStyleUpdates({ strokeColor: event.target.value });
  });

  textLetterSpacingInput?.addEventListener('input', event => {
    if (textLetterSpacingInput.disabled) return;
    const value = parseFloat(event.target.value);
    if (Number.isNaN(value)) return;
    const min = parseFloat(textLetterSpacingInput.min) || -20;
    const max = parseFloat(textLetterSpacingInput.max) || 60;
    const clamped = clamp(value, min, max);
    textLetterSpacingInput.value = clamped;
    applyTextStyleUpdates({ letterSpacing: clamped });
  });

  textShadowToggle?.addEventListener('click', () => {
    if (textShadowToggle.disabled) return;
    const next = textShadowToggle.getAttribute('aria-pressed') !== 'true';
    applyTextStyleUpdates({ shadow: { enabled: next } });
  });

  if (textStyleToggleButtons.length) {
    textStyleToggleButtons.forEach(button => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const isActive = button.getAttribute('aria-pressed') === 'true';
        const styleKey = button.dataset.textStyle;
        if (styleKey === 'bold') {
          applyTextStyleUpdates({ fontWeight: isActive ? 400 : 700 });
        } else if (styleKey === 'italic') {
          applyTextStyleUpdates({ italic: !isActive });
        } else if (styleKey === 'underline') {
          applyTextStyleUpdates({ underline: !isActive });
        } else if (styleKey === 'uppercase') {
          applyTextStyleUpdates({ uppercase: !isActive });
        }
      });
    });
  }

  if (textAlignButtons.length) {
    textAlignButtons.forEach(button => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        applyTextStyleUpdates({ align: button.dataset.align });
      });
    });
  }

  fontPickerSelect?.addEventListener('change', event => {
    if (fontPickerSelect.disabled) return;
    applyTextStyleUpdates({ fontFamily: event.target.value });
  });
}

const TOOL_DEFINITIONS = [
  { id: layerTypes.TEXT, icon: 'icon-type' },
  { id: layerTypes.PEN, icon: 'icon-pen' },
  { id: layerTypes.LOGO, icon: 'icon-sticker' },
  { id: layerTypes.WATERMARK, icon: 'icon-watermark' },
  { id: layerTypes.QR, icon: 'icon-qr' },
  { id: layerTypes.BLUR, icon: 'icon-blur' },
  { id: 'export', icon: 'icon-export' },
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
      const appliedScale = renderer.view.scale;
      updateImage(image.id, {
        zoom: appliedScale,
        pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
      });
      updateZoomLabel(image);
    }
  };
  requestAnimationFrame(attemptResize);
}

function updateDropzoneVisibility(image) {
  if (!dropzone) return;
  const hasImage = Boolean(image);
  if (hasImage) {
    const activeElement = document.activeElement;
    if (activeElement && dropzone.contains(activeElement) && typeof activeElement.blur === 'function') {
      activeElement.blur();
    }
  }
  dropzone.hidden = hasImage;
  dropzone.setAttribute('aria-hidden', hasImage ? 'true' : 'false');
  dropzone.tabIndex = hasImage ? -1 : 0;
  if (!hasImage) {
    dropzone.classList.remove('is-hover');
  }
}

function setupSelectionOverlay() {
  if (!selectionOverlay) return;
  selectionOverlay.innerHTML = `
    <div class="transform-box" data-role="box">
      <div class="transform-handle handle-nw" data-handle="nw" role="button" aria-label="Resize northwest"></div>
      <div class="transform-handle handle-ne" data-handle="ne" role="button" aria-label="Resize northeast"></div>
      <div class="transform-handle handle-sw" data-handle="sw" role="button" aria-label="Resize southwest"></div>
      <div class="transform-handle handle-se" data-handle="se" role="button" aria-label="Resize southeast"></div>
    </div>
  `;
  selectionOverlay.classList.remove('is-active');
  selectionOverlay.style.transform = 'translate3d(0, 0, 0)';
  selectionOverlay.style.width = '0px';
  selectionOverlay.style.height = '0px';
  selectionOverlay.addEventListener('pointerdown', handleSelectionPointerDown);
  selectionOverlay.addEventListener('pointermove', handleSelectionPointerMove);
  selectionOverlay.addEventListener('pointerup', handleSelectionPointerUp);
  selectionOverlay.addEventListener('pointercancel', handleSelectionPointerUp);
}

function init() {
  initUI();
  setupTextToolbar();
  loadPresets();
  ensureDefaultPreset();
  renderPresetList(state.presets);
  renderFontShowcase(FONT_SUGGESTIONS);
  renderSignatureStyles(SIGNATURE_PRESETS);
  markActiveFont(toolDefaults[layerTypes.TEXT].fontFamily);
  markActiveSignaturePreset(activeSignaturePresetId);
  renderToolTabs(TOOL_DEFINITIONS);
  renderToolPanel(state.activeTool);
  updateToolSelection(state.activeTool);
  bindLayerReorder(handleLayerReorder);
  registerEvents();
  updateDropzoneVisibility(getActiveImage());
  syncWorkspaceToolbarState(getActiveImage());
  setupSelectionOverlay();
  queueOverlaySync();
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
  window.addEventListener('pointercancel', handlePointerUp, { passive: true });
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleWindowBlur, { passive: true });

  dropzone?.addEventListener('click', event => {
    if (event.defaultPrevented) return;
    fileInput?.click();
  });
  dropzone?.addEventListener('dragover', handleDragOver);
  dropzone?.addEventListener('dragleave', handleDragLeave);
  dropzone?.addEventListener('drop', handleDrop);

  canvasBoard?.addEventListener('dragover', handleDragOver);
  canvasBoard?.addEventListener('dragleave', handleDragLeave);
  canvasBoard?.addEventListener('drop', handleDrop);
  canvasBoard?.addEventListener('wheel', handleCanvasWheel, { passive: false });

  fileInput?.addEventListener('change', handleFileSelection);
  logoInput?.addEventListener('change', handleLogoSelection);

  canvas.addEventListener('pointerdown', handleCanvasPointerDown);
  overlayCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
  overlayCanvas.addEventListener('pointermove', handleCanvasPointerMove);
  overlayCanvas.addEventListener('pointerup', handleCanvasPointerUp);
  overlayCanvas.addEventListener('pointerleave', handleCanvasPointerUp);

  workspaceToolbar?.addEventListener('click', handleToolbarAction);
  layerAddTextButton?.addEventListener('click', createTextLayer);
  deleteLayerButton?.addEventListener('click', handleDeleteLayer);
  savePresetButton?.addEventListener('click', handleSavePreset);
  selectFilesButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    fileInput?.click();
  });
  useSampleButton?.addEventListener('click', handleUseSample);

  events.addEventListener('ui:toolselected', event => {
    const { toolId } = event.detail;
    setActiveTool(toolId);
  });

  events.addEventListener('ui:layerselected', event => {
    const { layerId } = event.detail;
    setActiveLayer(layerId);
  });

  events.addEventListener('ui:fontpicked', event => {
    const { fontFamily } = event.detail || {};
    if (!fontFamily) return;
    applyTextStyleUpdates({ fontFamily });
  });

  events.addEventListener('ui:signaturepreset', event => {
    const presetId = event.detail?.presetId;
    const preset = SIGNATURE_PRESETS.find(style => style.id === presetId);
    if (preset) {
      applySignaturePreset(preset);
    }
  });

  events.addEventListener('ui:layertoggle', event => {
    const { layerId } = event.detail;
    const image = getActiveImage();
    if (!image) return;
    const layer = getLayer(image.id, layerId);
    if (!layer) return;
    const nextVisible = layer.visible === false;
    updateLayer(image.id, layer.id, { visible: nextVisible });
    events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId: image.id, layers: image.layers.slice() } }));
  });

  events.addEventListener('imagelistchange', () => {
    const image = getActiveImage();
    renderLayerList(image);
    renderPresetList(state.presets);
    updateActiveFileName(image?.name || null);
    canvasBoard.dataset.state = image ? 'loaded' : 'empty';
    updateDropzoneVisibility(image);
    syncWorkspaceToolbarState(image);
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
    if (state.activeTool === layerTypes.TEXT) {
      syncTextStyleControls();
    }
    queueOverlaySync();
  });

events.addEventListener('imagechange', () => {
  const image = getActiveImage();
  renderLayerList(image);
  updateActiveFileName(image?.name || null);
  canvasBoard.dataset.state = image ? 'loaded' : 'empty';
  updateDropzoneVisibility(image);
  syncWorkspaceToolbarState(image);
  if (image) {
    updateStatusBar({
      dimensions: `${image.width} × ${image.height}px`,
      zoom: `Zoom: ${(image.zoom * 100).toFixed(0)}%`,
      memory: estimateMemoryUsage(image),
    });
    scheduleRendererResize(image);
  }
  renderer.render();
  if (state.activeTool === layerTypes.TEXT) {
    syncTextStyleControls();
  }
  queueOverlaySync();
});

events.addEventListener('layerlistchange', () => {
  const image = getActiveImage();
  renderLayerList(image);
  renderer.render();
  if (state.activeTool === layerTypes.TEXT) {
    syncTextStyleControls();
  }
  queueOverlaySync();
});

events.addEventListener('layerupdate', () => {
  const image = getActiveImage();
  renderLayerList(image);
  if (state.activeTool === layerTypes.TEXT) {
    syncTextStyleControls();
  }
});

events.addEventListener('layerchange', () => {
  const currentText = getCurrentTextLayer();
  activeSignaturePresetId = currentText?.signaturePresetId ?? null;
  markActiveSignaturePreset(activeSignaturePresetId);
  if (currentText?.fontFamily) {
    markActiveFont(currentText.fontFamily);
  }
  markActiveLayer(state.activeLayerId);
  renderToolPanel(state.activeTool);
  queueOverlaySync();
});

events.addEventListener('presetchange', () => {
  renderPresetList(state.presets);
});
events.addEventListener('toolchange', event => {
  const toolId = event.detail?.toolId ?? state.activeTool;
  updateToolSelection(toolId);
  renderToolPanel(toolId);
  queueOverlaySync();
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
    let processedBitmap = bitmap;
    let baseCanvas = null;
    const pixelCount = width * height;
    if (pixelCount > 20_000_000) {
      const scaleFactor = 0.5;
      const targetWidth = Math.round(width * scaleFactor);
      const targetHeight = Math.round(height * scaleFactor);
      baseCanvas = document.createElement('canvas');
      baseCanvas.width = targetWidth;
      baseCanvas.height = targetHeight;
      const ctx = baseCanvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      processedBitmap = await createImageBitmap(baseCanvas);
      width = targetWidth;
      height = targetHeight;
      showToast({
        title: state.locale === 'vi' ? 'Đã tối ưu ảnh lớn' : 'Large image optimized',
        message: state.locale === 'vi'
          ? 'Ảnh vượt 20MP được giảm 50% để thao tác mượt mà hơn.'
          : 'Images above 20MP are downscaled 50% to keep editing smooth.',
        tone: 'info',
      });
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
      bitmap: processedBitmap,
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

function handleCanvasWheel(event) {
  const image = getActiveImage();
  if (!image) return;
  if (!event.target.closest?.('.canvas-board')) return;
  event.preventDefault();
  const delta = event.deltaY;
  if (!delta) return;
  const zoomFactor = delta < 0 ? 1.2 : 1 / 1.2;
  setZoom(image, image.zoom * zoomFactor, {
    focus: { clientX: event.clientX, clientY: event.clientY },
  });
}

function handleCanvasPointerDown(event) {
  const image = getActiveImage();
  if (!image) return;
  rememberPointer(event);
  if (event.pointerType === 'touch' && pointerCache.size === 2) {
    const points = pointerPairs();
    if (points.length === 2) {
      pinchState = {
        initialDistance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) || 1,
        initialZoom: image.zoom || renderer.view.scale,
      };
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const tool = state.activeTool;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const hitLayer = findLayerAtPoint(image, pointer);
  if (hitLayer && state.activeLayerId !== hitLayer.id) {
    setActiveLayer(hitLayer.id);
    queueOverlaySync();
  }
  const isTouchPointer = event.pointerType === 'touch';
  const isMousePointer = !event.pointerType || event.pointerType === 'mouse';
  const isPenPointer = event.pointerType === 'pen';
  const isPrimaryPointer = (isMousePointer && event.button === 0) || isTouchPointer || isPenPointer;
  if (!hitLayer && (isMousePointer || isPenPointer) && event.button === 0 && !isSpacePressed && tool !== layerTypes.PEN && tool !== layerTypes.BLUR) {
    setActiveLayer(null);
    queueOverlaySync();
  }
  const panRequested = isSpacePressed ||
    event.button === 1 ||
    event.button === 2 ||
    (isTouchPointer && tool !== layerTypes.PEN && tool !== layerTypes.BLUR);
  if (panRequested) {
    startPan(event, image);
    event.preventDefault();
    return;
  }
  if (tool === layerTypes.PEN) {
    startPenStroke(pointer);
  } else if (tool === layerTypes.BLUR) {
    startBlurSelection(pointer);
  } else {
    const layerForDrag = hitLayer || getLayer(image.id, state.activeLayerId);
    if (layerForDrag?.position && isPrimaryPointer) {
      startLayerDrag(pointer, event.pointerId);
      event.preventDefault();
    }
  }
}

function handleCanvasPointerMove(event) {
  const image = getActiveImage();
  if (!image) return;
  updatePointer(event);
  if (panSession && panSession.pointerId === event.pointerId) {
    updatePan(event);
    event.preventDefault();
    return;
  }
  if (pointerCache.size >= 2 && applyPinchZoom(image)) {
    event.preventDefault();
    return;
  }
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  if (penStroke) {
    extendPenStroke(pointer);
  } else if (blurSelection) {
    updateBlurSelection(pointer);
  } else if (dragLayer) {
    updateLayerDrag(pointer, event.pointerId);
    event.preventDefault();
  }
}

function handleCanvasPointerUp(event) {
  if (event?.type === 'pointerup' || event?.type === 'pointercancel') {
    releasePointer(event);
    if (panSession && panSession.pointerId === event.pointerId) {
      finishPan();
    }
  }
  if (penStroke) {
    finishPenStroke();
  }
  if (blurSelection) {
    finalizeBlurSelection();
  }
  if (dragLayer) {
    finalizeLayerDrag(event?.pointerId);
  }
}

function handlePointerUp(event) {
  handleCanvasPointerUp(event);
}

function handleSelectionPointerDown(event) {
  const image = getActiveImage();
  if (!image) return;
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer || layer.type !== layerTypes.TEXT) return;
  rememberPointer(event);
  if (isSpacePressed) {
    startPan(event, image);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const isPrimary = event.button === 0 || event.pointerType === 'touch' || event.pointerType === 'pen';
  if (!isPrimary) {
    return;
  }
  if (event.pointerType === 'touch' && pointerCache.size === 2) {
    const points = pointerPairs();
    if (points.length === 2) {
      pinchState = {
        initialDistance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) || 1,
        initialZoom: image.zoom || renderer.view.scale,
      };
    }
    return;
  }
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const handle = event.target?.dataset?.handle;
  if (handle) {
    startTextResize(layer, handle, pointer, event.pointerId);
  } else {
    startLayerDrag(pointer, event.pointerId);
  }
  if (typeof selectionOverlay?.setPointerCapture === 'function') {
    try {
      selectionOverlay.setPointerCapture(event.pointerId);
    } catch (error) {
      /* ignore */
    }
  }
  event.preventDefault();
  event.stopPropagation();
}

function handleSelectionPointerMove(event) {
  const image = getActiveImage();
  if (!image) return;
  updatePointer(event);
  if (pointerCache.size >= 2 && applyPinchZoom(image)) {
    event.preventDefault();
    return;
  }
  if (resizeSession && resizeSession.pointerId === event.pointerId) {
    updateTextResize(event, image);
    event.preventDefault();
    return;
  }
  if (dragLayer && dragLayer.pointerId === event.pointerId) {
    const pointer = renderer.screenToImage(event.clientX, event.clientY);
    updateLayerDrag(pointer, event.pointerId);
    event.preventDefault();
  }
}

function handleSelectionPointerUp(event) {
  releasePointer(event);
  if (resizeSession && resizeSession.pointerId === event.pointerId) {
    finishTextResize(event.pointerId);
  }
  if (dragLayer && dragLayer.pointerId === event.pointerId) {
    finalizeLayerDrag(event.pointerId);
  }
  if (typeof selectionOverlay?.releasePointerCapture === 'function') {
    try {
      selectionOverlay.releasePointerCapture(event.pointerId);
    } catch (error) {
      /* ignore */
    }
  }
  event.preventDefault();
  event.stopPropagation();
}

function handleKeyDown(event) {
  if (event.code === 'Space' && !event.repeat && !isEditableTarget(event.target)) {
    if (!isSpacePressed) {
      isSpacePressed = true;
      canvasBoard?.classList.add('is-pan-mode');
    }
    event.preventDefault();
  }
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

function startLayerDrag(pointer, pointerId) {
  const image = getActiveImage();
  if (!image) return;
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer || !layer.position) return;
  const widthRatio = Math.min(Math.max(layer.bounds?.width ?? 0, 0), 1);
  const heightRatio = Math.min(Math.max(layer.bounds?.height ?? 0, 0), 1);
  dragLayer = {
    layerId: layer.id,
    pointerStart: pointer,
    original: { ...layer.position },
    pointerId,
    imageId: image.id,
    bounds: {
      width: widthRatio,
      height: heightRatio,
    },
  };
}

function updateLayerDrag(pointer, pointerId) {
  if (!dragLayer) return;
  if (typeof dragLayer.pointerId === 'number' && typeof pointerId === 'number' && dragLayer.pointerId !== pointerId) {
    return;
  }
  const image = getImage(dragLayer.imageId) || getActiveImage();
  if (!image) return;
  const layer = getLayer(image.id, dragLayer.layerId);
  if (!layer || !layer.position) return;
  const dx = (pointer.x - dragLayer.pointerStart.x) / image.width;
  const dy = (pointer.y - dragLayer.pointerStart.y) / image.height;
  const snap = layer.snap ?? toolDefaults[layer.type]?.snap;
  const boundsWidth = Math.min(Math.max(dragLayer.bounds?.width ?? layer.bounds?.width ?? 0, 0), 1);
  const boundsHeight = Math.min(Math.max(dragLayer.bounds?.height ?? layer.bounds?.height ?? 0, 0), 1);
  let nextX = clamp(dragLayer.original.x + dx, 0, 1);
  let nextY = clamp(dragLayer.original.y + dy, 0, 1);
  if (snap) {
    const step = 0.01;
    nextX = Math.round(nextX / step) * step;
    nextY = Math.round(nextY / step) * step;
  }
  if (boundsWidth > 0 && boundsWidth < 1) {
    const marginX = boundsWidth / 2;
    nextX = clamp(nextX, marginX, 1 - marginX);
  }
  if (boundsHeight > 0 && boundsHeight < 1) {
    const marginY = boundsHeight / 2;
    nextY = clamp(nextY, marginY, 1 - marginY);
  }
  updateLayer(image.id, layer.id, { position: { x: nextX, y: nextY } });
  renderer.render();
}

function finalizeLayerDrag(pointerId) {
  if (!dragLayer) return;
  if (typeof dragLayer.pointerId === 'number' && typeof pointerId === 'number' && dragLayer.pointerId !== pointerId) {
    return;
  }
  const image = getImage(dragLayer.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  dragLayer = null;
  queueOverlaySync();
}

function startTextResize(layer, handle, pointer, pointerId) {
  const image = getActiveImage();
  if (!image) return;
  const bounds = getLayerBounds(layer, image);
  if (!bounds) return;
  const direction = {
    x: handle.includes('e') ? 1 : -1,
    y: handle.includes('s') ? 1 : -1,
  };
  const anchor = {
    x: direction.x === 1 ? bounds.x : bounds.x + bounds.width,
    y: direction.y === 1 ? bounds.y : bounds.y + bounds.height,
  };
  resizeSession = {
    layerId: layer.id,
    imageId: image.id,
    handle,
    pointerId,
    anchor,
    direction,
    initialBounds: bounds,
    minWidth: Math.max(MIN_TEXT_BOUNDS, bounds.width * 0.25),
    minHeight: Math.max(MIN_TEXT_BOUNDS, bounds.height * 0.25),
    initialFontSize: layer.fontSize || toolDefaults[layer.type]?.fontSize || toolDefaults[layerTypes.TEXT].fontSize,
    initialStrokeWidth: layer.strokeWidth ?? toolDefaults[layer.type]?.strokeWidth ?? 0,
    initialLetterSpacing: layer.letterSpacing ?? toolDefaults[layer.type]?.letterSpacing ?? 0,
    initialShadow: layer.shadow ? { ...layer.shadow } : null,
    initialPosition: { ...(layer.position || { x: 0.5, y: 0.5 }) },
  };
}

function updateTextResize(event, image) {
  if (!resizeSession || resizeSession.pointerId !== event.pointerId) return;
  const layer = getLayer(resizeSession.imageId, resizeSession.layerId);
  if (!layer) return;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const px = clamp(pointer.x, 0, image.width);
  const py = clamp(pointer.y, 0, image.height);
  const { anchor, direction, initialBounds, minWidth, minHeight } = resizeSession;
  const deltaX = Math.max(minWidth, (px - anchor.x) * direction.x);
  const deltaY = Math.max(minHeight, (py - anchor.y) * direction.y);
  const availableWidth = direction.x === 1 ? image.width - anchor.x : anchor.x;
  const availableHeight = direction.y === 1 ? image.height - anchor.y : anchor.y;
  const constrainedWidth = clamp(deltaX, minWidth, Math.max(minWidth, availableWidth));
  const constrainedHeight = clamp(deltaY, minHeight, Math.max(minHeight, availableHeight));
  const minScale = Math.max(
    minWidth > 0 ? minWidth / initialBounds.width : 0.1,
    minHeight > 0 ? minHeight / initialBounds.height : 0.1,
  );
  const maxScaleX = availableWidth > 0 ? availableWidth / initialBounds.width : minScale;
  const maxScaleY = availableHeight > 0 ? availableHeight / initialBounds.height : minScale;
  const maxScaleCanvas = Math.min(image.width / initialBounds.width, image.height / initialBounds.height);
  const maxScale = Math.max(minScale, Math.min(maxScaleX || minScale, maxScaleY || minScale, maxScaleCanvas || minScale));
  const targetScale = Math.max(constrainedWidth / initialBounds.width, constrainedHeight / initialBounds.height);
  const scale = clamp(targetScale, minScale, maxScale);
  const newWidth = clamp(initialBounds.width * scale, minWidth, image.width);
  const newHeight = clamp(initialBounds.height * scale, minHeight, image.height);
  const centerX = clamp(anchor.x + (newWidth / 2) * direction.x, newWidth / 2, image.width - newWidth / 2);
  const centerY = clamp(anchor.y + (newHeight / 2) * direction.y, newHeight / 2, image.height - newHeight / 2);
  const fontSize = clamp(resizeSession.initialFontSize * scale, MIN_TEXT_FONT, MAX_TEXT_FONT);
  const updates = {
    fontSize,
    position: {
      x: clamp(centerX / image.width, 0, 1),
      y: clamp(centerY / image.height, 0, 1),
    },
  };
  if (resizeSession.initialStrokeWidth) {
    updates.strokeWidth = clamp(resizeSession.initialStrokeWidth * scale, 0, fontSize * 0.6);
  }
  if (typeof resizeSession.initialLetterSpacing === 'number') {
    updates.letterSpacing = clamp(resizeSession.initialLetterSpacing * scale, -400, 400);
  }
  if (resizeSession.initialShadow) {
    updates.shadow = {
      ...resizeSession.initialShadow,
      blur: clamp((resizeSession.initialShadow.blur ?? 0) * scale, 0, 200),
      offsetX: (resizeSession.initialShadow.offsetX ?? 0) * scale,
      offsetY: (resizeSession.initialShadow.offsetY ?? 0) * scale,
    };
  }
  updateLayer(resizeSession.imageId, resizeSession.layerId, updates);
  renderer.render();
}

function finishTextResize(pointerId) {
  if (!resizeSession || (typeof pointerId === 'number' && resizeSession.pointerId !== pointerId)) {
    return;
  }
  const image = getImage(resizeSession.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  resizeSession = null;
  queueOverlaySync();
}

function handleToolbarAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button || !workspaceToolbar?.contains(button)) return;
  event.preventDefault();
  const action = button.dataset.action;
  if (!action) return;
  if (action === 'select-files') {
    fileInput?.click();
    return;
  }
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
      updateImage(image.id, {
        zoom: renderer.view.scale,
        pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
      });
      updateZoomLabel(image);
      break;
    case 'fill':
      setZoom(image, computeFillZoom(image));
      break;
    case 'center':
      renderer.fitToBounds(image.width, image.height);
      updateImage(image.id, {
        zoom: renderer.view.scale,
        pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
      });
      updateZoomLabel(image);
      break;
    case 'toggle-grid':
      {
        const nextGrid = !image.grid;
        updateImage(image.id, { grid: nextGrid });
        button.setAttribute('aria-pressed', nextGrid ? 'true' : 'false');
      }
      renderer.render();
      break;
    case 'toggle-snap':
      {
        const nextSnap = !image.snap;
        updateImage(image.id, { snap: nextSnap });
        button.setAttribute('aria-pressed', nextSnap ? 'true' : 'false');
      }
      renderer.render();
      break;
    case 'toggle-ruler':
      {
        const nextRuler = !image.ruler;
        updateImage(image.id, { ruler: nextRuler });
        button.setAttribute('aria-pressed', nextRuler ? 'true' : 'false');
      }
      renderer.render();
      break;
    default:
      break;
  }
}

function syncWorkspaceToolbarState(image) {
  if (!workspaceToolbar) return;
  const actionableButtons = workspaceToolbar.querySelectorAll('[data-action]');
  actionableButtons.forEach(button => {
    const shouldDisable = !image;
    if (button.disabled !== shouldDisable) {
      button.disabled = shouldDisable;
    }
  });
  const toggleStates = {
    'toggle-grid': Boolean(image?.grid),
    'toggle-snap': Boolean(image?.snap ?? true),
    'toggle-ruler': Boolean(image?.ruler),
  };
  Object.entries(toggleStates).forEach(([action, isActive]) => {
    const button = workspaceToolbar.querySelector(`[data-action="${action}"]`);
    if (!button) return;
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function setZoom(image, zoom, options = {}) {
  const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  renderer.minScale = MIN_ZOOM;
  renderer.maxScale = MAX_ZOOM;
  const focus = options.focus;
  let nextOffset = renderer.view.offset;
  if (focus) {
    const rect = canvas.getBoundingClientRect();
    const localX = focus.clientX - rect.left;
    const localY = focus.clientY - rect.top;
    const imagePoint = renderer.screenToImage(focus.clientX, focus.clientY);
    nextOffset = {
      x: localX - imagePoint.x * next,
      y: localY - imagePoint.y * next,
    };
  }
  const clampedOffset = clampViewOffset(image, nextOffset, next);
  renderer.setView({ scale: next, offset: clampedOffset });
  const appliedScale = renderer.view.scale;
  updateImage(image.id, {
    zoom: appliedScale,
    pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
  });
  updateZoomLabel(image);
}

function clampViewOffset(image, offset, scale) {
  const viewWidth = renderer.bounds.width;
  const viewHeight = renderer.bounds.height;
  const current = offset || renderer.view.offset;
  const offsetX = typeof current.x === 'number' ? current.x : 0;
  const offsetY = typeof current.y === 'number' ? current.y : 0;
  const contentWidth = image.width * scale;
  const contentHeight = image.height * scale;
  let clampedX;
  if (contentWidth <= viewWidth) {
    clampedX = (viewWidth - contentWidth) / 2;
  } else {
    const minX = viewWidth - contentWidth;
    clampedX = clamp(offsetX, minX, 0);
  }
  let clampedY;
  if (contentHeight <= viewHeight) {
    clampedY = (viewHeight - contentHeight) / 2;
  } else {
    const minY = viewHeight - contentHeight;
    clampedY = clamp(offsetY, minY, 0);
  }
  return { x: clampedX, y: clampedY };
}

function startPan(event, image) {
  if (!image) return;
  panSession = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    origin: { ...renderer.view.offset },
    imageId: image.id,
  };
  canvasBoard?.classList.add('is-pan-mode');
  if (typeof event.target?.setPointerCapture === 'function') {
    try {
      event.target.setPointerCapture(event.pointerId);
    } catch (error) {
      /* ignore pointer capture errors */
    }
  }
}

function handleKeyUp(event) {
  if (event.code === 'Space') {
    isSpacePressed = false;
    canvasBoard?.classList.remove('is-pan-mode');
  }
}

function handleWindowBlur() {
  if (isSpacePressed) {
    isSpacePressed = false;
    canvasBoard?.classList.remove('is-pan-mode');
  }
  if (panSession) {
    finishPan();
  }
  pointerCache.clear();
  pinchState = null;
}
function updatePan(event) {
  if (!panSession) return;
  const image = getImage(panSession.imageId);
  if (!image) return;
  const dx = event.clientX - panSession.startX;
  const dy = event.clientY - panSession.startY;
  const nextOffset = {
    x: panSession.origin.x + dx,
    y: panSession.origin.y + dy,
  };
  const clamped = clampViewOffset(image, nextOffset, image.zoom || renderer.view.scale);
  renderer.setView({ offset: clamped });
}

function finishPan() {
  if (!panSession) return;
  const image = getImage(panSession.imageId);
  if (image) {
    updateImage(image.id, {
      pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
      zoom: renderer.view.scale,
    });
  }
  if (!isSpacePressed) {
    canvasBoard?.classList.remove('is-pan-mode');
  }
  panSession = null;
  queueOverlaySync();
}

function rememberPointer(event) {
  pointerCache.set(event.pointerId, { x: event.clientX, y: event.clientY });
}

function updatePointer(event) {
  if (!pointerCache.has(event.pointerId)) return;
  pointerCache.set(event.pointerId, { x: event.clientX, y: event.clientY });
}

function releasePointer(event) {
  pointerCache.delete(event.pointerId);
  if (pointerCache.size < 2) {
    pinchState = null;
  }
}

function pointerPairs() {
  return Array.from(pointerCache.values());
}

function applyPinchZoom(image) {
  if (!pinchState || pointerCache.size < 2 || !image) return false;
  const points = pointerPairs();
  if (points.length < 2) return false;
  const [a, b] = points;
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (!distance || !pinchState.initialDistance) return false;
  const scaleFactor = distance / pinchState.initialDistance;
  const targetZoom = clamp(pinchState.initialZoom * scaleFactor, MIN_ZOOM, MAX_ZOOM);
  const focus = {
    clientX: (a.x + b.x) / 2,
    clientY: (a.y + b.y) / 2,
  };
  setZoom(image, targetZoom, { focus });
  return true;
}

function computeFillZoom(image) {
  const availableWidth = renderer.bounds.width;
  const availableHeight = renderer.bounds.height;
  const fill = Math.max(availableWidth / image.width, availableHeight / image.height);
  return clamp(fill, MIN_ZOOM, MAX_ZOOM);
}

function updateZoomLabel(image) {
  if (!image || typeof image.zoom !== 'number') return;
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

function applySignaturePreset(preset) {
  if (!preset) return;
  const updates = {
    content: preset.text,
    fontFamily: preset.fontFamily,
    fontWeight: preset.fontWeight ?? 400,
    color: preset.color,
    strokeWidth: preset.strokeWidth ?? 0,
    strokeColor: preset.strokeColor ?? '#ffffff',
    shadow: preset.shadow ?? { enabled: false },
    letterSpacing: preset.letterSpacing ?? 0,
    uppercase: preset.uppercase ?? false,
    italic: preset.italic ?? false,
    align: preset.align ?? 'center',
  };
  if (typeof preset.fontSize === 'number') {
    updates.fontSize = preset.fontSize;
  }
  if (typeof preset.opacity === 'number') {
    updates.opacity = preset.opacity;
  }
  Object.assign(toolDefaults[layerTypes.TEXT], updates);
  toolDefaults[layerTypes.TEXT].signaturePresetId = preset.id;
  toolDefaults[layerTypes.TEXT].signaturePresetName = preset.name;
  const image = getActiveImage();
  if (!image) {
    activeSignaturePresetId = preset.id;
    markActiveSignaturePreset(activeSignaturePresetId);
    markActiveFont(updates.fontFamily);
    syncTextStyleControls();
    return;
  }
  let targetLayer = getLayer(image.id, state.activeLayerId);
  if (!targetLayer || targetLayer.type !== layerTypes.TEXT) {
    targetLayer = addLayer(image.id, {
      type: layerTypes.TEXT,
      ...toolDefaults[layerTypes.TEXT],
      ...updates,
      signaturePresetId: preset.id,
      signaturePresetName: preset.name,
    });
    setActiveLayer(targetLayer.id);
  } else {
    updateLayer(image.id, targetLayer.id, {
      ...updates,
      signaturePresetId: preset.id,
      signaturePresetName: preset.name,
    });
  }
  activeSignaturePresetId = preset.id;
  markActiveSignaturePreset(activeSignaturePresetId);
  markActiveFont(updates.fontFamily);
  renderer.render();
  syncTextStyleControls();
  queueOverlaySync();
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
  const showTextToolbar = toolId === layerTypes.TEXT;
  toggleTextToolbar(showTextToolbar);
  if (showTextToolbar) {
    syncTextStyleControls();
  }
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
    default:
      break;
  }
}

function handleLayerReorder(orderedIds = []) {
  const image = getActiveImage();
  if (!image) return;
  if (!Array.isArray(orderedIds) || orderedIds.length !== image.layers.length) return;
  const layerMap = new Map(image.layers.map(layer => [layer.id, layer]));
  const orderedLayers = [];
  let changed = false;
  for (let index = 0; index < orderedIds.length; index += 1) {
    const id = orderedIds[index];
    const layer = layerMap.get(id);
    if (!layer) {
      return;
    }
    orderedLayers.push(layer);
    if (!changed && image.layers[index] !== layer) {
      changed = true;
    }
  }
  if (!changed) return;
  image.layers = orderedLayers;
  pushHistory(image.id);
  events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId: image.id, layers: image.layers.slice() } }));
}

function renderTextPanel(container) {
  const { layer, style } = resolveTextContext();
  const disabled = !(layer && layer.type === layerTypes.TEXT);
  container.innerHTML = `
    <form id="textToolForm" class="form-grid" autocomplete="off">
      <label class="field">
        <span>${state.locale === 'vi' ? 'Nội dung chữ ký' : 'Signature content'}</span>
        <textarea name="content" rows="3" ${disabled ? 'disabled' : ''}>${style.content || ''}</textarea>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
        <div class="field-slider">
          <input type="range" name="opacity" min="10" max="100" value="${Math.round((style.opacity ?? 1) * 100)}" ${disabled ? 'disabled' : ''}>
          <span class="field-value" data-field="opacity-display">${Math.round((style.opacity ?? 1) * 100)}%</span>
        </div>
      </label>
    </form>
  `;
  const form = container.querySelector('#textToolForm');
  if (!form) return;
  const contentField = form.elements.content;
  const opacityField = form.elements.opacity;
  const opacityDisplay = form.querySelector('[data-field="opacity-display"]');
  const updateOpacityDisplay = value => {
    if (!opacityDisplay) return;
    const numeric = Number.isFinite(value) ? Math.round(value) : Math.round((style.opacity ?? 1) * 100);
    opacityDisplay.textContent = `${numeric}%`;
  };
  const handleChange = () => {
    const updates = {};
    if (contentField && !contentField.disabled) {
      updates.content = contentField.value;
    }
    if (opacityField && !opacityField.disabled) {
      const opacityValue = parseFloat(opacityField.value);
      if (!Number.isNaN(opacityValue)) {
        updates.opacity = opacityValue / 100;
        updateOpacityDisplay(opacityValue);
      }
    }
    if (Object.keys(updates).length) {
      applyTextStyleUpdates(updates);
    }
  };
  if (opacityField && !Number.isNaN(parseFloat(opacityField.value))) {
    updateOpacityDisplay(parseFloat(opacityField.value));
  }
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  return () => {
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
  };
}

function renderPenPanel(container) {
  const localeIsVi = state.locale === 'vi';
  const defaults = toolDefaults[layerTypes.PEN];
  const thicknessPresets = [2, 4, 6, 8, 12];
  const currentColor = defaults.color || PEN_COLOR_PRESETS[0];
  const currentSize = Number.isFinite(defaults.size) ? defaults.size : 4;
  const currentSmoothing = Number.isFinite(defaults.smoothing) ? defaults.smoothing : 0.65;
  const currentRoundCap = defaults.roundCap ?? true;
  container.innerHTML = `
    <div class="pen-panel">
      <section class="pen-section">
        <div class="pen-section-header">
          <h4>${localeIsVi ? 'Màu bút' : 'Pen color'}</h4>
          <p>${localeIsVi ? 'Palette gợi ý với độ tương phản cao cho chữ ký tay.' : 'Curated palette with high contrast for signatures.'}</p>
        </div>
        <div class="pen-color-grid">
          ${PEN_COLOR_PRESETS.map(color => {
            const isActive = color.toLowerCase() === currentColor.toLowerCase();
            return `<button type="button" class="pen-color${isActive ? ' is-active' : ''}" style="--swatch:${color}" data-color="${color}" aria-label="${color}"></button>`;
          }).join('')}
        </div>
        <div class="pen-color-custom">
          <label for="penColorPicker">${localeIsVi ? 'Màu tuỳ chỉnh' : 'Custom color'}</label>
          <div class="pen-color-input">
            <input type="color" id="penColorPicker" value="${currentColor}">
            <span class="pen-color-value" data-field="pen-color-value">${currentColor.toUpperCase()}</span>
          </div>
        </div>
      </section>
      <section class="pen-section">
        <div class="pen-section-header">
          <h4>${localeIsVi ? 'Độ dày nét' : 'Stroke weight'}</h4>
          <p>${localeIsVi ? 'Điều chỉnh độ lớn của nét bút hoặc chọn nhanh bên dưới.' : 'Fine-tune stroke size or pick a preset below.'}</p>
        </div>
        <div class="pen-slider">
          <input type="range" id="penSizeRange" name="size" min="1" max="48" value="${currentSize}">
          <span class="pen-slider-value" data-field="pen-size-display">${Math.round(currentSize)} px</span>
        </div>
        <div class="pen-weight-presets">
          ${thicknessPresets.map(size => `<button type="button" class="pen-weight-chip${Math.round(currentSize) === size ? ' is-active' : ''}" data-size="${size}">${size}<span>px</span></button>`).join('')}
        </div>
      </section>
      <section class="pen-section">
        <div class="pen-section-header">
          <h4>${localeIsVi ? 'Độ mượt' : 'Smoothing'}</h4>
          <p>${localeIsVi ? 'Giảm rung tay để nét chữ mềm mại hơn.' : 'Reduce jitter for smoother handwriting.'}</p>
        </div>
        <div class="pen-slider">
          <input type="range" id="penSmoothingRange" name="smoothing" min="0" max="1" step="0.05" value="${currentSmoothing}">
          <span class="pen-slider-value" data-field="pen-smoothing-display">${Math.round(currentSmoothing * 100)}%</span>
        </div>
      </section>
      <section class="pen-section pen-options">
        <label class="switch">
          <input type="checkbox" id="penRoundCap" ${currentRoundCap ? 'checked' : ''}>
          <span>${localeIsVi ? 'Đầu tròn' : 'Round cap'}</span>
        </label>
        <div class="pen-actions">
          <button type="button" class="btn ghost" data-action="pen-undo">
            <svg class="icon"><use href="#icon-undo"></use></svg>
            <span>Undo</span>
          </button>
          <button type="button" class="btn ghost danger" data-action="pen-clear">
            <svg class="icon"><use href="#icon-eraser"></use></svg>
            <span>${localeIsVi ? 'Xoá nét' : 'Clear'}</span>
          </button>
        </div>
      </section>
    </div>
  `;
  const disposers = [];
  const addListener = (element, event, handler) => {
    if (!element) return;
    element.addEventListener(event, handler);
    disposers.push(() => element.removeEventListener(event, handler));
  };
  const setPenDefaults = updates => {
    toolDefaults[layerTypes.PEN] = {
      ...toolDefaults[layerTypes.PEN],
      ...updates,
    };
  };
  const paletteButtons = Array.from(container.querySelectorAll('.pen-color'));
  const colorInput = container.querySelector('#penColorPicker');
  const colorValue = container.querySelector('[data-field="pen-color-value"]');
  const normalizeColor = color => (color || '').toLowerCase();
  const setColor = color => {
    if (!color) return;
    const normalized = color.startsWith('#') ? color : `#${color}`;
    setPenDefaults({ color: normalized });
    if (colorInput) {
      colorInput.value = normalized;
    }
    if (colorValue) {
      colorValue.textContent = normalized.toUpperCase();
    }
    paletteButtons.forEach(button => {
      button.classList.toggle('is-active', normalizeColor(button.dataset.color) === normalizeColor(normalized));
    });
  };
  paletteButtons.forEach(button => {
    addListener(button, 'click', () => setColor(button.dataset.color));
  });
  addListener(colorInput, 'input', event => setColor(event.target.value));

  const sizeRange = container.querySelector('#penSizeRange');
  const sizeDisplay = container.querySelector('[data-field="pen-size-display"]');
  const sizeChips = Array.from(container.querySelectorAll('.pen-weight-chip'));
  const setSize = value => {
    const numeric = Math.min(48, Math.max(1, parseFloat(value) || currentSize));
    setPenDefaults({ size: numeric });
    if (sizeRange) {
      sizeRange.value = numeric;
    }
    if (sizeDisplay) {
      sizeDisplay.textContent = `${Math.round(numeric)} px`;
    }
    sizeChips.forEach(chip => {
      chip.classList.toggle('is-active', Math.round(numeric) === Number(chip.dataset.size));
    });
  };
  addListener(sizeRange, 'input', event => setSize(event.target.value));
  sizeChips.forEach(chip => {
    addListener(chip, 'click', () => setSize(chip.dataset.size));
  });

  const smoothingRange = container.querySelector('#penSmoothingRange');
  const smoothingDisplay = container.querySelector('[data-field="pen-smoothing-display"]');
  const setSmoothing = value => {
    const numeric = Math.min(1, Math.max(0, parseFloat(value)));
    setPenDefaults({ smoothing: numeric });
    if (smoothingRange) {
      smoothingRange.value = numeric;
    }
    if (smoothingDisplay) {
      smoothingDisplay.textContent = `${Math.round(numeric * 100)}%`;
    }
  };
  addListener(smoothingRange, 'input', event => setSmoothing(event.target.value));

  const roundCapToggle = container.querySelector('#penRoundCap');
  addListener(roundCapToggle, 'change', event => {
    setPenDefaults({ roundCap: event.target.checked });
  });

  container.querySelectorAll('[data-action]').forEach(button => {
    addListener(button, 'click', () => {
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

  // initialise UI state
  setColor(currentColor);
  setSize(currentSize);
  setSmoothing(currentSmoothing);
  if (roundCapToggle) {
    roundCapToggle.checked = !!currentRoundCap;
  }

  return () => {
    disposers.forEach(dispose => dispose());
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

document.addEventListener('DOMContentLoaded', init);
