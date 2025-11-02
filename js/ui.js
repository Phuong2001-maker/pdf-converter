import { state, events, layerTypes } from './state.js';

const dom = {
  toolTabs: document.getElementById('toolTabs'),
  layerList: document.getElementById('layerList'),
  layerEmptyHint: document.getElementById('layerEmptyHint'),
  presetList: document.getElementById('presetList'),
  presetEmpty: document.getElementById('presetEmpty'),
  presetBlock: document.getElementById('presetBlock'),
  toolPanelContent: document.getElementById('toolPanelContent'),
  toolPanelTitle: document.getElementById('toolPanelTitle'),
  toolPanelDescription: document.getElementById('toolPanelDescription'),
  toastStack: document.getElementById('toastStack'),
  toastTemplate: document.getElementById('toast-template'),
  layerTemplate: document.getElementById('layer-item-template'),
  tooltipTemplate: document.getElementById('tooltip-template'),
  confirmDialog: document.getElementById('confirmDialog'),
  qrDialog: document.getElementById('qrPreviewDialog'),
  offlineBanner: document.getElementById('offlineBanner'),
  panel: document.getElementById('propertiesPanel'),
  panelBackdrop: document.getElementById('panelBackdrop'),
  subtitle: document.getElementById('panelSubtitle'),
  statusDimensions: document.getElementById('statusDimensions'),
  statusScale: document.getElementById('statusScale'),
  statusMemory: document.getElementById('statusMemory'),
  activeFileName: document.getElementById('activeFileName'),
  activeZoom: document.getElementById('activeZoom'),
  workspaceTips: document.getElementById('workspaceTips'),
  layerUpButton: document.querySelector('[data-action="layer-up"]'),
  layerDownButton: document.querySelector('[data-action="layer-down"]'),
  duplicateLayerButton: document.querySelector('[data-action="duplicate-layer"]'),
  deleteLayerButton: document.querySelector('[data-action="delete-layer"]'),
};

const localeStrings = {
  vi: {
    tools: {
      text: 'Chữ',
      pen: 'Ký tay',
      logo: 'Logo/Sticker',
      watermark: 'Watermark',
      qr: 'QR chữ ký',
      blur: 'Blur/Pixelate',
      export: 'Xuất ảnh',
    },
    toolDescriptions: {
      text: 'Nhập nội dung chữ ký, font chữ, hiệu ứng.',
      pen: 'Vẽ chữ ký tay, undo/redo và chuyển thành sticker.',
      logo: 'Chèn logo PNG/SVG, chỉnh kích thước & vị trí.',
      watermark: 'Tạo watermark lặp theo góc và khoảng cách.',
      qr: 'Sinh QR chứa nội dung chữ ký và đặt vào ảnh.',
      blur: 'Chọn vùng để làm mờ hoặc pixelate.',
      export: 'Chọn định dạng, chất lượng, scale và tải xuống.',
    },
    emptyLayers: 'Chưa có layer nào. Thêm layer để bắt đầu.',
    emptyPresets: 'Chưa có preset nào. Lưu cấu hình hiện tại để dùng lại.',
    toast: {
      presetSaved: 'Preset đã lưu',
      presetDeleted: 'Preset đã xoá',
      exportReady: 'Ảnh đã sẵn sàng tải',
      offline: 'Bạn đang làm việc offline',
    },
    confirmDeleteLayer: 'Xoá layer này? Thao tác không thể hoàn tác.',
  },
  en: {
    tools: {
      text: 'Text',
      pen: 'Pen',
      logo: 'Logo/Sticker',
      watermark: 'Watermark',
      qr: 'Signature QR',
      blur: 'Blur/Pixelate',
      export: 'Export',
    },
    toolDescriptions: {
      text: 'Compose signature text with fonts and effects.',
      pen: 'Freehand draw signature, undo/redo or convert to sticker.',
      logo: 'Drop PNG/SVG logos, adjust size & placement.',
      watermark: 'Generate repeated watermark across the canvas.',
      qr: 'Create QR code with signature details and place on image.',
      blur: 'Blur or pixelate selected regions.',
      export: 'Select formats, quality, scale and download.',
    },
    emptyLayers: 'No layers yet – add a layer to start.',
    emptyPresets: 'No presets saved. Store your configuration to reuse.',
    toast: {
      presetSaved: 'Preset saved',
      presetDeleted: 'Preset removed',
      exportReady: 'Export ready',
      offline: 'You are working offline',
    },
    confirmDeleteLayer: 'Delete this layer? This cannot be undone.',
  },
};

export const getString = (key, namespace = null) => {
  const locale = state.locale in localeStrings ? state.locale : 'vi';
  if (!namespace) {
    return localeStrings[locale][key] ?? localeStrings.vi[key] ?? key;
  }
  return localeStrings[locale][namespace]?.[key] ?? localeStrings.vi[namespace]?.[key] ?? key;
};

