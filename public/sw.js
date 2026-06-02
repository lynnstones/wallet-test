const CACHE_NAME = "family-wallet-v1";

// 预缓存的静态资源（离线时也能加载 shell）
const PRECACHE_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 清除旧版本缓存
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // 只处理 GET 请求；Supabase API 等网络请求不拦截
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Supabase / 外部 API 请求：直接走网络，不缓存
  if (url.hostname !== self.location.hostname) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        // 只缓存成功的同源静态资源响应
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      // Cache-first：有缓存先用缓存，同时后台更新；无缓存则等网络
      return cached || networkFetch;
    })
  );
});
