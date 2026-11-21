// Cloudflare Worker for per-site links like https://royal.yourdomain.com
// Route: *.yourdomain.com/*  ->  this Worker. It simply serves the IBTIKAR app (the Pages project) under the visitor's
// own hostname, so the app can read location.hostname and show the published site for that subdomain.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "ibtkar-app.pages.dev";   // <- your Pages project
    url.protocol = "https:";
    return fetch(new Request(url, request));
  },
};
