import { getActiveImage, state, layerTypes } from './state.js';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export class CanvasRenderer {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlayCanvas = overlay;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.overlayCtx = overlay.getContext('2d', { alpha: true });
    this.dpr = window.devicePixelRatio || 1;
    this.view = {
      scale: 1,
      offset: { x: 0, y: 0 },
    };
    this.bounds = { width: canvas.clientWidth, height: canvas.clientHeight };
    this.selection = null;
    this.hoverLayerId = null;
  }

  resize(width, height) {
    this.bounds = { width, height };
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;
    this.overlayCanvas.width = width * this.dpr;
    this.overlayCanvas.height = height * this.dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.overlayCanvas.style.width = `${width}px`;
    this.overlayCanvas.style.height = `${height}px`;
    this.render();
  }

  setView({ scale, offset }) {
    if (typeof scale === 'number') {
      this.view.scale = clamp(scale, 0.1, 8);
    }
    if (offset) {
      this.view.offset = { x: offset.x, y: offset.y };
    }
    this.render();
  }

  setSelection(selection) {
    this.selection = selection;
    this.renderOverlay();
  }

  setHoverLayer(layerId) {
    this.hoverLayerId = layerId;
    this.renderOverlay();
  }

  getTransform() {
    return {
      scale: this.view.scale * this.dpr,
      offsetX: this.view.offset.x * this.dpr,
      offsetY: this.view.offset.y * this.dpr,
    };
  }

  screenToImage(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { offsetX, offsetY, scale } = this.getTransform();
    const canvasX = (clientX - rect.left) * this.dpr;
    const canvasY = (clientY - rect.top) * this.dpr;
    const imageX = (canvasX - offsetX) / scale;
    const imageY = (canvasY - offsetY) / scale;
    return { x: imageX, y: imageY };
  }

  imageToScreen(x, y) {
    const { offsetX, offsetY, scale } = this.getTransform();
    const screenX = x * scale + offsetX;
    const screenY = y * scale + offsetY;
    return {
      x: screenX / this.dpr,
      y: screenY / this.dpr,
    };
  }

  fitToBounds(imageWidth, imageHeight) {
    const padding = 48;
    const availableWidth = this.bounds.width - padding * 2;
    const availableHeight = this.bounds.height - padding * 2;
    const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
    const offsetX = (this.bounds.width - imageWidth * scale) / 2;
    const offsetY = (this.bounds.height - imageHeight * scale) / 2;
    this.setView({ scale, offset: { x: offsetX, y: offsetY } });
  }

  render() {
    const ctx = this.ctx;
    const image = getActiveImage();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!image) {
      ctx.restore();
      this.renderOverlay();
      return;
    }

    const transform = this.getTransform();
    ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(-transform.offsetX, -transform.offsetY, this.canvas.width, this.canvas.height);

    if (image.bitmap) {
      ctx.drawImage(image.bitmap, 0, 0, image.width, image.height);
    } else if (image.baseCanvas) {
      ctx.drawImage(image.baseCanvas, 0, 0);
    }

    ctx.save();
    image.layers.forEach(layer => {
      if (!layer.visible) return;
      this.drawLayer(ctx, image, layer);
    });
    ctx.restore();
    ctx.restore();
    this.renderOverlay();
  }

  drawLayer(ctx, image, layer) {
    switch (layer.type) {
      case layerTypes.TEXT:
        this.drawTextLayer(ctx, image, layer);
        break;
      case layerTypes.PEN:
        this.drawPenLayer(ctx, image, layer);
        break;
      case layerTypes.LOGO:
        this.drawLogoLayer(ctx, image, layer);
        break;
      case layerTypes.WATERMARK:
        this.drawWatermarkLayer(ctx, image, layer);
        break;
      case layerTypes.QR:
        this.drawQrLayer(ctx, image, layer);
        break;
      case layerTypes.BLUR:
        this.drawBlurLayer(ctx, image, layer);
        break;
      default:
        break;
    }
  }

  drawTextLayer(ctx, image, layer) {
    const {
      content = '',
      fontFamily = 'Inter',
      fontSize = 56,
      fontWeight = 600,
      italic = false,
      uppercase = false,
      color = '#0F172A',
      opacity = 1,
      strokeWidth = 0,
      strokeColor = '#ffffff',
      shadow = {},
      align = 'center',
      position = { x: 0.5, y: 0.5 },
      lineHeight = 1.24,
      letterSpacing = 0,
      maxWidthRatio = null,
    } = layer;

    const normalized = uppercase ? content.toUpperCase() : content;
    const lines = normalized.split(/\r?\n/);
    const x = position.x * image.width;
    const y = position.y * image.height;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = `${italic ? 'italic ' : ''}${fontWeight || 600} ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';

    if (shadow?.enabled) {
      ctx.shadowColor = shadow.color || 'rgba(15, 23, 42, 0.45)';
      ctx.shadowBlur = shadow.blur ?? 12;
      ctx.shadowOffsetX = shadow.offsetX ?? 0;
      ctx.shadowOffsetY = shadow.offsetY ?? 8;
    } else {
      ctx.shadowColor = 'transparent';
    }

    const maxWidth = maxWidthRatio ? image.width * maxWidthRatio : undefined;
    const startY = y - ((lines.length - 1) * fontSize * lineHeight) / 2;

    lines.forEach((line, index) => {
      const lineY = startY + index * fontSize * lineHeight;
      if (letterSpacing) {
        this.drawWithLetterSpacing(ctx, line, x, lineY, letterSpacing, align);
      } else {
        if (strokeWidth > 0) {
          ctx.lineWidth = strokeWidth;
          ctx.strokeStyle = strokeColor;
          ctx.strokeText(line, x, lineY, maxWidth);
        }
        ctx.fillText(line, x, lineY, maxWidth);
      }
    });
    ctx.restore();
  }

  drawWithLetterSpacing(ctx, text, x, y, letterSpacing, align) {
    const characters = [...text];
    const totalWidth = ctx.measureText(text).width + letterSpacing * (characters.length - 1);
    let cursor = x;
    if (align === 'center') {
      cursor = x - totalWidth / 2;
    } else if (align === 'right') {
      cursor = x - totalWidth;
    }
    characters.forEach(char => {
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width + letterSpacing;
    });
  }

  drawPenLayer(ctx, image, layer) {
    const { strokes = [], opacity = 1 } = layer;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    strokes.forEach(stroke => {
      const { points = [], color = '#0F172A', size = 4 } = stroke;
      if (points.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.beginPath();
      points.forEach((point, index) => {
        const px = point.x * image.width;
        const py = point.y * image.height;
        if (index === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  drawLogoLayer(ctx, image, layer) {
    const {
      asset,
      position = { x: 0.5, y: 0.5 },
      scale = 1,
      rotation = 0,
      opacity = 1,
      width = 200,
      height = 200,
    } = layer;
    if (!asset) return;
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const x = position.x * image.width;
    const y = position.y * image.height;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(asset, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
  }

  drawWatermarkLayer(ctx, image, layer) {
    const {
      text = 'Sample Watermark',
      fontFamily = 'Inter',
      fontSize = 36,
      opacity = 0.25,
      angle = -45,
      spacingX = 240,
      spacingY = 160,
      color = 'rgba(15,23,42,0.35)',
    } = layer;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(image.width / 2, image.height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cols = Math.ceil(image.width / spacingX) + 4;
    const rows = Math.ceil(image.height / spacingY) + 4;
    for (let row = -rows; row <= rows; row += 1) {
      for (let col = -cols; col <= cols; col += 1) {
        ctx.fillText(text, col * spacingX, row * spacingY);
      }
    }
    ctx.restore();
  }

  drawQrLayer(ctx, image, layer) {
    const {
      dataUrl,
      size = 200,
      position = { x: 0.5, y: 0.5 },
      opacity = 1,
      margin = 12,
    } = layer;
    if (!dataUrl) return;
    const img = layer._qrImage;
    if (!img) {
      const imageElement = new Image();
      imageElement.onload = () => {
        layer._qrImage = imageElement;
        this.render();
      };
      imageElement.src = dataUrl;
      return;
    }
    const scaledSize = size;
    const x = position.x * image.width;
    const y = position.y * image.height;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x - scaledSize / 2 - margin, y - scaledSize / 2 - margin, scaledSize + margin * 2, scaledSize + margin * 2);
    ctx.drawImage(img, x - scaledSize / 2, y - scaledSize / 2, scaledSize, scaledSize);
    ctx.restore();
  }

  drawBlurLayer(ctx, image, layer) {
    const {
      mode = 'blur',
      intensity = 6,
      rect = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
    } = layer;
    const x = rect.x * image.width;
    const y = rect.y * image.height;
    const width = rect.width * image.width;
    const height = rect.height * image.height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(this.canvas, x * this.view.scale + this.view.offset.x, y * this.view.scale + this.view.offset.y, width * this.view.scale, height * this.view.scale, 0, 0, width, height);
    if (mode === 'blur') {
      ctx.save();
      ctx.filter = `blur(${intensity}px)`;
      ctx.drawImage(tempCanvas, x, y, width, height);
      ctx.restore();
    } else {
      const pixelSize = Math.max(2, intensity);
      const smallCanvas = document.createElement('canvas');
      const smallCtx = smallCanvas.getContext('2d');
      const scaledW = Math.max(1, Math.round(width / pixelSize));
      const scaledH = Math.max(1, Math.round(height / pixelSize));
      smallCanvas.width = scaledW;
      smallCanvas.height = scaledH;
      smallCtx.drawImage(tempCanvas, 0, 0, scaledW, scaledH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(smallCanvas, x, y, width, height);
      ctx.imageSmoothingEnabled = true;
    }
  }

  renderOverlay() {
    const ctx = this.overlayCtx;
    const image = getActiveImage();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!image) {
      ctx.restore();
      return;
    }

    const transform = this.getTransform();
    ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);

    if (image.grid) {
      this.drawGrid(ctx, image);
    }

    if (this.selection) {
      const { x, y, width, height } = this.selection;
      ctx.save();
      ctx.strokeStyle = '#2563EB';
      ctx.lineWidth = 2 / this.view.scale;
      ctx.setLineDash([8 / this.view.scale, 8 / this.view.scale]);
      ctx.strokeRect(x * image.width, y * image.height, width * image.width, height * image.height);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
      ctx.fillRect(x * image.width, y * image.height, width * image.width, height * image.height);
      ctx.restore();
    }

    if (this.hoverLayerId) {
      const layer = image.layers.find(item => item.id === this.hoverLayerId);
      if (layer?.bounds) {
        const { x, y, width, height } = layer.bounds;
        ctx.save();
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.65)';
        ctx.lineWidth = 1.5 / this.view.scale;
        ctx.setLineDash([6 / this.view.scale, 6 / this.view.scale]);
        ctx.strokeRect(x * image.width, y * image.height, width * image.width, height * image.height);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  drawGrid(ctx, image) {
    const step = image.gridSize || 64;
    const width = image.width;
    const height = image.height;
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1 / this.view.scale;
    for (let x = 0; x <= width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}
