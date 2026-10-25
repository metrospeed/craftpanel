// Server icon upload: any image becomes the 64×64 server-icon.png Minecraft
// shows in the server list. Images that aren't already 64×64 open a cropper.
import { api } from './api.js';
import { html, mount, modal, icon, $, toast, toastError } from './ui.js';

const SIZE = 64;
const VIEW_W = 470;
const VIEW_H = 340;
const HANDLE = 14;

export const iconUrl = (serverId) => `/api/servers/${serverId}/files/download?path=server-icon.png&t=${Date.now()}`;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      // SVGs without a size report 0×0; give them one to crop from.
      if (!img.naturalWidth) img.width = img.height = 512;
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image the browser can read'));
    };
    img.src = url;
  });
}

const dims = (img) => [img.naturalWidth || img.width, img.naturalHeight || img.height];

/** Draw the chosen square of `img` (or the whole image, letterboxed) onto a 64×64 canvas. */
function render(img, crop, fit) {
  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (fit) {
    const [w, h] = dims(img);
    const s = SIZE / Math.max(w, h);
    ctx.drawImage(img, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
  } else {
    ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, SIZE, SIZE);
  }
  return out;
}

/** Show the cropper; resolves with a 64×64 canvas, or null if cancelled. */
function cropDialog(img) {
  const [w, h] = dims(img);
  const scale = Math.min(VIEW_W / w, VIEW_H / h);
  const crop = { size: Math.min(w, h) };
  crop.x = (w - crop.size) / 2;
  crop.y = (h - crop.size) / 2;
  let fit = false;
  let result = null;

  return new Promise((resolve) => {
    modal({
      title: 'Crop server icon',
      body: (body) => {
        body.innerHTML = String(html`
          <div class="stack">
            <p class="muted small" style="margin:0">
              Minecraft server icons are 64×64. Drag the square to choose what to keep, drag a corner (or scroll) to resize.
            </p>
            <div class="crop-view"><canvas width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"></canvas></div>
            <label class="check small"><input type="checkbox" data-fit /><div><b>Fit whole image</b><small>Shrink it to fit instead of cropping (adds transparent edges).</small></div></label>
            <div class="row" style="align-items:flex-end">
              <canvas class="crop-preview big" width="${SIZE}" height="${SIZE}" title="Zoomed in"></canvas>
              <canvas class="crop-preview" width="${SIZE}" height="${SIZE}" title="Actual size"></canvas>
              <span class="faint small">Result (zoomed and actual size)</span>
            </div>
          </div>`);
        const view = $('.crop-view canvas', body);
        const ctx = view.getContext('2d');
        const previews = [...body.querySelectorAll('.crop-preview')];

        function draw() {
          ctx.clearRect(0, 0, view.width, view.height);
          ctx.drawImage(img, 0, 0, view.width, view.height);
          if (!fit) {
            const [x, y, s] = [crop.x * scale, crop.y * scale, crop.size * scale];
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.beginPath();
            ctx.rect(0, 0, view.width, view.height);
            ctx.rect(x, y, s, s);
            ctx.fill('evenodd');
            ctx.strokeStyle = '#3ddc84';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, s, s);
            ctx.fillStyle = '#3ddc84';
            for (const [cx, cy] of [[x, y], [x + s, y], [x, y + s], [x + s, y + s]]) {
              ctx.fillRect(cx - HANDLE / 4, cy - HANDLE / 4, HANDLE / 2, HANDLE / 2);
            }
          }
          const out = render(img, crop, fit);
          for (const p of previews) {
            const pc = p.getContext('2d');
            pc.clearRect(0, 0, SIZE, SIZE);
            pc.drawImage(out, 0, 0);
          }
        }

        const clamp = () => {
          crop.size = Math.max(4, Math.min(crop.size, w, h));
          crop.x = Math.max(0, Math.min(crop.x, w - crop.size));
          crop.y = Math.max(0, Math.min(crop.y, h - crop.size));
        };

        const point = (e) => {
          const r = view.getBoundingClientRect();
          return [((e.clientX - r.left) * (view.width / r.width)) / scale, ((e.clientY - r.top) * (view.height / r.height)) / scale];
        };

        let drag = null;
        view.onpointerdown = (e) => {
          if (fit) return;
          const [px, py] = point(e);
          const near = HANDLE / scale;
          const corners = [
            [crop.x, crop.y, 1, 1],
            [crop.x + crop.size, crop.y, -1, 1],
            [crop.x, crop.y + crop.size, 1, -1],
            [crop.x + crop.size, crop.y + crop.size, -1, -1],
          ];
          const corner = corners.find(([cx, cy]) => Math.abs(px - cx) < near && Math.abs(py - cy) < near);
          if (corner) {
            // Resize from the opposite corner, which stays put.
            const [cx, cy, ox, oy] = corner;
            drag = { mode: 'resize', ax: cx + ox * crop.size, ay: cy + oy * crop.size, sx: -ox, sy: -oy };
          } else if (px >= crop.x && px <= crop.x + crop.size && py >= crop.y && py <= crop.y + crop.size) {
            drag = { mode: 'move', dx: px - crop.x, dy: py - crop.y };
          } else return;
          view.setPointerCapture(e.pointerId);
        };
        view.onpointermove = (e) => {
          const [px, py] = point(e);
          if (!drag) {
            view.style.cursor = fit ? 'default' : 'move';
            return;
          }
          if (drag.mode === 'move') {
            crop.x = px - drag.dx;
            crop.y = py - drag.dy;
          } else {
            const { ax, ay, sx, sy } = drag;
            const room = Math.min(sx > 0 ? w - ax : ax, sy > 0 ? h - ay : ay);
            const size = Math.max(4, Math.min(room, Math.max((px - ax) * sx, (py - ay) * sy)));
            crop.size = size;
            crop.x = sx > 0 ? ax : ax - size;
            crop.y = sy > 0 ? ay : ay - size;
          }
          clamp();
          draw();
        };
        view.onpointerup = () => (drag = null);
        view.onwheel = (e) => {
          if (fit) return;
          e.preventDefault();
          const cx = crop.x + crop.size / 2;
          const cy = crop.y + crop.size / 2;
          crop.size *= e.deltaY > 0 ? 1.08 : 1 / 1.08;
          crop.size = Math.max(4, Math.min(crop.size, w, h));
          crop.x = cx - crop.size / 2;
          crop.y = cy - crop.size / 2;
          clamp();
          draw();
        };
        $('[data-fit]', body).onchange = (e) => {
          fit = e.target.checked;
          draw();
        };
        draw();
      },
      actions: [
        { label: 'Cancel' },
        { label: 'Use this icon', cls: 'primary', onClick: () => (result = render(img, crop, fit)) },
      ],
      onClose: () => {
        URL.revokeObjectURL(img.src);
        resolve(result);
      },
    });
  });
}

