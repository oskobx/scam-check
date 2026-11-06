// Keeps the latest frame from the caller's FaceTime camera and turns it into a PNG on demand.
import { deflateSync } from 'node:zlib';
import { RoomEvent, TrackKind, VideoBufferType, VideoStream } from '@livekit/rtc-node';

const MAX_SIDE = 1024; // downscale before sending to the vision model (enough to read a letter)
const STALE_MS = 3000; // a frame older than this is not "what the caller shows now"

export function watchCallerCamera(room, isCaller) {
  let latest = null; // { frame, rotation, at }
  let reader = null;

  const start = track => {
    stop();
    const stream = new VideoStream(track);
    reader = stream.getReader();
    const r = reader;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          latest = { frame: value.frame, rotation: value.rotation, at: Date.now() };
        }
      } catch { /* track ended */ }
    })();
    console.log(`[camera] watching caller video track "${track.name}"`);
  };
  const stop = () => {
    if (reader) reader.cancel().catch(() => {});
    reader = null;
    latest = null;
  };

  const onSubscribed = (track, _pub, participant) => {
    if (track.kind === TrackKind.KIND_VIDEO && isCaller(participant)) start(track);
  };
  const onGone = (track, _pub, participant) => {
    if (track.kind === TrackKind.KIND_VIDEO && isCaller(participant)) { console.log('[camera] caller video gone'); stop(); }
  };
  // The room is joined audio-only (like Chert's starter); we opt in to the caller's video track ourselves.
  const onPublished = (pub, participant) => {
    if (pub.kind === TrackKind.KIND_VIDEO && isCaller(participant)) { console.log('[camera] subscribing to caller video'); pub.setSubscribed(true); }
  };
  room.on(RoomEvent.TrackPublished, onPublished);
  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, onGone);
  room.on(RoomEvent.TrackMuted, (pub, participant) => { if (pub.kind === TrackKind.KIND_VIDEO && isCaller(participant)) latest = null; });

  // Video tracks the caller published before we registered.
  for (const p of room.remoteParticipants.values()) {
    if (!isCaller(p)) continue;
    for (const pub of p.trackPublications.values()) {
      if (pub.kind !== TrackKind.KIND_VIDEO) continue;
      if (pub.track) start(pub.track); else onPublished(pub, p);
    }
  }

  return {
    /** PNG Buffer of what the caller's camera shows right now, or null. */
    snapshotPng() {
      if (!latest || Date.now() - latest.at > STALE_MS) return null;
      const rgba = latest.frame.convert(VideoBufferType.RGBA);
      let img = { data: rgba.data, width: rgba.width, height: rgba.height };
      img = rotate(img, latest.rotation);
      img = downscale(img, MAX_SIDE);
      return encodePng(img);
    },
    hasVideo: () => !!latest && Date.now() - latest.at <= STALE_MS,
    close() {
      stop();
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onGone);
    },
  };
}

export function rotate(img, rotation) {
  const quarter = { 1: 1, 2: 2, 3: 3 }[rotation] || 0;
  let out = img;
  for (let i = 0; i < quarter; i++) out = rotate90(out);
  return out;
}

function rotate90({ data, width, height }) {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const nx = height - 1 - y, ny = x; // clockwise
      const dst = (ny * height + nx) * 4;
      out[dst] = data[src]; out[dst + 1] = data[src + 1]; out[dst + 2] = data[src + 2]; out[dst + 3] = data[src + 3];
    }
  }
  return { data: out, width: height, height: width };
}

function downscale(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

// Minimal PNG encoder (RGBA, no filter) so we need no native image library.
export function encodePng({ data, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, body])));
  return Buffer.concat([len, tb, body, crc]);
}