export function renderToolTabs(toolDefinitions) {
  const fragment = document.createDocumentFragment();
  toolDefinitions.forEach(tool => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool-tab';
    button.dataset.tool = tool.id;
    button.role = 'tab';
    button.id = `tool-tab-${tool.id}`;
    button.innerHTML = `
      <svg class="icon" aria-hidden="true"><use href="#${tool.icon}"></use></svg>
      <span class="tool-label">${getString(tool.id, 'tools')}</span>
    `;
    if (state.activeTool === tool.id) {
      button.classList.add('is-active');
      button.setAttribute('aria-selected', 'true');
    } else {
      button.setAttribute('aria-selected', 'false');
    }
    button.addEventListener('click', () => {
      events.dispatchEvent(new CustomEvent('ui:toolselected', { detail: { toolId: tool.id } }));
    });
    fragment.appendChild(button);
  });
  dom.toolTabs.innerHTML = '';
  dom.toolTabs.appendChild(fragment);
}

export function updateToolSelection(activeTool) {
  dom.toolTabs.querySelectorAll('.tool-tab').forEach(tab => {
    const isActive = tab.dataset.tool === activeTool;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  dom.toolPanelTitle.textContent = getString(activeTool, 'tools');
  dom.toolPanelDescription.textContent = getString(activeTool, 'toolDescriptions');
}

export function renderLayerList(image) {
  dom.layerList.innerHTML = '';
  if (!image || !image.layers.length) {
    dom.layerEmptyHint.hidden = false;
    dom.layerList.setAttribute('aria-hidden', 'true');
    return;
  }
  dom.layerList.removeAttribute('aria-hidden');
  dom.layerEmptyHint.hidden = true;
  const template = dom.layerTemplate;
  image.layers.slice().reverse().forEach((layer, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const label = layer.name || buildLayerName(layer, image.layers.length - index);
    node.dataset.layerId = layer.id;
    node.querySelector('.layer-name').textContent = label;
    node.querySelector('.layer-desc').textContent = describeLayer(layer);
    node.setAttribute('aria-selected', String(layer.id === state.activeLayerId));
    const toggleButton = node.querySelector('.layer-visibility');
    toggleButton.setAttribute('aria-pressed', String(!layer.visible === false));
    toggleButton.innerHTML = `<svg class="icon"><use href="#${layer.visible === false ? 'icon-eye-off' : 'icon-eye'}"></use></svg>`;
    toggleButton.addEventListener('click', event => {
      event.stopPropagation();
      events.dispatchEvent(new CustomEvent('ui:layertoggle', { detail: { layerId: layer.id } }));
    });
    node.addEventListener('click', () => {
      events.dispatchEvent(new CustomEvent('ui:layerselected', { detail: { layerId: layer.id } }));
    });
    dom.layerList.appendChild(node);
  });
}

function buildLayerName(layer, fallbackIndex) {
  switch (layer.type) {
    case layerTypes.TEXT:
      return layer.name || `Text ${fallbackIndex}`;
    case layerTypes.PEN:
      return layer.name || `Pen ${fallbackIndex}`;
    case layerTypes.LOGO:
      return layer.name || `Logo ${fallbackIndex}`;
    case layerTypes.WATERMARK:
      return layer.name || `Watermark`;
    case layerTypes.QR:
      return layer.name || `QR`;
    case layerTypes.BLUR:
      return layer.name || `Blur ${fallbackIndex}`;
    default:
      return `Layer ${fallbackIndex}`;
  }
}

function describeLayer(layer) {
  switch (layer.type) {
    case layerTypes.TEXT:
      return (layer.content || '').slice(0, 32) || 'Text';
    case layerTypes.PEN:
      return `${layer.strokes?.length || 0} strokes`;
    case layerTypes.LOGO:
      return layer.assetName || 'Graphic layer';
    case layerTypes.WATERMARK:
      return 'Repeated watermark';
    case layerTypes.QR:
      return 'QR signature';
    case layerTypes.BLUR:
      return layer.mode === 'pixelate' ? 'Pixelated region' : 'Blurred region';
    default:
      return '';
  }
}

export function markActiveLayer(layerId) {
  dom.layerList.querySelectorAll('.layer-item').forEach(item => {
    const isActive = item.dataset.layerId === layerId;
    item.setAttribute('aria-selected', String(isActive));
  });
  dom.duplicateLayerButton.disabled = !layerId;
  dom.deleteLayerButton.disabled = !layerId;
}

export function renderPresetList(presets) {
  dom.presetList.innerHTML = '';
  if (!presets.length) {
    dom.presetEmpty.hidden = false;
    return;
  }
  dom.presetEmpty.hidden = true;
  presets.forEach(preset => {
    const item = document.createElement('li');
    item.className = 'preset-item';
    item.innerHTML = `
      <div>
        <strong>${preset.name}</strong>
        <p class="preset-meta">${preset.tool ? getString(preset.tool, 'tools') : ''}</p>
      </div>
      <div class="preset-actions">
        <button type="button" class="chip small" data-action="apply" data-id="${preset.id}">${state.locale === 'vi' ? 'Áp dụng' : 'Apply'}</button>
        <button type="button" class="icon-btn" data-action="rename" data-id="${preset.id}" aria-label="Rename">
          <svg class="icon"><use href="#icon-edit"></use></svg>
        </button>
        <button type="button" class="icon-btn" data-action="delete" data-id="${preset.id}" aria-label="Delete">
          <svg class="icon"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    `;
    dom.presetList.appendChild(item);
  });
}

export function togglePresetPanel(visible) {
  dom.presetBlock.hidden = !visible;
}

export function showToast({ title, message, tone = 'neutral', timeout = 4000 }) {
  const template = dom.toastTemplate;
  if (!template) return;
  const toast = template.content.firstElementChild.cloneNode(true);
  toast.dataset.tone = tone;
  toast.querySelector('.toast-title').textContent = title;
  toast.querySelector('.toast-message').textContent = message || '';
  const closeButton = toast.querySelector('.toast-close');
  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('is-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    toast.remove();
  };
  closeButton.addEventListener('click', remove);
  dom.toastStack.appendChild(toast);
  if (timeout > 0) {
    setTimeout(remove, timeout);
  }
}

export function showConfirm({ message, confirmLabel, cancelLabel }) {
  return new Promise(resolve => {
    const dialog = dom.confirmDialog;
    if (!dialog) {
      // fallback
      const confirmed = window.confirm(message);
      resolve(confirmed);
      return;
    }
    const messageNode = dialog.querySelector('#confirmMessage');
    const confirmButton = dialog.querySelector('button[value="confirm"]');
    const cancelButton = dialog.querySelector('button[value="cancel"]');
    if (messageNode) {
      messageNode.textContent = message;
    }
    if (confirmLabel) confirmButton.textContent = confirmLabel;
    if (cancelLabel) cancelButton.textContent = cancelLabel;
    const handleClose = event => {
      dialog.removeEventListener('close', handleClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', handleClose, { once: true });
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  });
}

export function showQrPreview() {
  const dialog = dom.qrDialog;
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

export function hideQrPreview() {
  const dialog = dom.qrDialog;
  if (!dialog) return;
  dialog.close();
}

export function attachPanelToggle() {
  const collapseButton = document.querySelector('[data-action="collapse-panel"]');
  if (!collapseButton) return;
  collapseButton.addEventListener('click', () => {
    dom.panel.classList.toggle('is-expanded');
  });
}

export function setPanelExpanded(expanded) {
  dom.panel.classList.toggle('is-expanded', expanded);
}

export function updateStatusBar({ dimensions, zoom, memory }) {
  if (dimensions && dom.statusDimensions) {
    dom.statusDimensions.textContent = dimensions;
  }
  if (typeof zoom === 'string') {
    if (dom.statusScale) {
      dom.statusScale.textContent = zoom;
    }
    if (dom.activeZoom) {
      dom.activeZoom.textContent = zoom.replace('Zoom:', '').trim();
    }
  }
  if (memory && dom.statusMemory) {
    dom.statusMemory.textContent = memory;
  }
}

export function updateActiveFileName(name) {
  if (!dom.activeFileName) return;
  dom.activeFileName.textContent = name || (state.locale === 'vi' ? 'Chưa có ảnh' : 'No image');
}

export function toggleTips(visible) {
  if (!dom.workspaceTips) return;
  dom.workspaceTips.hidden = !visible;
}

export function toggleOfflineBanner(visible) {
  dom.offlineBanner.hidden = !visible;
}

export function registerOfflineBanner(handler) {
  dom.offlineBanner.querySelector('[data-action="dismiss-offline"]')?.addEventListener('click', handler);
}

export function bindPresetActions(callbacks) {
  dom.presetList.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const id = target.dataset.id;
    const action = target.dataset.action;
    callbacks?.[action]?.(id);
  });
}

export function bindLayerReorder(callback) {
  let dragSrc;
  dom.layerList.addEventListener('dragstart', event => {
    const item = event.target.closest('.layer-item');
    if (!item) return;
    dragSrc = item;
    event.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  dom.layerList.addEventListener('dragend', () => {
    dragSrc?.classList.remove('dragging');
    dragSrc = null;
  });
  dom.layerList.addEventListener('dragover', event => {
    event.preventDefault();
    const target = event.target.closest('.layer-item');
    if (!target || target === dragSrc) return;
    const rect = target.getBoundingClientRect();
    const shouldInsertBefore = event.clientY < rect.top + rect.height / 2;
    dom.layerList.insertBefore(dragSrc, shouldInsertBefore ? target : target.nextSibling);
  });
  dom.layerList.addEventListener('drop', () => {
    if (!dragSrc) return;
    const ids = Array.from(dom.layerList.children).map(el => el.dataset.layerId).reverse();
    callback?.(ids);
  });
}

export function initUI() {
  attachPanelToggle();
}

// Listen for locale/theme events to re-render static strings
events.addEventListener('localechange', () => {
  const toolTabs = Array.from(dom.toolTabs.querySelectorAll('.tool-tab'));
  toolTabs.forEach(tab => {
    const label = tab.querySelector('.tool-label');
    if (label) {
      label.textContent = getString(tab.dataset.tool, 'tools');
    }
  });
  dom.layerEmptyHint.textContent = getString('emptyLayers');
  dom.presetEmpty.textContent = getString('emptyPresets');
});
