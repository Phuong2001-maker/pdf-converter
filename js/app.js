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
const layerPanel = document.getElementById('layerPanel');

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
let canvasResizeObserver = null;
let lastObservedCanvasSize = { width: 0, height: 0 };
let lastQrErrorAt = 0;

const syncCanvasCursor = (toolId = state.activeTool) => {
  const isPenTool = toolId === layerTypes.PEN;
  canvasBoard?.classList.toggle('is-pen-mode', isPenTool);
};

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
const localize = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const locale = state.locale || 'vi';
  if (typeof value === 'object') {
    if (value[locale]) return value[locale];
    if (value.en) return value.en;
    if (value.vi) return value.vi;
    const firstKey = Object.keys(value)[0];
    if (firstKey) {
      return value[firstKey];
    }
  }
  return String(value);
};
const getLayerBounds = (layer, image) => {
  if (!layer?.bounds || !image) return null;
  return {
    x: layer.bounds.x * image.width,
    y: layer.bounds.y * image.height,
    width: layer.bounds.width * image.width,
    height: layer.bounds.height * image.height,
  };
};
const normalizeAngle = degrees => {
  if (!Number.isFinite(degrees)) return 0;
  let angle = degrees % 360;
  if (angle > 180) {
    angle -= 360;
  } else if (angle <= -180) {
    angle += 360;
  }
  return angle;
};
const LOGO_MIN_SCALE = 0.08;
const LOGO_MAX_SCALE = 8;
const resolveLogoMetrics = (layer, image) => {
  if (!layer || layer.type !== layerTypes.LOGO || !image) return null;
  const baseWidth = Number.isFinite(layer.width) ? layer.width : layer.asset?.naturalWidth || layer.asset?.width || 0;
  const baseHeight = Number.isFinite(layer.height) ? layer.height : layer.asset?.naturalHeight || layer.asset?.height || 0;
  if (!baseWidth || !baseHeight) return null;
  const scale = Number.isFinite(layer.scale) ? layer.scale : 1;
  const rotation = Number.isFinite(layer.rotation) ? layer.rotation : 0;
  const drawWidth = Math.max(1, baseWidth * scale);
  const drawHeight = Math.max(1, baseHeight * scale);
  const rotationRad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const boundWidth = Math.abs(drawWidth * cos) + Math.abs(drawHeight * sin);
  const boundHeight = Math.abs(drawWidth * sin) + Math.abs(drawHeight * cos);
  const widthRatio = clamp(boundWidth / image.width, 0, 1);
  const heightRatio = clamp(boundHeight / image.height, 0, 1);
  const halfWidthRatio = widthRatio >= 1 ? 0.5 : widthRatio / 2;
  const halfHeightRatio = heightRatio >= 1 ? 0.5 : heightRatio / 2;
  const position = {
    x: clamp(layer.position?.x ?? 0.5, halfWidthRatio, 1 - halfWidthRatio),
    y: clamp(layer.position?.y ?? 0.5, halfHeightRatio, 1 - halfHeightRatio),
  };
  const bounds = {
    x: widthRatio >= 1 ? 0 : clamp(position.x - widthRatio / 2, 0, 1 - widthRatio),
    y: heightRatio >= 1 ? 0 : clamp(position.y - heightRatio / 2, 0, 1 - heightRatio),
    width: widthRatio,
    height: heightRatio,
  };
  return {
    baseWidth,
    baseHeight,
    scale,
    rotation,
    rotationRad,
    drawWidth,
    drawHeight,
    boundWidth,
    boundHeight,
    widthRatio,
    heightRatio,
    bounds,
    center: {
      x: position.x * image.width,
      y: position.y * image.height,
    },
    position,
  };
};
const DEFAULT_LOGO_BG_OPTIONS = {
  tolerance: 48,
  softness: 52,
  minimumAlpha: 12,
};
const computeLogoEdgeColor = (data, width, height) => {
  if (!width || !height) return null;
  const samples = [];
  const addSample = (x, y) => {
    const index = (y * width + x) * 4;
    const alpha = data[index + 3];
    if (alpha <= DEFAULT_LOGO_BG_OPTIONS.minimumAlpha) return;
    samples.push({
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
    });
  };
  const stepX = Math.max(1, Math.floor(width / 24));
  const stepY = Math.max(1, Math.floor(height / 24));
  for (let x = 0; x < width; x += stepX) {
    addSample(x, 0);
    addSample(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    addSample(0, y);
    addSample(width - 1, y);
  }
  addSample(0, 0);
  addSample(width - 1, 0);
  addSample(0, height - 1);
  addSample(width - 1, height - 1);
  if (!samples.length) return null;
  const totals = samples.reduce(
    (acc, sample) => {
      acc.r += sample.r;
      acc.g += sample.g;
      acc.b += sample.b;
      return acc;
    },
    { r: 0, g: 0, b: 0 },
  );
  const count = samples.length;
  return {
    r: totals.r / count,
    g: totals.g / count,
    b: totals.b / count,
  };
};
const colorDistance = (r, g, b, reference) => {
  const dr = r - reference.r;
  const dg = g - reference.g;
  const db = b - reference.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
};
const createTransparentLogoAsset = (asset, options = {}) => {
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : DEFAULT_LOGO_BG_OPTIONS.tolerance;
  const softness = Number.isFinite(options.softness) ? options.softness : DEFAULT_LOGO_BG_OPTIONS.softness;
  const minimumAlpha = Number.isFinite(options.minimumAlpha) ? options.minimumAlpha : DEFAULT_LOGO_BG_OPTIONS.minimumAlpha;
  return new Promise((resolve, reject) => {
    const width = asset?.naturalWidth || asset?.width || 0;
    const height = asset?.naturalHeight || asset?.height || 0;
    if (!asset || !width || !height) {
      reject(new Error('Logo asset is invalid.'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(asset, 0, 0, width, height);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (error) {
      reject(error);
      return;
    }
    const { data } = imageData;
    const background = computeLogoEdgeColor(data, width, height);
    if (!background) {
      resolve({ image: asset, dataUrl: canvas.toDataURL('image/png'), removedPixels: 0, unchanged: true });
      return;
    }
    let removedPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha <= minimumAlpha) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const distance = colorDistance(r, g, b, background);
      if (distance <= tolerance) {
        data[i + 3] = 0;
        removedPixels += 1;
      } else if (distance <= tolerance + softness) {
        const blend = (distance - tolerance) / Math.max(softness, 1);
        const nextAlpha = Math.max(0, Math.min(255, Math.round(alpha * Math.min(1, blend))));
        if (nextAlpha < alpha) {
          if (nextAlpha <= minimumAlpha) {
            data[i + 3] = 0;
            removedPixels += 1;
          } else {
            data[i + 3] = nextAlpha;
          }
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const processed = new Image();
    processed.onload = () => {
      resolve({ image: processed, dataUrl, removedPixels, unchanged: removedPixels === 0 });
    };
    processed.onerror = error => reject(error);
    processed.src = dataUrl;
  });
};
const removeLogoLayerBackground = async (imageState, layer, options = {}) => {
  if (!imageState || !layer || layer.type !== layerTypes.LOGO || !layer.asset) {
    throw new Error('Không tìm thấy logo để xử lý.');
  }
  const result = await createTransparentLogoAsset(layer.asset, options);
  if (!result || result.unchanged) {
    return { changed: false };
  }
  updateLayer(imageState.id, layer.id, {
    asset: result.image,
    assetDataUrl: result.dataUrl,
    removedBackground: true,
    width: layer.width,
    height: layer.height,
  });
  renderer.render();
  return { changed: true };
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
  selectionOverlay.classList.remove('is-rotating');
  selectionOverlay.style.width = '0px';
  selectionOverlay.style.height = '0px';
  selectionOverlay.dataset.layerId = '';
  delete selectionOverlay.dataset.layerType;
  const transformBox = selectionOverlay.querySelector('.transform-box');
  if (transformBox) {
    transformBox.style.transform = 'rotate(0deg)';
  }
};
const syncSelectionOverlay = () => {
  if (!selectionOverlay) return;
  const image = getActiveImage();
  if (!image) {
    hideSelectionOverlay();
    return;
  }
  const layer = getLayer(image.id, state.activeLayerId);
  if (!layer || layer.visible === false) {
    hideSelectionOverlay();
    return;
  }
  selectionOverlay.dataset.layerId = layer.id;
  selectionOverlay.dataset.layerType = layer.type;
  const transformBox = selectionOverlay.querySelector('.transform-box');
  if (transformBox) {
    transformBox.style.transform = 'rotate(0deg)';
  }
  if (layer.type === layerTypes.LOGO) {
    const metrics = resolveLogoMetrics(layer, image);
    if (!metrics || metrics.drawWidth < 1 || metrics.drawHeight < 1) {
      hideSelectionOverlay();
      return;
    }
    const halfWidth = metrics.drawWidth / 2;
    const halfHeight = metrics.drawHeight / 2;
    const topLeft = renderer.imageToScreen(metrics.center.x - halfWidth, metrics.center.y - halfHeight);
    const bottomRight = renderer.imageToScreen(metrics.center.x + halfWidth, metrics.center.y + halfHeight);
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      hideSelectionOverlay();
      return;
    }
    selectionOverlay.style.transform = `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`;
    selectionOverlay.style.width = `${width}px`;
    selectionOverlay.style.height = `${height}px`;
    if (transformBox) {
      transformBox.style.transform = `rotate(${metrics.rotation}deg)`;
    }
    selectionOverlay.classList.add('is-active');
    return;
  }
  if (layer.type !== layerTypes.TEXT && layer.type !== layerTypes.QR) {
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
    const bounds = layer.bounds;
    if (bounds) {
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
    name: { vi: 'Xanh Hoàng Gia', en: 'Royal Blue' },
    tagline: { vi: 'Thanh lịch', en: 'Elegant' },
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
    name: { vi: 'Hồng Hoàng Hôn', en: 'Sunset Rose' },
    tagline: { vi: 'Lãng mạn', en: 'Romantic' },
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
    name: { vi: 'Vàng Ánh Đêm', en: 'Midnight Gold' },
    tagline: { vi: 'Sang trọng', en: 'Luxury' },
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
    name: { vi: 'Dòng Bạc', en: 'Silver Stream' },
    tagline: { vi: 'Hiện đại', en: 'Modern' },
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
    name: { vi: 'Phong Cách Thể Thao', en: 'Sport Vibe' },
    tagline: { vi: 'Mạnh mẽ', en: 'Bold' },
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

const PEN_CAP_OPTIONS = [
  { id: 'round', label: 'Tròn', icon: 'round' },
  { id: 'butt', label: 'Phẳng', icon: 'flat' },
  { id: 'square', label: 'Vuông', icon: 'square' },
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
    cap: 'round',
  },
  [layerTypes.LOGO]: {
    scale: 0.6,
    rotation: 0,
    opacity: 1,
    position: { x: 0.85, y: 0.8 },
  },
  [layerTypes.WATERMARK]: {
    text: 'Ký ảnh • Xử lý cục bộ',
    fontFamily: 'Inter',
    fontSize: 36,
    opacity: 0.22,
    angle: -45,
    spacingX: 260,
    spacingY: 180,
    color: 'rgba(37, 99, 235, 0.28)',
  },
  [layerTypes.QR]: {
    inputType: 'text',
    text: '',
    textContent: '',
    link: '',
    size: 220,
    margin: 12,
    opacity: 1,
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

function ensureCanvasResizeObserver() {
  if (!canvas) return;
  const container = canvas.parentElement;
  if (!container || typeof ResizeObserver !== 'function') return;
  if (canvasResizeObserver) {
    canvasResizeObserver.observe(container);
    return;
  }
  canvasResizeObserver = new ResizeObserver(entries => {
    entries.forEach(entry => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      if (
        Math.abs(width - lastObservedCanvasSize.width) < 0.5 &&
        Math.abs(height - lastObservedCanvasSize.height) < 0.5
      ) {
        return;
      }
      lastObservedCanvasSize = { width, height };
      const image = getActiveImage();
      const previousScale = renderer.view.scale;
      const previousOffset = { x: renderer.view.offset.x, y: renderer.view.offset.y };
      renderer.resize(width, height);
      if (!image) return;
      const nextOffset = clampViewOffset(image, previousOffset, previousScale);
      renderer.setView({ scale: previousScale, offset: nextOffset });
      const currentPan = image.pan || { x: 0, y: 0 };
      const panChanged =
        Math.abs(currentPan.x - renderer.view.offset.x) > 0.5 ||
        Math.abs(currentPan.y - renderer.view.offset.y) > 0.5;
      const zoomChanged = Math.abs((image.zoom || 1) - renderer.view.scale) > 0.001;
      if (panChanged || zoomChanged) {
        updateImage(image.id, {
          zoom: renderer.view.scale,
          pan: { x: renderer.view.offset.x, y: renderer.view.offset.y },
        });
        updateZoomLabel(image);
      }
    });
  });
  canvasResizeObserver.observe(container);
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
  ensureCanvasResizeObserver();
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
      <div class="transform-handle handle-rotate" data-handle="rotate" role="button" aria-label="Rotate layer"></div>
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
  syncCanvasCursor(state.activeTool);
  bindLayerReorder(handleLayerReorder);
  registerEvents();
  updateDropzoneVisibility(getActiveImage());
  syncWorkspaceToolbarState(getActiveImage());
  setupSelectionOverlay();
  queueOverlaySync();
  const container = canvas.parentElement;
  if (container) {
    ensureCanvasResizeObserver();
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
  canvas.addEventListener('pointermove', handleCanvasPointerMove);
  canvas.addEventListener('pointerup', handleCanvasPointerUp);
  canvas.addEventListener('pointerleave', handleCanvasPointerUp);
  canvas.addEventListener('pointercancel', handleCanvasPointerUp);

  overlayCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
  overlayCanvas.addEventListener('pointermove', handleCanvasPointerMove);
  overlayCanvas.addEventListener('pointerup', handleCanvasPointerUp);
  overlayCanvas.addEventListener('pointerleave', handleCanvasPointerUp);
  overlayCanvas.addEventListener('pointercancel', handleCanvasPointerUp);

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
        zoom: `Thu phóng: ${(image.zoom * 100).toFixed(0)}%`,
        memory: estimateMemoryUsage(image),
      });
      scheduleRendererResize(image);
    } else {
      updateStatusBar({
        dimensions: 'Kích thước: —',
        zoom: 'Thu phóng: 100%',
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
      zoom: `Thu phóng: ${(image.zoom * 100).toFixed(0)}%`,
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
  syncCanvasCursor(toolId);
  queueOverlaySync();
});

events.addEventListener('localechange', () => {
  renderSignatureStyles(SIGNATURE_PRESETS);
  markActiveSignaturePreset(activeSignaturePresetId);
  renderToolPanel(state.activeTool);
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
      zoom: 'Thu phóng: 100%',
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
  if (
    !layer ||
    (layer.type !== layerTypes.TEXT && layer.type !== layerTypes.QR && layer.type !== layerTypes.LOGO)
  ) {
    return;
  }
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
    if (layer.type === layerTypes.TEXT) {
      startTextResize(layer, handle, pointer, event.pointerId);
    } else if (layer.type === layerTypes.QR) {
      startQrResize(layer, handle, pointer, event.pointerId);
    } else if (layer.type === layerTypes.LOGO) {
      if (handle === 'rotate') {
        startLogoRotate(layer, pointer, event.pointerId);
      } else {
        startLogoResize(layer, handle, pointer, event.pointerId);
      }
    }
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
    if (resizeSession.mode === 'text') {
      updateTextResize(event, image);
    } else if (resizeSession.mode === 'qr') {
      updateQrResize(event, image);
    } else if (resizeSession.mode === 'logo-scale') {
      updateLogoResize(event, image);
    } else if (resizeSession.mode === 'logo-rotate') {
      updateLogoRotate(event, image);
    }
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
    if (resizeSession.mode === 'text') {
      finishTextResize(event.pointerId);
    } else if (resizeSession.mode === 'qr') {
      finishQrResize(event.pointerId);
    } else if (resizeSession.mode === 'logo-scale') {
      finishLogoResize(event.pointerId);
    } else if (resizeSession.mode === 'logo-rotate') {
      finishLogoRotate(event.pointerId);
    }
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
      name: state.locale === 'vi' ? 'Ký tay' : 'Pen',
      strokes: [],
      opacity: 1,
      cap: toolDefaults[layerTypes.PEN].cap || (toolDefaults[layerTypes.PEN].roundCap ? 'round' : 'butt'),
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
  const { color, size, cap } = toolDefaults[layerTypes.PEN];
  penStroke.points.push({
    x: clamp(pointer.x / image.width, 0, 1),
    y: clamp(pointer.y / image.height, 0, 1),
  });
  const layer = getLayer(image.id, penStroke.layerId);
  if (!layer) return;
  const strokes = Array.isArray(layer.strokes) ? layer.strokes.slice() : [];
  if (!penStroke.stroke) {
    penStroke.stroke = {
      color,
      size,
      cap: cap || (toolDefaults[layerTypes.PEN].roundCap ? 'round' : 'butt'),
      points: [],
    };
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
    mode: 'text',
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

function startQrResize(layer, handle, pointer, pointerId) {
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
  const margin = typeof layer.margin === 'number' ? layer.margin : 12;
  const minTile = Math.max(48, Math.min(bounds.width, 80 + margin * 2));
  resizeSession = {
    mode: 'qr',
    layerId: layer.id,
    imageId: image.id,
    handle,
    pointerId,
    anchor,
    direction,
    initialBounds: bounds,
    margin,
    minTile,
  };
}

function startLogoResize(layer, handle, pointer, pointerId) {
  const image = getActiveImage();
  if (!image) return;
  const metrics = resolveLogoMetrics(layer, image);
  if (!metrics) return;
  const center = { x: metrics.center.x, y: metrics.center.y };
  const vector = { x: pointer.x - center.x, y: pointer.y - center.y };
  const initialDistance = Math.hypot(vector.x, vector.y);
  if (!initialDistance) return;
  const maxScaleByWidth = metrics.baseWidth ? image.width / metrics.baseWidth : LOGO_MAX_SCALE;
  const maxScaleByHeight = metrics.baseHeight ? image.height / metrics.baseHeight : LOGO_MAX_SCALE;
  const maxScaleCandidate = Math.max(LOGO_MIN_SCALE, Math.min(LOGO_MAX_SCALE, maxScaleByWidth, maxScaleByHeight));
  const maxScale = Math.max(metrics.scale, maxScaleCandidate);
  const minScale = Math.min(metrics.scale, Math.max(LOGO_MIN_SCALE, metrics.scale * 0.1));
  resizeSession = {
    mode: 'logo-scale',
    layerId: layer.id,
    imageId: image.id,
    pointerId,
    handle,
    center,
    initialDistance,
    initialScale: metrics.scale,
    minScale,
    maxScale,
  };
}

function startLogoRotate(layer, pointer, pointerId) {
  const image = getActiveImage();
  if (!image) return;
  const metrics = resolveLogoMetrics(layer, image);
  if (!metrics) return;
  const dx = pointer.x - metrics.center.x;
  const dy = pointer.y - metrics.center.y;
  const initialAngle = Math.atan2(dy, dx);
  resizeSession = {
    mode: 'logo-rotate',
    layerId: layer.id,
    imageId: image.id,
    pointerId,
    center: { x: metrics.center.x, y: metrics.center.y },
    initialAngle,
    initialRotation: layer.rotation || 0,
  };
  selectionOverlay?.classList.add('is-rotating');
}

function updateTextResize(event, image) {
  if (!resizeSession || resizeSession.mode !== 'text' || resizeSession.pointerId !== event.pointerId) return;
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

function updateQrResize(event, image) {
  if (!resizeSession || resizeSession.mode !== 'qr' || resizeSession.pointerId !== event.pointerId) return;
  const layer = getLayer(resizeSession.imageId, resizeSession.layerId);
  if (!layer) return;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const px = clamp(pointer.x, 0, image.width);
  const py = clamp(pointer.y, 0, image.height);
  const { anchor, direction, margin, minTile } = resizeSession;
  const availableWidth = direction.x === 1 ? image.width - anchor.x : anchor.x;
  const availableHeight = direction.y === 1 ? image.height - anchor.y : anchor.y;
  const rawWidth = Math.max(0, (px - anchor.x) * direction.x);
  const rawHeight = Math.max(0, (py - anchor.y) * direction.y);
  const fallbackWidth = rawWidth || rawHeight;
  const fallbackHeight = rawHeight || rawWidth;
  const candidate = Math.min(fallbackWidth, fallbackHeight);
  const maxTile = Math.min(
    Math.max(minTile, availableWidth),
    Math.max(minTile, availableHeight),
    Math.max(minTile, Math.min(image.width, image.height)),
  );
  const lowerBound = Math.min(minTile, maxTile);
  const tileSize = clamp(candidate || lowerBound, lowerBound, maxTile);
  const halfTile = tileSize / 2;
  const centerX = clamp(anchor.x + halfTile * direction.x, halfTile, image.width - halfTile);
  const centerY = clamp(anchor.y + halfTile * direction.y, halfTile, image.height - halfTile);
  const innerSize = Math.max(tileSize - margin * 2, 24);
  const updates = {
    size: innerSize,
    margin,
    position: {
      x: clamp(centerX / image.width, 0, 1),
      y: clamp(centerY / image.height, 0, 1),
    },
  };
  updateLayer(resizeSession.imageId, resizeSession.layerId, updates);
  renderer.render();
}

function updateLogoResize(event, image) {
  if (!resizeSession || resizeSession.mode !== 'logo-scale' || resizeSession.pointerId !== event.pointerId) return;
  const layer = getLayer(resizeSession.imageId, resizeSession.layerId);
  if (!layer) return;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const vector = {
    x: pointer.x - resizeSession.center.x,
    y: pointer.y - resizeSession.center.y,
  };
  const distance = Math.hypot(vector.x, vector.y);
  if (!distance) return;
  const ratio = distance / resizeSession.initialDistance;
  let nextScale = resizeSession.initialScale * ratio;
  if (!Number.isFinite(nextScale)) return;
  if (event.shiftKey) {
    const step = 0.05;
    nextScale = Math.round(nextScale / step) * step;
  }
  nextScale = clamp(nextScale, resizeSession.minScale, resizeSession.maxScale);
  const currentScale = Number.isFinite(layer.scale) ? layer.scale : 1;
  if (Math.abs(currentScale - nextScale) < 1e-3) return;
  updateLayer(resizeSession.imageId, resizeSession.layerId, { scale: nextScale });
  renderer.render();
}

function updateLogoRotate(event, image) {
  if (!resizeSession || resizeSession.mode !== 'logo-rotate' || resizeSession.pointerId !== event.pointerId) return;
  const layer = getLayer(resizeSession.imageId, resizeSession.layerId);
  if (!layer) return;
  const pointer = renderer.screenToImage(event.clientX, event.clientY);
  const dx = pointer.x - resizeSession.center.x;
  const dy = pointer.y - resizeSession.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return;
  const angle = Math.atan2(dy, dx);
  const delta = angle - resizeSession.initialAngle;
  let rotationDeg = resizeSession.initialRotation + (delta * 180) / Math.PI;
  if (event.shiftKey) {
    const snap = 15;
    rotationDeg = Math.round(rotationDeg / snap) * snap;
  }
  rotationDeg = normalizeAngle(rotationDeg);
  const currentRotation = normalizeAngle(layer.rotation || 0);
  if (Math.abs(currentRotation - rotationDeg) < 0.2) return;
  updateLayer(resizeSession.imageId, resizeSession.layerId, { rotation: rotationDeg });
  renderer.render();
}

function finishTextResize(pointerId) {
  if (
    !resizeSession ||
    resizeSession.mode !== 'text' ||
    (typeof pointerId === 'number' && resizeSession.pointerId !== pointerId)
  ) {
    return;
  }
  const image = getImage(resizeSession.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  resizeSession = null;
  queueOverlaySync();
}

function finishQrResize(pointerId) {
  if (
    !resizeSession ||
    resizeSession.mode !== 'qr' ||
    (typeof pointerId === 'number' && resizeSession.pointerId !== pointerId)
  ) {
    return;
  }
  const image = getImage(resizeSession.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  resizeSession = null;
  queueOverlaySync();
}

function finishLogoResize(pointerId) {
  if (
    !resizeSession ||
    resizeSession.mode !== 'logo-scale' ||
    (typeof pointerId === 'number' && resizeSession.pointerId !== pointerId)
  ) {
    return;
  }
  const image = getImage(resizeSession.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  resizeSession = null;
  queueOverlaySync();
  renderToolPanel(layerTypes.LOGO);
}

function finishLogoRotate(pointerId) {
  if (
    !resizeSession ||
    resizeSession.mode !== 'logo-rotate' ||
    (typeof pointerId === 'number' && resizeSession.pointerId !== pointerId)
  ) {
    selectionOverlay?.classList.remove('is-rotating');
    return;
  }
  const image = getImage(resizeSession.imageId) || getActiveImage();
  if (image) {
    pushHistory(image.id);
  }
  resizeSession = null;
  selectionOverlay?.classList.remove('is-rotating');
  queueOverlaySync();
  renderToolPanel(layerTypes.LOGO);
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
  const offsetX = Number.isFinite(current.x) ? current.x : 0;
  const offsetY = Number.isFinite(current.y) ? current.y : 0;
  const contentWidth = image.width * scale;
  const contentHeight = image.height * scale;
  let clampedX;
  if (contentWidth <= viewWidth) {
    clampedX = (viewWidth - contentWidth) / 2;
  } else {
    const minX = viewWidth - contentWidth;
    const centeredX = clamp((viewWidth - contentWidth) / 2, minX, 0);
    if (offsetX > 0) {
      clampedX = centeredX;
    } else if (offsetX < minX) {
      clampedX = minX;
    } else {
      clampedX = clamp(offsetX, minX, 0);
    }
  }
  let clampedY;
  if (contentHeight <= viewHeight) {
    clampedY = (viewHeight - contentHeight) / 2;
  } else {
    const minY = viewHeight - contentHeight;
    const centeredY = clamp((viewHeight - contentHeight) / 2, minY, 0);
    if (offsetY > 0) {
      clampedY = centeredY;
    } else if (offsetY < minY) {
      clampedY = minY;
    } else {
      clampedY = clamp(offsetY, minY, 0);
    }
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
  updateStatusBar({ zoom: `Thu phóng: ${(image.zoom * 100).toFixed(0)}%` });
}

async function handleDeleteLayer() {
  const image = getActiveImage();
  if (!image || !state.activeLayerId) return;
  const confirmed = await showConfirm({
    message: state.locale === 'vi'
      ? 'Xoá lớp này? Thao tác không thể hoàn tác.'
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
        ? 'Chọn công cụ và thiết lập thông số trước khi lưu.'
        : 'Pick a tool and configure it before saving a preset.',
      tone: 'warn',
    });
    return;
  }
  const name = prompt(state.locale === 'vi' ? 'Đặt tên thiết lập' : 'Preset name', payload.name || '');
  if (!name) return;
  addPreset({
    name,
    tool,
    payload,
  });
  showToast({
    title: state.locale === 'vi' ? 'Đã lưu thiết lập' : 'Preset saved',
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
  const presetName = localize(preset.name);
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
  toolDefaults[layerTypes.TEXT].signaturePresetName = presetName;
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
      signaturePresetName: presetName,
    });
    setActiveLayer(targetLayer.id);
  } else {
    updateLayer(image.id, targetLayer.id, {
      ...updates,
      signaturePresetId: preset.id,
      signaturePresetName: presetName,
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
  syncTextStyleControls();
  if (layerPanel) {
    layerPanel.hidden = !showTextToolbar;
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
  const image = getActiveImage();
  const activeLayer = image ? getLayer(image.id, state.activeLayerId) : null;
  const lastStroke = activeLayer?.type === layerTypes.PEN && Array.isArray(activeLayer.strokes) && activeLayer.strokes.length
    ? activeLayer.strokes[activeLayer.strokes.length - 1]
    : null;
  const thicknessPresets = [2, 4, 6, 8, 12];
  const currentColor = lastStroke?.color || defaults.color || PEN_COLOR_PRESETS[0];
  const currentSize = Number.isFinite(lastStroke?.size) ? lastStroke.size : (Number.isFinite(defaults.size) ? defaults.size : 4);
  const currentSmoothing = Number.isFinite(defaults.smoothing) ? defaults.smoothing : 0.65;
  const resolvedCapDefault = defaults.cap || (defaults.roundCap ? 'round' : 'butt');
  const layerCap = activeLayer?.cap;
  const currentCap = lastStroke?.cap
    || layerCap
    || (lastStroke?.roundCap === false ? 'butt' : resolvedCapDefault);
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
        <div class="pen-section-header">
          <h4>${localeIsVi ? 'Kiểu đầu nét' : 'Stroke caps'}</h4>
          <p>${localeIsVi ? 'Chọn kiểu kết thúc nét cho chữ ký.' : 'Choose how stroke endings should look.'}</p>
        </div>
        <div class="pen-cap-group">
          ${PEN_CAP_OPTIONS.map(option => {
            const isActive = option.id === currentCap;
            return `
              <button type="button" class="pen-cap-button${isActive ? ' is-active' : ''}" data-cap="${option.id}">
                <span class="pen-cap-preview" data-shape="${option.icon}"></span>
                <span>${option.label}</span>
              </button>
            `;
          }).join('')}
        </div>
        <div class="pen-actions">
          <button type="button" class="btn ghost" data-action="pen-undo">
            <svg class="icon"><use href="#icon-undo"></use></svg>
            <span>${localeIsVi ? 'Hoàn tác' : 'Undo'}</span>
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
      cap: updates.cap ?? toolDefaults[layerTypes.PEN].cap,
      roundCap: updates.cap ? updates.cap === 'round' : (updates.roundCap ?? toolDefaults[layerTypes.PEN].roundCap),
    };
    if (updates.cap) {
      toolDefaults[layerTypes.PEN].cap = updates.cap;
      toolDefaults[layerTypes.PEN].roundCap = updates.cap === 'round';
    }
    if (!updates.cap && Object.prototype.hasOwnProperty.call(updates, 'roundCap')) {
      toolDefaults[layerTypes.PEN].cap = updates.roundCap ? 'round' : 'butt';
    }
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

  const capButtons = Array.from(container.querySelectorAll('.pen-cap-button'));
  const setCap = value => {
    const capValue = PEN_CAP_OPTIONS.some(option => option.id === value) ? value : 'round';
    setPenDefaults({ cap: capValue, roundCap: capValue === 'round' });
    capButtons.forEach(button => {
      button.classList.toggle('is-active', button.dataset.cap === capValue);
    });
  };
  capButtons.forEach(button => {
    addListener(button, 'click', () => setCap(button.dataset.cap));
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
  setCap(currentCap);

  return () => {
    disposers.forEach(dispose => dispose());
  };
}

function renderLogoPanel(container) {
  const image = getActiveImage();
  const logoLayers = image ? image.layers.filter(layer => layer.type === layerTypes.LOGO && layer.asset) : [];
  const activeLogoId = state.activeLayerId;
  const defaults = toolDefaults[layerTypes.LOGO];
  const localeIsVi = state.locale === 'vi';
  const copy = localeIsVi
    ? {
        pick: 'Chọn logo',
        removeBg: 'Xoá nền',
        removeBgWorking: 'Đang xử lý...',
        removeBgDone: 'Đã xoá nền logo.',
        removeBgNoChange: 'Không thấy nền để xoá.',
        removeBgFailed: 'Không thể xoá nền logo.',
        removeBgRemoved: 'Đã xoá nền',
        toastTitle: 'Xử lý logo',
        empty: 'Chưa có logo nào. Nhấn “Chọn logo” để thêm.',
        delete: 'Xoá',
        deleted: 'Đã xoá logo khỏi danh sách.',
      }
    : {
        pick: 'Choose logo',
        removeBg: 'Remove bg',
        removeBgWorking: 'Processing...',
        removeBgDone: 'Background removed.',
        removeBgNoChange: 'No background detected to remove.',
        removeBgFailed: 'Unable to remove the logo background.',
        removeBgRemoved: 'Background cleared',
        toastTitle: 'Logo tools',
        empty: 'No logos yet. Click “Choose logo” to add one.',
        delete: 'Delete',
        deleted: 'Logo removed from the list.',
      };
  const escapeHtml = value => (value == null ? '' : String(value)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = value => escapeHtml(value).replace(/"/g, '&quot;');
  container.innerHTML = `
    <section class="logo-panel">
      <div class="logo-toolbar">
        <div class="logo-icon-bubble">
          <svg class="icon"><use href="#icon-sticker"></use></svg>
        </div>
        <button type="button" class="btn primary" data-action="pick-logo">
          <svg class="icon"><use href="#icon-upload"></use></svg>
          <span>${copy.pick}</span>
        </button>
      </div>
      ${logoLayers.length ? `
        <ul class="logo-grid">
          ${logoLayers
            .map(layer => {
              const assetSrc = escapeAttr(layer.assetDataUrl || layer.asset?.src || '');
              const removed = layer.removedBackground === true;
              const isActive = layer.id === activeLogoId;
              const thumb = assetSrc
                ? `<img src="${assetSrc}" alt="">`
                : `<div class="logo-thumb-placeholder"><svg class="icon"><use href="#icon-sticker"></use></svg></div>`;
              return `
                <li class="logo-card${isActive ? ' is-active' : ''}" data-logo-id="${layer.id}">
                  <div class="logo-card-thumb">
                    <div class="logo-card-image">${thumb}</div>
                  </div>
                  <div class="logo-card-actions">
                    <button type="button" class="btn pill" data-logo-action="remove-bg" ${removed ? 'disabled' : ''}>${removed ? copy.removeBgRemoved : copy.removeBg}</button>
                    <button type="button" class="btn pill danger" data-logo-action="delete">${copy.delete}</button>
                  </div>
                </li>
              `;
            })
            .join('')}
        </ul>
      ` : `<p class="logo-empty">${copy.empty}</p>`}
    </section>
  `;
  const disposers = [];
  const addListener = (element, event, handler) => {
    if (!element) return;
    element.addEventListener(event, handler);
    disposers.push(() => element.removeEventListener(event, handler));
  };
  addListener(container.querySelector('[data-action="pick-logo"]'), 'click', event => {
    event.preventDefault();
    logoInput?.click();
  });
  const list = container.querySelector('.logo-grid');
  if (list) {
    addListener(list, 'click', async event => {
      const actionButton = event.target.closest('[data-logo-action]');
      const item = event.target.closest('.logo-card');
      if (!item) return;
      const { logoId } = item.dataset;
      if (!logoId) return;
      const imageState = getActiveImage();
      if (!imageState) return;
      const targetLayer = getLayer(imageState.id, logoId);
      if (!targetLayer || targetLayer.type !== layerTypes.LOGO) return;
      if (actionButton) {
        event.preventDefault();
        event.stopPropagation();
        const action = actionButton.dataset.logoAction;
        if (action === 'remove-bg') {
          if (actionButton.disabled) return;
          actionButton.disabled = true;
          const originalLabel = actionButton.textContent;
          actionButton.textContent = copy.removeBgWorking;
          try {
            const result = await removeLogoLayerBackground(imageState, targetLayer);
            if (result.changed) {
              showToast({
                title: copy.toastTitle,
                message: copy.removeBgDone,
                tone: 'success',
              });
            } else {
              showToast({
                title: copy.toastTitle,
                message: copy.removeBgNoChange,
                tone: 'neutral',
              });
              actionButton.disabled = false;
              actionButton.textContent = originalLabel;
            }
          } catch (error) {
            console.error(error);
            showToast({
              title: copy.toastTitle,
              message: copy.removeBgFailed,
              tone: 'danger',
            });
            actionButton.disabled = false;
            actionButton.textContent = originalLabel;
          }
          renderToolPanel(layerTypes.LOGO);
          renderer.render();
          return;
        }
        if (action === 'delete') {
          removeLayer(imageState.id, logoId);
          renderer.render();
          showToast({
            title: copy.toastTitle,
            message: copy.deleted,
            tone: 'success',
          });
          renderToolPanel(layerTypes.LOGO);
          return;
        }
        return;
      }
      setActiveLayer(logoId);
      renderToolPanel(layerTypes.LOGO);
      renderer.render();
    });
  }
  return () => {
    disposers.forEach(dispose => dispose());
  };
}


function renderWatermarkPanel(container) {
  const image = getActiveImage();
  const layer = image ? getLayer(image.id, state.activeLayerId) : null;
  const current = layer?.type === layerTypes.WATERMARK ? layer : toolDefaults[layerTypes.WATERMARK];
  const disabled = !(layer && layer.type === layerTypes.WATERMARK);
  const sliderPercent = Math.round((current.opacity ?? 0.25) * 100);
  container.innerHTML = `
    <div class="wm-card">
      <div class="wm-header">
        <h3>${state.locale === 'vi' ? 'Dấu mờ' : 'Watermark'}</h3>
        <p>${state.locale === 'vi' ? 'Tạo dấu mờ lặp theo góc và khoảng cách.' : 'Lay down repeating watermark text with angle and spacing control.'}</p>
      </div>
      <form id="watermarkForm" class="wm-form">
        <label class="wm-field">
          <span class="wm-label">${state.locale === 'vi' ? 'Nội dung dấu mờ' : 'Watermark text'}</span>
          <textarea name="text" rows="2" ${disabled ? 'disabled' : ''}>${current.text}</textarea>
        </label>
        <div class="wm-grid pairs">
          <label class="wm-field">
            <span class="wm-label">${state.locale === 'vi' ? 'Kích thước' : 'Font size'}</span>
            <input type="number" name="fontSize" min="12" max="140" value="${current.fontSize}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="wm-field wm-select">
            <span class="wm-label">${state.locale === 'vi' ? 'Góc xoay' : 'Angle'}</span>
            <select name="angle"${disabled ? ' disabled' : ''}>
              <option value="-45"${current.angle === -45 ? ' selected' : ''}>-45°</option>
              <option value="45"${current.angle === 45 ? ' selected' : ''}>45°</option>
            </select>
          </label>
        </div>
        <div class="wm-field wm-slider-field">
          <div class="wm-slider-head">
            <span class="wm-label">${state.locale === 'vi' ? 'Độ mờ (%)' : 'Opacity (%)'}</span>
            <span class="wm-slider-value">${sliderPercent}%</span>
          </div>
          <input type="range" name="opacity" min="5" max="80" value="${sliderPercent}" ${disabled ? 'disabled' : ''}>
        </div>
        <div class="wm-grid pairs">
          <label class="wm-field">
            <span class="wm-label">${state.locale === 'vi' ? 'Khoảng cách ngang' : 'Spacing X'}</span>
            <input type="number" name="spacingX" min="60" max="400" value="${current.spacingX}" ${disabled ? 'disabled' : ''}>
          </label>
          <label class="wm-field">
            <span class="wm-label">${state.locale === 'vi' ? 'Khoảng cách dọc' : 'Spacing Y'}</span>
            <input type="number" name="spacingY" min="40" max="400" value="${current.spacingY}" ${disabled ? 'disabled' : ''}>
          </label>
        </div>
      </form>
      <button type="button" class="btn primary wm-submit" data-action="add-watermark"${disabled ? '' : ' hidden'}>
        ${state.locale === 'vi' ? 'Thêm dấu mờ' : 'Add watermark'}
      </button>
    </div>
  `;
  const form = container.querySelector('#watermarkForm');
  if (!form) return;
  const sliderInput = form.elements.opacity;
  const sliderLabel = form.querySelector('.wm-slider-value');
  const updateSliderLabel = () => {
    if (sliderInput && sliderLabel) {
      sliderLabel.textContent = `${Math.round(parseFloat(sliderInput.value))}%`;
    }
  };
  updateSliderLabel();
  const handleChange = () => {
    updateSliderLabel();
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
  const getActiveQrLayer = () => {
    const imageState = getActiveImage();
    if (!imageState) return null;
    const activeLayer = getLayer(imageState.id, state.activeLayerId);
    if (activeLayer && activeLayer.type === layerTypes.QR) {
      return activeLayer;
    }
    return null;
  };
  const layer = getActiveQrLayer();
  const defaults = toolDefaults[layerTypes.QR] || {};
  const current = layer || defaults;
  const isVi = state.locale === 'vi';
  const ensureString = value => (typeof value === 'string' ? value : '');
  const resolveInputType = source => (source && source.inputType === 'link' ? 'link' : 'text');
  const defaultInputType = resolveInputType(defaults);
  const layerInputType = layer ? resolveInputType(layer) : null;
  const inputType = layerInputType || defaultInputType;
  const defaultTextContent = ensureString(
    defaults.textContent ?? (defaultInputType === 'text' ? defaults.text : '')
  );
  const defaultLinkContent = ensureString(
    defaults.link ?? (defaultInputType === 'link' ? defaults.text : '')
  );
  const textFieldValue = ensureString(
    layer
      ? layer.textContent ?? (layerInputType === 'text' ? layer.text : defaultTextContent)
      : defaultTextContent
  );
  const linkFieldValue = ensureString(
    layer
      ? layer.link ?? (layerInputType === 'link' ? layer.text : defaultLinkContent)
      : defaultLinkContent
  );
  const normalizedInitialLink = linkFieldValue.trim();
  const initialContent = inputType === 'link' ? linkFieldValue : textFieldValue;
  const baseSize = typeof current.size === 'number' ? current.size : typeof defaults.size === 'number' ? defaults.size : 220;
  const baseMargin = typeof current.margin === 'number' ? current.margin : typeof defaults.margin === 'number' ? defaults.margin : 12;
  const baseOpacity = typeof current.opacity === 'number' ? current.opacity : typeof defaults.opacity === 'number' ? defaults.opacity : 1;
  const basePosition = current.position || defaults.position || { x: 0.5, y: 0.5 };
  const copy = isVi
    ? {
        introBody: 'Nhập nội dung chữ ký tiếng Việt có dấu hoặc dán liên kết web, ứng dụng sẽ tạo mã QR rõ nét để đặt lên ảnh.',
        contentLegend: 'Loại nội dung',
        textOption: 'Văn bản',
        textOptionCaption: 'QR chứa trọn nội dung chữ ký, hỗ trợ tiếng Việt đầy đủ dấu.',
        linkOption: 'Liên kết',
        linkOptionCaption: 'QR dẫn đến website, tài liệu hoặc trang đặt lịch.',
        textLabel: 'Nội dung chữ ký',
        textHelp: 'Hỗ trợ tiếng Việt có dấu và nhiều ngôn ngữ khác.',
        linkLabel: 'Đường dẫn QR',
        linkHelp: 'Dán URL website, tài liệu hoặc trang cần chia sẻ.',
        placeholderDefault: 'Nhập chữ ký hoặc dán liên kết để tạo mã QR.',
        placeholderTooLong: 'Nội dung quá dài, hãy rút gọn hoặc chia thành nhiều mã.',
        placeholderGeneric: 'Không thể tạo mã QR với nội dung này. Vui lòng rút gọn hoặc kiểm tra lại.',
        textPlaceholder: 'Ví dụ: Bác sĩ Nguyễn - Phòng nha khoa - 0900 000 000',
        linkPlaceholder: 'https://congty.com/chu-ky-so',
        previewPlaced: 'Đã chèn trên ảnh',
        previewReady: 'Đã tạo bản xem trước',
        previewEmpty: 'Nhập nội dung để tạo mã',
        previewTooLong: 'Nội dung vượt giới hạn QR',
        previewError: 'Không thể hiển thị mã QR',
        previewButton: 'Quét thử bằng camera',
        createButton: 'Chèn vào ảnh',
        hint: 'Mã QR nằm trên nền trắng nhẹ để dễ đọc trên ảnh của bạn.',
        toastTitle: 'QR quá dài',
        toastMessage: 'Rút gọn nội dung hoặc chia thành nhiều mã trước khi chèn.'
      }
    : {
        introBody: 'Enter your signature text or paste a link. We will generate a crisp QR tile ready for your artwork.',
        contentLegend: 'Content type',
        textOption: 'Text',
        textOptionCaption: 'Embed the signature details directly inside the QR.',
        linkOption: 'Link',
        linkOptionCaption: 'Point the code to a website, document, or booking page.',
        textLabel: 'Signature text',
        textHelp: 'Supports Vietnamese diacritics and many other languages.',
        linkLabel: 'QR link',
        linkHelp: 'Paste the website or document URL to encode.',
        placeholderDefault: 'Enter text or paste a link to generate the QR code.',
        placeholderTooLong: 'Content is too long. Please shorten it or split it across multiple codes.',
        placeholderGeneric: 'Unable to generate a QR code for this content. Try shortening or adjusting it.',
        textPlaceholder: 'Example: Dr. Nguyen - Dental Clinic - 0900 000 000',
        linkPlaceholder: 'https://company.com/signature',
        previewPlaced: 'Placed on canvas',
        previewReady: 'Preview ready',
        previewEmpty: 'Enter content to generate',
        previewTooLong: 'Content exceeds QR limits',
        previewError: 'Unable to show QR preview',
        previewButton: 'Test with camera',
        createButton: 'Add to canvas',
        hint: 'The QR code sits on a soft white tile so it stays legible on your artwork.',
        toastTitle: 'QR too long',
        toastMessage: 'Shorten the content or split it across multiple QR codes before adding it.'
      };
  const escapeHtml = value => ensureString(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = value => escapeHtml(value).replace(/"/g, '&quot;');
  container.innerHTML = `
    <div class='qr-panel'>
      <div class='qr-panel-intro'>
        <p>${copy.introBody}</p>
      </div>
      <form id='qrForm' class='form-grid qr-form'>
        <fieldset class='field qr-fieldset'>
          <legend>${copy.contentLegend}</legend>
          <div class='qr-choice-group'>
            <label class='qr-choice-card'>
              <input type='radio' name='inputType' value='text'${inputType === 'text' ? ' checked' : ''}>
              <span class='qr-choice-content'>
                <span class='qr-choice-title'>${copy.textOption}</span>
                <span class='qr-choice-caption'>${copy.textOptionCaption}</span>
              </span>
            </label>
            <label class='qr-choice-card'>
              <input type='radio' name='inputType' value='link'${inputType === 'link' ? ' checked' : ''}>
              <span class='qr-choice-content'>
                <span class='qr-choice-title'>${copy.linkOption}</span>
                <span class='qr-choice-caption'>${copy.linkOptionCaption}</span>
              </span>
            </label>
          </div>
        </fieldset>
        <label class='field' data-role='text-field'${inputType === 'link' ? ' hidden' : ''}>
          <span>${copy.textLabel}</span>
          <textarea class='qr-textarea' name='text' rows='3' maxlength='720' placeholder='${escapeAttr(copy.textPlaceholder)}'>${escapeHtml(textFieldValue)}</textarea>
          <small>${copy.textHelp}</small>
        </label>
        <label class='field' data-role='link-field'${inputType === 'text' ? ' hidden' : ''}>
          <span>${copy.linkLabel}</span>
          <input type='url' name='link' inputmode='url' placeholder='${escapeAttr(copy.linkPlaceholder)}' value='${escapeAttr(linkFieldValue)}' spellcheck='false' autocomplete='off' maxlength='2048'>
          <small>${copy.linkHelp}</small>
        </label>
      </form>
      <aside class='qr-preview-card'>
        <div class='qr-preview-header'>
          <h4></h4>
          <span class='qr-preview-status' data-role='qr-state'>${layer ? copy.previewPlaced : current.dataUrl ? copy.previewReady : copy.previewEmpty}</span>
        </div>
        <div class='qr-preview-frame' data-role='qr-preview' data-state='${current.dataUrl ? 'ready' : 'empty'}'>
          <img src='${current.dataUrl ?? ''}' alt='${isVi ? 'Bản xem trước mã QR' : 'QR preview'}' loading='lazy'${current.dataUrl ? '' : ' hidden'}>
          <div class='qr-preview-placeholder' data-role='qr-empty'${current.dataUrl ? ' hidden' : ''}>
            <p>${copy.placeholderDefault}</p>
          </div>
        </div>
        <div class='qr-preview-actions'>
          <button type='button' class='btn secondary' data-action='preview' ${current.dataUrl ? '' : 'disabled'}>
            <svg class='icon'><use href='#icon-camera'></use></svg>
            <span>${copy.previewButton}</span>
          </button>
          <button type='button' class='btn primary' data-action='create'${layer ? ' hidden' : ''}>
            ${copy.createButton}
          </button>
        </div>
        <p class='qr-preview-hint'>
          ${copy.hint}
        </p>
      </aside>
    </div>
  `;
  const form = container.querySelector('#qrForm');
  if (!form) return;
  const previewFrame = container.querySelector('[data-role="qr-preview"]');
  const previewImage = previewFrame?.querySelector('img') || null;
  const previewPlaceholder = previewFrame?.querySelector('[data-role="qr-empty"]') || null;
  const previewButton = container.querySelector('[data-action="preview"]');
  const createButton = container.querySelector('[data-action="create"]');
  const statusLabel = container.querySelector('[data-role="qr-state"]');
  let previewError = null;
  let previewErrorCode = null;
  const placeholderTextEl = previewPlaceholder?.querySelector('p') || null;
  const inputTypeRadios = Array.from(form.querySelectorAll('input[name="inputType"]'));
  const textFieldWrapper = form.querySelector('[data-role="text-field"]');
  const linkFieldWrapper = form.querySelector('[data-role="link-field"]');
  const getSelectedInputType = () => {
    const node = form.elements.inputType;
    const raw = typeof node?.value === 'string' ? node.value : '';
    return raw === 'link' ? 'link' : 'text';
  };
  const syncInputType = () => {
    const selected = getSelectedInputType();
    textFieldWrapper?.toggleAttribute('hidden', selected !== 'text');
    linkFieldWrapper?.toggleAttribute('hidden', selected !== 'link');
  };
  const handleInputTypeToggle = () => {
    syncInputType();
  };
  inputTypeRadios.forEach(radio => {
    radio.addEventListener('change', handleInputTypeToggle);
  });
  syncInputType();
  let previewToken = 0;
  let currentPreviewDataUrl = current.dataUrl || null;
  const describeStatus = () => {
    if (previewErrorCode === 'too-long') {
      return copy.previewTooLong;
    }
    if (previewErrorCode) {
      return copy.previewError;
    }
    const activeLayer = getActiveQrLayer();
    if (activeLayer) {
      return copy.previewPlaced;
    }
    if (currentPreviewDataUrl) {
      return copy.previewReady;
    }
    return copy.previewEmpty;
  };
  const updateStatusLabel = () => {
    if (!statusLabel) return;
    statusLabel.textContent = describeStatus();
    const activeLayer = getActiveQrLayer();
    const statusState = previewErrorCode
      ? 'error'
      : activeLayer
        ? 'placed'
        : currentPreviewDataUrl
          ? 'ready'
          : 'idle';
    statusLabel.dataset.state = statusState;
  };
  const setPreview = dataUrl => {
    currentPreviewDataUrl = dataUrl || null;
    if (currentPreviewDataUrl) {
      previewError = null;
      previewErrorCode = null;
    }
    if (previewFrame) {
      const state = previewErrorCode ? 'error' : currentPreviewDataUrl ? 'ready' : 'empty';
      previewFrame.dataset.state = state;
    }
    if (previewImage) {
      if (currentPreviewDataUrl) {
        previewImage.hidden = false;
        previewImage.src = currentPreviewDataUrl;
      } else {
        previewImage.hidden = true;
        previewImage.removeAttribute('src');
      }
    }
    if (previewPlaceholder) {
      const showPlaceholder = !currentPreviewDataUrl;
      previewPlaceholder.hidden = !showPlaceholder;
      if (placeholderTextEl) {
        if (!showPlaceholder) {
          placeholderTextEl.textContent = copy.placeholderDefault;
        } else if (previewErrorCode === 'too-long') {
          placeholderTextEl.textContent = copy.placeholderTooLong;
        } else if (previewErrorCode) {
          placeholderTextEl.textContent = copy.placeholderGeneric;
        } else {
          placeholderTextEl.textContent = copy.placeholderDefault;
        }
      }
    } else if (placeholderTextEl) {
      placeholderTextEl.textContent = copy.placeholderDefault;
    }
    if (previewButton) {
      previewButton.disabled = !currentPreviewDataUrl;
    }
    updateStatusLabel();
  };
  const readFormValues = () => {
    const latestLayer = getActiveQrLayer();
    const baseline = latestLayer || defaults;
    const selectedType = getSelectedInputType();
    const textNode = form.elements.text;
    const linkNode = form.elements.link;
    const rawText = typeof textNode?.value === 'string' ? textNode.value : '';
    const rawLink = typeof linkNode?.value === 'string' ? linkNode.value : '';
    const normalizedLink = rawLink.trim();
    const qrContent = selectedType === 'link' ? normalizedLink : rawText;
    const size = typeof latestLayer?.size === 'number'
      ? latestLayer.size
      : typeof baseline.size === 'number'
        ? baseline.size
        : 220;
    const margin = typeof latestLayer?.margin === 'number'
      ? latestLayer.margin
      : typeof baseline.margin === 'number'
        ? baseline.margin
        : 12;
    const opacity = typeof latestLayer?.opacity === 'number'
      ? latestLayer.opacity
      : typeof baseline.opacity === 'number'
        ? baseline.opacity
        : 1;
    const position = latestLayer?.position
      ? { ...latestLayer.position }
      : baseline.position
        ? { ...baseline.position }
        : { x: 0.5, y: 0.5 };
    return {
      values: {
        text: qrContent,
        inputType: selectedType,
        textContent: rawText,
        link: normalizedLink,
        size,
        margin,
        opacity,
        position,
      },
      hasContent: selectedType === 'link' ? normalizedLink.length > 0 : rawText.trim().length > 0,
    };
  };
  const handleChange = async () => {
    const { values, hasContent } = readFormValues();
    const hostImage = getActiveImage();
    const activeLayer = getActiveQrLayer();
    const applyUpdate = payload => {
      if (activeLayer && hostImage) {
        updateLayer(hostImage.id, activeLayer.id, payload);
        renderer.render();
      }
      Object.assign(toolDefaults[layerTypes.QR], payload);
    };
    if (!hasContent) {
      previewToken += 1;
      previewError = null;
      previewErrorCode = null;
      applyUpdate({ ...values, dataUrl: null });
      setPreview(null);
      return;
    }
    const token = ++previewToken;
    const generated = await generateQr(values);
    if (token !== previewToken) return;
    const payload = { ...values };
    if (generated.error) {
      previewError = generated.error;
      previewErrorCode = generated.reason
        || (typeof generated.error?.message === 'string' && generated.error.message.toLowerCase().includes('too long')
          ? 'too-long'
          : 'render-failed');
      applyUpdate(payload);
      setPreview(null);
      return;
    }
    previewError = null;
    previewErrorCode = null;
    if (generated.dataUrl) {
      payload.dataUrl = generated.dataUrl;
    }
    applyUpdate(payload);
    if (generated.dataUrl) {
      setPreview(generated.dataUrl);
    }
  };
  const handlePreviewClick = () => {
    const source = getActiveQrLayer()?.dataUrl || currentPreviewDataUrl;
    if (!source) return;
    const canvas = document.getElementById('qrPreviewCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const size = Math.min(canvas.width, canvas.height) - 24;
      ctx.drawImage(img, (canvas.width - size) / 2, (canvas.height - size) / 2, size, size);
      showQrPreview();
    };
    img.src = source;
  };
  const handleCreateClick = async () => {
    const hostImage = getActiveImage();
    if (!hostImage) return;
    const { values, hasContent } = readFormValues();
    if (!hasContent) return;
    let dataUrl = currentPreviewDataUrl;
    if (!dataUrl) {
      const generated = await generateQr(values);
      if (generated.error || !generated.dataUrl) {
        previewError = generated.error || null;
        previewErrorCode = generated.reason
          || (typeof generated.error?.message === 'string' && generated.error.message.toLowerCase().includes('too long')
            ? 'too-long'
            : 'render-failed');
        setPreview(null);
        const now = Date.now();
        if (now - lastQrErrorAt > 1500) {
          showToast({
            title: copy.toastTitle,
            message: copy.toastMessage,
            tone: 'warning',
          });
          lastQrErrorAt = now;
        }
        return;
      }
      dataUrl = generated.dataUrl;
    }
    const payload = {
      type: layerTypes.QR,
      ...values,
      ...(dataUrl ? { dataUrl } : {}),
    };
    const newLayer = addLayer(hostImage.id, payload);
    Object.assign(toolDefaults[layerTypes.QR], { ...values, dataUrl });
    setActiveLayer(newLayer.id);
    renderer.render();
    renderToolPanel(layerTypes.QR);
  };
  form.addEventListener('input', handleChange);
  form.addEventListener('change', handleChange);
  previewButton?.addEventListener('click', handlePreviewClick);
  createButton?.addEventListener('click', handleCreateClick);
  previewError = null;
  previewErrorCode = null;
  setPreview(current.dataUrl || null);
  const hasInitialSeed = inputType === 'link'
    ? normalizedInitialLink.length > 0
    : initialContent.trim().length > 0;
  if (!current.dataUrl && hasInitialSeed) {
    const seed = {
      text: inputType === 'link' ? normalizedInitialLink : initialContent,
      inputType,
      textContent: textFieldValue,
      link: normalizedInitialLink,
      size: baseSize,
      margin: baseMargin,
      opacity: baseOpacity,
      position: { ...basePosition },
    };
    const token = ++previewToken;
    generateQr(seed).then(result => {
      if (token !== previewToken) return;
      if (result.error || !result.dataUrl) {
        previewError = result.error || null;
        previewErrorCode = result.reason
          || (typeof result.error?.message === 'string' && result.error.message.toLowerCase().includes('too long')
            ? 'too-long'
            : result.error
              ? 'render-failed'
              : previewErrorCode);
        if (!getActiveQrLayer()) {
          Object.assign(toolDefaults[layerTypes.QR], seed);
        }
        setPreview(null);
        return;
      }
      previewError = null;
      previewErrorCode = null;
      if (!getActiveQrLayer()) {
        Object.assign(toolDefaults[layerTypes.QR], { ...seed, dataUrl: result.dataUrl });
      }
      setPreview(result.dataUrl);
    });
  }
  return () => {
    previewToken += 1;
    form.removeEventListener('input', handleChange);
    form.removeEventListener('change', handleChange);
    if (previewButton) {
      previewButton.removeEventListener('click', handlePreviewClick);
    }
    if (createButton) {
      createButton.removeEventListener('click', handleCreateClick);
    }
    inputTypeRadios.forEach(radio => {
      radio.removeEventListener('change', handleInputTypeToggle);
    });
  };
}
async function generateQr(values) {
  return new Promise(resolve => {
    if (!window.QRCode) {
      resolve({});
      return;
    }
    const temp = document.createElement('div');
    const rawText = typeof values.text === 'string' ? values.text : '';
    const text = typeof rawText.normalize === 'function' ? rawText.normalize('NFC') : rawText;
    if (!text) {
      temp.remove();
      resolve({ dataUrl: null });
      return;
    }
    const baseSize = Math.max(320, Math.round((typeof values.size === 'number' ? values.size : 220) * 2));
    const baseMargin = clamp(Math.round(values.margin ?? 12), 0, Math.round(baseSize / 4));
    const config = {
      text,
      width: baseSize,
      height: baseSize,
      margin: baseMargin,
    };
    const correctLevels = [];
    if (window.QRCode.CorrectLevel) {
      const { L, M, Q, H } = window.QRCode.CorrectLevel;
      if (typeof H === 'number') correctLevels.push(H);
      if (typeof Q === 'number') correctLevels.push(Q);
      if (typeof M === 'number') correctLevels.push(M);
      if (typeof L === 'number') correctLevels.push(L);
    }
    if (!correctLevels.length) {
      correctLevels.push(2, 1);
    }
    let lastError = null;
    let created = false;
    for (const level of correctLevels) {
      if (created) break;
      temp.innerHTML = '';
      config.correctLevel = level;
      try {
        // eslint-disable-next-line no-new
        new window.QRCode(temp, config);
        created = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!created) {
      temp.remove();
      resolve({
        dataUrl: null,
        error: lastError || new Error('QR generation failed'),
        reason:
          typeof lastError?.message === 'string' && lastError.message.toLowerCase().includes('too long')
            ? 'too-long'
            : undefined,
      });
      return;
    }
    setTimeout(() => {
      const dataUrl = temp.querySelector('img')?.src || temp.querySelector('canvas')?.toDataURL('image/png');
      temp.remove();
      if (dataUrl) {
        resolve({ dataUrl, reason: null });
      } else {
        resolve({ dataUrl: null, error: new Error('QR render failed'), reason: 'render-failed' });
      }
    }, 40);
  }).catch(error => ({ dataUrl: null, error, reason: 'render-failed' }));
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
          <option value="blur"${current.mode === 'blur' ? ' selected' : ''}>${state.locale === 'vi' ? 'Làm mờ' : 'Blur'}</option>
          <option value="pixelate"${current.mode === 'pixelate' ? ' selected' : ''}>${state.locale === 'vi' ? 'Pixel hóa' : 'Pixelate'}</option>
        </select>
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Cường độ' : 'Intensity'}</span>
        <input type="range" name="intensity" min="2" max="40" value="${current.intensity}" ${disabled ? 'disabled' : ''}>
      </label>
      <p class="empty-hint">${state.locale === 'vi' ? 'Kéo trên khung vẽ để chọn vùng cần làm mờ.' : 'Drag on canvas to select region.'}</p>
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
        <span>${state.locale === 'vi' ? 'Tỷ lệ (%)' : 'Scale (%)'}</span>
        <input type="range" name="scale" min="25" max="200" value="100">
      </label>
      <label class="field">
        <span>${state.locale === 'vi' ? 'Chất lượng' : 'Quality'}</span>
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