/**
 * Ask for an image and save it as the server's server-icon.png.
 * Resolves true once an icon was uploaded, false if the user backed out.
 */
export function chooseServerIcon(serverId) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(false);
      try {
        const img = await loadImage(file);
        const [w, h] = dims(img);
        let canvas;
        if (w === SIZE && h === SIZE) {
          canvas = render(img, { x: 0, y: 0, size: SIZE }, false);
          URL.revokeObjectURL(img.src);
        } else {
          canvas = await cropDialog(img);
        }
        if (!canvas) return resolve(false);
        const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
        await api.upload(`/api/servers/${serverId}/files/upload?path=`, [new File([blob], 'server-icon.png', { type: 'image/png' })]);
        toast('Server icon saved. Restart the server to show it.');
        resolve(true);
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

export async function removeServerIcon(serverId) {
  await api.post(`/api/servers/${serverId}/files/delete`, { paths: ['server-icon.png'] });
  toast('Server icon removed. Restart the server to apply.');
}

/**
 * Mount the "Server icon" control (current icon, Upload image, Remove) in `el`.
 * `onChange(url)` gets the new icon URL after an upload or removal.
 */
export function mountIconField(el, serverId, { fallback, note = '', onChange } = {}) {
  mount(
    el,
    html`<div class="row wrap icon-field">
      <img class="server-icon-img" alt="Server icon" />
      <div class="stack tight">
        <div class="btn-group">
          <button type="button" class="btn sm" data-icon-upload>${icon('upload')}Upload image</button>
          <button type="button" class="btn sm ghost hidden" data-icon-remove>${icon('trash')}Remove</button>
        </div>
        <span class="hint">Any image works: it is converted to the 64×64 PNG Minecraft needs, with a cropper if it isn't that size already.${note ? ' ' + note : ''}</span>
      </div>
    </div>`,
  );
  const img = $('.server-icon-img', el);
  const removeBtn = $('[data-icon-remove]', el);
  const show = () => {
    img.src = iconUrl(serverId);
  };
  img.onload = () => removeBtn.classList.toggle('hidden', img.src.endsWith(fallback));
  img.onerror = () => {
    removeBtn.classList.add('hidden');
    if (!img.src.endsWith(fallback)) img.src = fallback;
  };
  $('[data-icon-upload]', el).onclick = async () => {
    try {
      if (await chooseServerIcon(serverId)) {
        show();
        onChange?.(img.src);
      }
    } catch (err) {
      toastError(err);
    }
  };
  removeBtn.onclick = async () => {
    try {
      await removeServerIcon(serverId);
      img.src = fallback;
      onChange?.(fallback);
    } catch (err) {
      toastError(err);
    }
  };
  show();
}
