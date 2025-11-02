# Ký Ảnh — Ứng dụng ký chữ ký lên ảnh (client-side)

Ứng dụng web thuần HTML/CSS/JS giúp ký chữ, ký tay, chèn logo, watermark, QR code, làm mờ/pixelate vùng chọn và xuất ảnh hoàn toàn trên trình duyệt. Không cần backend.

## Tính năng chính
- Onboarding drag & drop, hỗ trợ nhiều ảnh, cảnh báo ảnh lớn >20MP
- Công cụ chữ với font Inter/Roboto/Great Vibes/Pacifico, shadow, stroke, preset vị trí, snap
- Công cụ ký tay (pen) với smoothing, undo/clear, chuyển thành layer mới
- Chèn logo/sticker PNG/SVG, chỉnh scale/opacity/rotation nhanh
- Watermark lặp với góc ±45°, spacing X/Y, opacity, áp dụng nhanh
- QR chữ ký: nhập nội dung → sinh QR, preview
- Blur/Pixelate vùng chọn với intensity linh hoạt
- Xuất PNG/JPEG/WebP, scale 25–200%
- Preset template lưu vào localStorage (ví dụ “Signature vàng góc phải”)
- PWA offline (manifest + service worker) và nút “Cài Offline”
- UI responsive (mobile bottom nav, panel dạng bottom sheet), theme light/dark, locale VI/EN

## Cấu trúc
```
.
├── ky-ten-anh.html
├── css/style.css
├── js/
│   ├── app.js
│   ├── state.js
│   ├── render.js
│   └── ui.js
├── vendor/qrcode.min.js
├── libs/jszip/jszip.min.js
├── libs/filesaver/FileSaver.min.js
├── manifest.json
└── sw.js
```

## Cách chạy
- Mở trực tiếp `ky-ten-anh.html` trong trình duyệt (Chrome/Edge khuyến nghị)
- Hoặc dùng máy chủ tĩnh: `npx http-server` rồi truy cập `http://localhost:8080/ky-ten-anh.html`

PWA: sau khi mở trên HTTPS hoặc localhost, dùng menu trình duyệt (ví dụ Chrome: `⋮` → Install) để cài ứng dụng offline.
\n## Thư viện đi kèm\n- [qrcodejs](https://github.com/davidshimjs/qrcodejs) (MIT) để sinh QR code\n- [JSZip](https://stuk.github.io/jszip/) & [FileSaver](https://github.com/eligrey/FileSaver.js)
