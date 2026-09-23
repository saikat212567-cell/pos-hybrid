/**
 * Item images on R2.
 *
 * This is an upload endpoint, so the two rules that matter are: never trust the
 * declared type, and always cap the size.
 *
 * `Content-Type` is set by the caller and means nothing — a request can claim
 * `image/png` and send anything at all. So the type is determined from the
 * file's own leading bytes (its magic number) and the request is refused if
 * those do not match a format we intend to serve. Serving user-uploaded bytes
 * back under a type the uploader chose is how a stored-XSS or
 * content-sniffing problem starts.
 */

/**
 * Formats we accept, by signature.
 *
 * Deliberately not SVG: an SVG is a document that can carry script, and serving
 * one from the same origin as the admin screen would be an XSS vector. Raster
 * only.
 */
const SIGNATURES = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** WebP is RIFF....WEBP — the marker is at offset 8, so it needs its own check. */
const isWebp = b =>
  b.length > 12 &&
  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

/**
 * 2 MB. Clients downscale before uploading (canvas on web,
 * BitmapFactory.inSampleSize on Android), so anything larger is either an
 * un-resized phone photo or an attempt to fill the bucket. Generous enough for
 * a good tile image, small enough that a counter on a slow connection is not
 * waiting.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Identify an image from its leading bytes.
 * @returns the MIME type, or null if these bytes are not an image we accept
 */
export function sniffImageType(buffer) {
  const b = new Uint8Array(buffer);
  for (const { type, bytes } of SIGNATURES) {
    if (bytes.every((v, i) => b[i] === v)) return type;
  }
  return isWebp(b) ? 'image/webp' : null;
}

/**
 * Store an item's image.
 *
 * The key is derived from the item id rather than the filename: a
 * caller-supplied name could contain path segments, and one item has one image,
 * so there is nothing to gain from keeping the original name.
 *
 * @returns {Promise<{key: string, type: string, size: number}>}
 * @throws {Error} with `.status` set, for the route to turn into a response
 */
export async function putItemImage(env, itemId, request) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    const e = new Error(`image too large: max ${MAX_IMAGE_BYTES} bytes`);
    e.status = 413;
    throw e;
  }

  // Read fully before writing: the type cannot be known from a stream's first
  // chunk without buffering anyway, and Content-Length is caller-supplied, so
  // the real length has to be measured rather than believed.
  const body = await request.arrayBuffer();

  if (body.byteLength === 0) {
    const e = new Error('empty body');
    e.status = 400;
    throw e;
  }
  if (body.byteLength > MAX_IMAGE_BYTES) {
    const e = new Error(`image too large: max ${MAX_IMAGE_BYTES} bytes`);
    e.status = 413;
    throw e;
  }

  const type = sniffImageType(body);
  if (!type) {
    const e = new Error('body is not a PNG, JPEG, GIF or WebP image');
    e.status = 400;
    throw e;
  }

  const key = `items/${itemId}`;

  await env.IMAGES.put(key, body, {
    // The sniffed type, never the declared one. This is what will be sent back
    // to browsers, so it has to be something we verified ourselves.
    httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return { key, type, size: body.byteLength };
}

/**
 * Serve an image.
 *
 * Cached hard and for a long time: a tile image is fetched once per device and
 * then comes from the browser or OkHttp cache, which is also what keeps the
 * catalog looking right offline. The URL carries a version query when an image
 * is replaced, so `immutable` is safe — a new upload produces a new URL rather
 * than needing this cache invalidated.
 */
export async function getImage(env, key, cors) {
  const object = await env.IMAGES.get(key);
  if (!object) return new Response('not found', { status: 404, headers: cors() });

  const headers = new Headers(cors());
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Belt and braces against content sniffing: even though the type was
  // verified on upload, telling browsers not to second-guess it costs nothing.
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(object.body, { headers });
}

export async function deleteItemImage(env, itemId) {
  await env.IMAGES.delete(`items/${itemId}`);
}
