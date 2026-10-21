# Deploying Cinebyte on Render

Self-hosting on your own machine (Linux / Windows / macOS) is covered in
README.md. This guide is for Render's free tier, where the server sleeps
after ~15 minutes of no traffic - and the wake screen that goes with it.

## Deploying on Render (free tier) + the wake page

Free Render web services sleep after ~15 minutes without traffic, and while
asleep they serve nothing - the browser just hangs until the container boots
(usually 30-60s). You cannot customize a page for that hang (nothing of yours
is running yet); instead you either prevent the sleep or greet the wake with
a static page:

1. **`/health`** is built into the server: cheapest possible response,
   CORS-open (`*`), `Cache-Control: no-store`. It is the probe and ping target.

2. **`gh-pages/index.html`** is the customizable sleep/wake screen. Host it
   anywhere that never sleeps and is free - GitHub Pages, Cloudflare Pages,
   Netlify - it is a single static file. Make it the site index so shared
   links hit it at the root. Edit the CONFIG block at the top:

   ```js
   var CONFIG = {
     APP: 'https://your-app.onrender.com',  // your Render service URL
     BRAND: 'CINEBYTE',                      // shown above the message
     MESSAGE: 'The server is waking up',     // the headline
     ACCENT: '#8B5CF6'                       // spinner color
   };
   ```

   Share links through the wake host, not the Render URL. Deep links are
   clean path-style URLs now - no query string needed:

   ```
   https://your-wake-host/tv/105248/1/1        <- preferred, looks like the site
   https://your-wake-host/?to=/tv/105248/1/1  <- old format, still works
   ```

   The `gh-pages/` folder is a full static site:
   - `index.html` - the Vidium homepage (live embed demo, embed code,
     downloads, self-hosting steps), with the demo pointing at your instance
   - `404.html` - the wake screen. GitHub Pages serves it for any missing
     path while keeping the URL in the address bar, so `/tv/105248/1/1` on
     the Pages site IS the deep link. The old `?to=` format still works
   - `.nojekyll` - tells Pages to serve the files as-is (no Jekyll)

   Publish to GitHub Pages (never-sleeps, free):

   ```
   git subtree push --prefix gh-pages origin gh-pages
   ```

   then GitHub repo Settings -> Pages -> Source: branch `gh-pages`, folder
   `/ (root)`. For your own instance, set CONFIG.APP in `404.html` first
   (already pointing at https://vidium.crosmakesgames.com).

   The page does a fast first probe (1.2s) - an awake server is forwarded to
   instantly, with no sleep screen at all. If the probe fails, the branded
   spinner + elapsed timer shows and it polls `APP/health` every 2 seconds,
   forwarding to the deep link the moment the instance answers (both formats
   are path-only, so the page cannot redirect anywhere else).

3. **Prevent the sleep instead**: point a free uptime pinger (UptimeRobot,
   cron-job.org) at `https://your-app.onrender.com/health` every 10 minutes
   and the instance stays warm around the clock - no wake page ever shown.
   This also keeps the in-memory session registry alive, so nobody who
   paused for a while comes back to "Unknown session".

## Custom domains on Render (verified against render.com/docs)

Yes, Render supports custom domains - the free Hobby plan includes 2, TLS
certificates are issued/renewed automatically, and HTTP redirects to HTTPS.
But the DNS records are NOT the GitHub Pages pattern:

- **Subdomain** (play.yourdomain.com): one CNAME record -> `your-app.onrender.com`.
- **Root/apex domain** (yourdomain.com): an ALIAS/ANAME record
  (CNAME flattening) -> `your-app.onrender.com`, or if your DNS provider has
  neither, ONE A record -> `216.24.57.1` (Render's load balancer).
  On Cloudflare DNS, use a CNAME, never an A record.
- Remove any AAAA records - Render is IPv4-only.
- Add www and Render auto-redirects the root (and vice versa).

The "4 A records (185.199.x.x) + CNAME" pattern is GitHub Pages' own - it
applies only to the wake-page host if you put a custom domain on that side.

## Why not run the player backend on Cloudflare Workers

The server is a long-running Node HTTP server with in-memory sessions and a
streaming proxy. Workers is a different runtime: no Node http server, no
persistent memory between requests (Durable Objects would be needed), and the
resolve chain would need a rewrite. There is also no machine to SSH into -
Workers, Pages, GH Pages and free-tier Render are all serverless. Render SSH
exists but is paid-plan only; on free plans you publish by connecting the
GitHub repo and pushing (auto-deploys), which is the simplest workflow anyway.
