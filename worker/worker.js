/**
 * Moon Seal — Worker backend cho album ảnh
 *
 * Endpoint:
 *   GET    /albums          → trả về albums.json (public)
 *   GET    /img/<key>       → trả về ảnh trong bucket (public, cache 1 năm)
 *   POST   /upload/<1-5>    → upload 1 ảnh vào album (cần header X-Password)
 *   DELETE /photo/<key>     → xoá 1 ảnh (cần header X-Password)
 *
 * Cần cấu hình (xem SETUP.md):
 *   - R2 bucket binding tên BUCKET
 *   - Secret ADMIN_PASSWORD
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Password",
};

const MAX_SIZE = 8 * 1024 * 1024; // giới hạn 8MB / ảnh

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function readAlbums(env) {
  const obj = await env.BUCKET.get("albums.json");
  if (!obj) return { "1": [], "2": [], "3": [], "4": [], "5": [] };
  return JSON.parse(await obj.text());
}

async function writeAlbums(env, albums) {
  await env.BUCKET.put("albums.json", JSON.stringify(albums), {
    httpMetadata: { contentType: "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── Public: danh sách album ──
    if (path === "/albums" && request.method === "GET") {
      return json(await readAlbums(env));
    }

    // ── Public: trả ảnh ──
    if (path.startsWith("/img/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice(5));
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers: CORS });
      return new Response(obj.body, {
        headers: {
          ...CORS,
          "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // ── Từ đây trở xuống cần mật khẩu ──
    const authed = request.headers.get("X-Password") === env.ADMIN_PASSWORD;

    // Upload ảnh
    if (path.startsWith("/upload/") && request.method === "POST") {
      if (!authed) return json({ error: "Sai mật khẩu" }, 401);

      const flower = path.split("/")[2];
      if (!["1", "2", "3", "4", "5"].includes(flower)) {
        return json({ error: "Album không hợp lệ" }, 400);
      }

      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.startsWith("image/")) {
        return json({ error: "Chỉ nhận file ảnh" }, 400);
      }

      // Đọc trọn file vào bộ nhớ — R2 cần biết trước độ dài dữ liệu,
      // đẩy stream trực tiếp có thể lỗi nếu thiếu Content-Length
      const data = await request.arrayBuffer();
      if (data.byteLength === 0) {
        return json({ error: "File rỗng" }, 400);
      }
      if (data.byteLength > MAX_SIZE) {
        return json({ error: "Ảnh vượt quá 8MB" }, 413);
      }

      const ext = (contentType.split("/")[1] || "jpg").split(";")[0].split("+")[0];
      const key = `flower${flower}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

      await env.BUCKET.put(key, data, {
        httpMetadata: { contentType },
      });

      const albums = await readAlbums(env);
      (albums[flower] ||= []).push(key);
      await writeAlbums(env, albums);

      return json({ ok: true, key, albums });
    }

    // Xoá ảnh
    if (path.startsWith("/photo/") && request.method === "DELETE") {
      if (!authed) return json({ error: "Sai mật khẩu" }, 401);

      const key = decodeURIComponent(path.slice(7));
      await env.BUCKET.delete(key);

      const albums = await readAlbums(env);
      for (const flower of Object.keys(albums)) {
        albums[flower] = albums[flower].filter((k) => k !== key);
      }
      await writeAlbums(env, albums);

      return json({ ok: true, albums });
    }

    return json({ error: "Not found" }, 404);
  },
};
