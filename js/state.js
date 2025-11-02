const randomId = (prefix = 'id') => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
};

export const events = new EventTarget();

const HISTORY_LIMIT = 40;
const PRESET_STORAGE_KEY = 'signapp:presets';
const THEME_STORAGE_KEY = 'signapp:theme';
const LOCALE_STORAGE_KEY = 'signapp:locale';

export const state = {
  locale: document.documentElement.dataset.locale || 'vi',
  theme: document.documentElement.dataset.theme || 'light',
  images: [],
  activeImageId: null,
  activeLayerId: null,
  activeTool: 'text',
  presets: [],
  offline: !navigator.onLine,
};

export const layerTypes = {
  TEXT: 'text',
  PEN: 'pen',
  LOGO: 'logo',
  WATERMARK: 'watermark',
  QR: 'qr',
  BLUR: 'blur',
};

export function setTheme(theme) {
  if (!theme) return;
  state.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    /* ignore */
  }
  document.documentElement.dataset.theme = theme;
  events.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function setLocale(locale) {
  if (!locale) return;
  state.locale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (error) {
    /* ignore */
  }
  document.documentElement.dataset.locale = locale;
  events.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
}

export function setOffline(value) {
  state.offline = Boolean(value);
  events.dispatchEvent(new CustomEvent('networkchange', { detail: { offline: state.offline } }));
}

export function getActiveImage() {
  if (!state.activeImageId) return null;
  return state.images.find(image => image.id === state.activeImageId) || null;
}

export function getImage(imageId) {
  if (!imageId) return null;
  return state.images.find(image => image.id === imageId) || null;
}

export function setActiveImage(imageId) {
  const imageExists = state.images.some(img => img.id === imageId);
  state.activeImageId = imageExists ? imageId : null;
  if (imageExists) {
    const image = getActiveImage();
    if (image && image.layers.length) {
      state.activeLayerId = image.layers[image.layers.length - 1].id;
    } else {
      state.activeLayerId = null;
    }
  } else {
    state.activeLayerId = null;
  }
  events.dispatchEvent(new CustomEvent('imagechange', { detail: { imageId: state.activeImageId } }));
}

export function setActiveLayer(layerId) {
  state.activeLayerId = layerId || null;
  events.dispatchEvent(new CustomEvent('layerchange', { detail: { layerId: state.activeLayerId } }));
}

export function setActiveTool(toolId) {
  if (!toolId || state.activeTool === toolId) return;
  state.activeTool = toolId;
  events.dispatchEvent(new CustomEvent('toolchange', { detail: { toolId } }));
}

export function addImage(image) {
  const imageState = {
    ...image,
    id: image.id || randomId('img'),
    createdAt: Date.now(),
    layers: image.layers || [],
    history: image.history || { undo: [], redo: [] },
    zoom: image.zoom || 1,
    pan: image.pan || { x: 0, y: 0 },
    grid: image.grid ?? false,
    snap: image.snap ?? true,
    ruler: image.ruler ?? false,
  };
  state.images.push(imageState);
  setActiveImage(imageState.id);
  pushHistory(imageState.id, { silent: true });
  events.dispatchEvent(new CustomEvent('imagelistchange', { detail: { images: state.images.slice() } }));
  return imageState;
}

export function updateImage(imageId, changes = {}) {
  const image = getImage(imageId);
  if (!image) return null;
  Object.assign(image, changes);
  events.dispatchEvent(new CustomEvent('imageupdate', { detail: { imageId, image } }));
  return image;
}

export function removeImage(imageId) {
  const index = state.images.findIndex(image => image.id === imageId);
  if (index === -1) return;
  const [removed] = state.images.splice(index, 1);
  if (removed?.objectUrl) {
    URL.revokeObjectURL(removed.objectUrl);
  }
  if (state.activeImageId === imageId) {
    const next = state.images[index] || state.images[index - 1] || null;
    setActiveImage(next?.id || null);
  }
  events.dispatchEvent(new CustomEvent('imagelistchange', { detail: { images: state.images.slice() } }));
}

export function clearImages() {
  state.images.forEach(image => {
    if (image?.objectUrl) {
      URL.revokeObjectURL(image.objectUrl);
    }
    if (image?.bitmap && typeof image.bitmap.close === 'function') {
      image.bitmap.close();
    }
  });
  state.images = [];
  state.activeImageId = null;
  state.activeLayerId = null;
  events.dispatchEvent(new CustomEvent('imagelistchange', { detail: { images: [] } }));
}

export function getLayer(imageId, layerId) {
  const image = getImage(imageId);
  if (!image) return null;
  return image.layers.find(layer => layer.id === layerId) || null;
}

export function addLayer(imageId, layer) {
  const image = getImage(imageId);
  if (!image) return null;
  const layerState = {
    id: randomId(layer.type || 'layer'),
    createdAt: Date.now(),
    visible: layer.visible ?? true,
    locked: layer.locked ?? false,
    ...layer,
  };
  image.layers.push(layerState);
  setActiveLayer(layerState.id);
  pushHistory(imageId);
  events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId, layers: image.layers.slice() } }));
  return layerState;
}

export function updateLayer(imageId, layerId, changes) {
  const image = getImage(imageId);
  if (!image) return null;
  const layer = image.layers.find(item => item.id === layerId);
  if (!layer) return null;
  Object.assign(layer, typeof changes === 'function' ? changes(layer) || layer : changes);
  pushHistory(imageId);
  events.dispatchEvent(new CustomEvent('layerupdate', { detail: { imageId, layer } }));
  return layer;
}

