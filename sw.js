/*
 * ZOBO's service worker. It exists so Chrome and Edge can install ZOBO as a desktop app with its own icon and window.
 * It stores nothing and changes nothing: every request goes to the network exactly as before, so the app is always the newest
 * version and the server is always asked directly (no old answers from a cache).
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* no respondWith: the browser loads everything from the network as usual */ });
