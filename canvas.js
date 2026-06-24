// Burn one or more serial number strings onto an image using Canvas

export function burnStringsOntoImage(imageDataUrl, serialNumbers, options = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const {
        fontSize = Math.max(24, Math.floor(img.width * 0.04)),
        fontFamily = 'monospace',
        color = '#FFFFFF',
        strokeColor = '#000000',
        position = 'bottom-left',
        padding = 20,
        lineSpacing = 8,
      } = options;

      ctx.font = `bold ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(2, fontSize * 0.08);
      ctx.textBaseline = 'bottom';

      const lineHeight = fontSize + lineSpacing;
      const totalHeight = serialNumbers.length * lineHeight;

      serialNumbers.forEach((text, i) => {
        let x, y;
        if (position === 'bottom-left') {
          x = padding;
          y = img.height - padding - (serialNumbers.length - 1 - i) * lineHeight;
        } else if (position === 'top-left') {
          x = padding;
          y = padding + fontSize + i * lineHeight;
          ctx.textBaseline = 'top';
        } else if (position === 'bottom-right') {
          const w = ctx.measureText(text).width;
          x = img.width - padding - w;
          y = img.height - padding - (serialNumbers.length - 1 - i) * lineHeight;
        } else if (position === 'center') {
          const w = ctx.measureText(text).width;
          x = (img.width - w) / 2;
          y = img.height / 2 + i * lineHeight;
        }
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      });

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.src = imageDataUrl;
  });
}