export function removeLayer(imageId, layerId) {
  const image = getImage(imageId);
  if (!image) return;
  const index = image.layers.findIndex(layer => layer.id === layerId);
  if (index === -1) return;
  image.layers.splice(index, 1);
  if (state.activeLayerId === layerId) {
    const next = image.layers[index] || image.layers[index - 1] || null;
    setActiveLayer(next?.id || null);
  }
  pushHistory(imageId);
  events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId, layers: image.layers.slice() } }));
}

export function reorderLayers(imageId, fromIndex, toIndex) {
  const image = getImage(imageId);
  if (!image) return;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= image.layers.length || toIndex >= image.layers.length) {
    return;
  }
  const [moved] = image.layers.splice(fromIndex, 1);
  image.layers.splice(toIndex, 0, moved);
  pushHistory(imageId);
  events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId, layers: image.layers.slice() } }));
}

export function pushHistory(imageId, options = {}) {
  const image = getImage(imageId);
  if (!image) return;
  const snapshot = JSON.stringify({ layers: image.layers, pan: image.pan, zoom: image.zoom });
  const stack = image.history?.undo || [];
  stack.push(snapshot);
  if (stack.length > HISTORY_LIMIT) {
    stack.shift();
  }
  image.history = {
    undo: stack,
    redo: options.clearRedo ? [] : image.history?.redo || [],
  };
  if (!options.silent) {
    events.dispatchEvent(new CustomEvent('historychange', { detail: { imageId } }));
  }
}

function applyHistorySnapshot(image, snapshot) {
  if (!snapshot) return;
  try {
    const data = JSON.parse(snapshot);
    image.layers = data.layers || [];
    if (data.pan) image.pan = data.pan;
    if (data.zoom) image.zoom = data.zoom;
    events.dispatchEvent(new CustomEvent('layerlistchange', { detail: { imageId: image.id, layers: image.layers.slice() } }));
  } catch (error) {
    console.warn('Failed to restore history snapshot', error);
  }
}

export function undo(imageId) {
  const image = getImage(imageId);
  if (!image || !image.history?.undo?.length) return;
  const snapshot = image.history.undo.pop();
  if (!image.history.redo) image.history.redo = [];
  image.history.redo.push(JSON.stringify({ layers: image.layers, pan: image.pan, zoom: image.zoom }));
  applyHistorySnapshot(image, snapshot);
  events.dispatchEvent(new CustomEvent('historychange', { detail: { imageId } }));
}

export function redo(imageId) {
  const image = getImage(imageId);
  if (!image || !image.history?.redo?.length) return;
  const snapshot = image.history.redo.pop();
  if (!image.history.undo) image.history.undo = [];
  image.history.undo.push(JSON.stringify({ layers: image.layers, pan: image.pan, zoom: image.zoom }));
  applyHistorySnapshot(image, snapshot);
  events.dispatchEvent(new CustomEvent('historychange', { detail: { imageId } }));
}

export function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      state.presets = parsed;
      return parsed;
    }
  } catch (error) {
    console.warn('Failed to load presets', error);
  }
  state.presets = [];
  return [];
}

export function savePresets() {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(state.presets));
  } catch (error) {
    console.warn('Failed to save presets', error);
  }
}

export function addPreset(preset) {
  const presetState = {
    id: preset.id || randomId('preset'),
    name: preset.name || (state.locale === 'vi' ? 'Thiết lập' : 'Preset'),
    createdAt: Date.now(),
    tool: preset.tool || state.activeTool,
    payload: preset.payload || {},
  };
  state.presets.push(presetState);
  savePresets();
  events.dispatchEvent(new CustomEvent('presetchange', { detail: { presets: state.presets.slice() } }));
  return presetState;
}

export function updatePreset(presetId, changes) {
  const preset = state.presets.find(item => item.id === presetId);
  if (!preset) return null;
  Object.assign(preset, changes);
  savePresets();
  events.dispatchEvent(new CustomEvent('presetchange', { detail: { presets: state.presets.slice() } }));
  return preset;
}

export function removePreset(presetId) {
  const index = state.presets.findIndex(item => item.id === presetId);
  if (index === -1) return;
  state.presets.splice(index, 1);
  savePresets();
  events.dispatchEvent(new CustomEvent('presetchange', { detail: { presets: state.presets.slice() } }));
}

export function ensureDefaultPreset() {
  if (state.presets.length) return;
  addPreset({
    name: state.locale === 'vi' ? 'Chữ ký vàng góc phải' : 'Golden corner signature',
    tool: layerTypes.TEXT,
    payload: {
      content: 'Dr. Huỳnh – Implant',
      fontFamily: "'Great Vibes', cursive",
      fontSize: 72,
      color: '#F59E0B',
      opacity: 0.92,
      strokeWidth: 2,
      strokeColor: '#1E1B4B',
      shadow: {
        enabled: true,
        blur: 14,
        offsetX: 0,
        offsetY: 8,
        color: 'rgba(15, 23, 42, 0.45)',
      },
      align: 'right',
      position: { x: 0.85, y: 0.86 },
    },
  });
}

export function importState(data) {
  if (!data) return;
  state.images = data.images || [];
  state.activeImageId = data.activeImageId || null;
  state.activeLayerId = data.activeLayerId || null;
  state.activeTool = data.activeTool || 'text';
  state.presets = data.presets || state.presets;
  events.dispatchEvent(new CustomEvent('stateimport', { detail: { state } }));
}
