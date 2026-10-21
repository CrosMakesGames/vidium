# Vidium - self-hosted streaming player

A fully custom streaming player built on the vidsrc resolution chain (the same
approach popcornmovies.ac uses). One zero-dependency Node server, one player
page, no upstream iframes - your player, your rules. This guide covers
self-hosting on Linux, Windows and macOS: install, run, keep it running in the
background, put it online with HTTPS, and update it.

Self-hosting means the player is YOURS - it runs on your machine so your
shows always work, no matter what happens to anyone else's site. The
`veridium/` folder is an OPTIONAL local frontend (the TMDB browse UI, with
"vidium (this instance)" as its first server slot): it is OFF by default and
NEVER takes over the site. Start with `VERIDIUM=1 npm start` and it appears
at `/browse` - same origin, zero external calls. On a published instance,
just don't set the flag and Veridium is never served at all.

| Route | Served by |
|---|---|
| `/` | Vidium homepage: readme summary, downloads, live embed demo - ALWAYS |
| `/vidium` | same homepage (short link) |
| `/tv/{id}/{s}/{e}`, `/movie/{id}` | the Vidium player |
| `/browse` | Veridium browse UI - ONLY when started with `VERIDIUM=1` |
| `/v/{app.js,style.css,layout.conf}`, `/v/modules/*` | Vidium client assets |
| `/health`, `/resolve`, `/meta`, `/mp/*` | Vidium server APIs |

Veridium slots are editable in `veridium/servers.js`; instance branding lives
in `veridium/instance-host-data.js`.

## What you need

- Node 18 or newer (nothing else - no `npm install`, no build step, zero dependencies)
- ~50 MB of RAM and outbound internet access on port 443
- Optional: a domain name + Caddy for HTTPS

## 1. Install Node

**Linux (Debian / Ubuntu)**

```bash
sudo apt update && sudo apt install -y nodejs unzip
node -v        # must print v18 or newer
```

If the distro Node is older than 18, use nvm instead:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install --lts
```

**macOS**

```bash
brew install node
```

**Windows** (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS
```

or grab the LTS installer from nodejs.org. Close and reopen the terminal
afterwards, then confirm with `node -v`.

## 2. Get the code and run it

```bash
git clone https://github.com/crosmakesgames/vidium.git
cd vidium
npm start
```

(`npm start` is just `node server/server.js` - run that directly if you prefer.)

Open http://localhost:3000/tv/105248/1/1 (Cyberpunk: Edgerunners S1E1) or
http://localhost:3000/movie/155 (The Dark Knight).

**Custom port**

- Linux / macOS: `PORT=8080 node server/server.js`
- Windows PowerShell: `$env:PORT=8080; node server\server.js`

**Sanity check** that the server is healthy:

```bash
curl http://localhost:3000/health        # -> ok
```

On Windows just open http://localhost:3000/health in a browser.

## 3. Keep it running in the background

The simplest option that works on all three systems is pm2:

```bash
npm install -g pm2
pm2 start server/server.js --name vidium
pm2 save
pm2 startup        # prints a command - run it once to autostart after reboot
```

- Linux: `pm2 startup` sets up a systemd unit for you. Useful commands:
  `pm2 logs vidium`, `pm2 restart vidium`, `pm2 stop vidium`.
- macOS: same, it sets up a launchd job.
- Windows: `pm2 startup` is not supported there. Either keep pm2 for
  background running only (no boot autostart), or install it as a real
  service with NSSM:

  ```powershell
  # download nssm from nssm.cc, then:
  nssm install Vidium "C:\Program Files\nodejs\node.exe" "C:\path\to\vidium\server\server.js"
  nssm set Vidium AppDirectory C:\path\to\vidium
  nssm start Vidium
  ```

**Pure systemd alternative on Linux** (no pm2), `/etc/systemd/system/vidium.service`:

```ini
[Unit]
Description=Vidium player
After=network.target

[Service]
WorkingDirectory=/opt/vidium
ExecStart=/usr/bin/node server/server.js
Environment=PORT=3000
Restart=on-failure
User=vidium

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vidium
```

## 4. (Only do the next steps if you want to publish your self-hosted instance to the web. If you just want to keep it for you, you are done.) Put it on the internet (domain + HTTPS)

Use Caddy: one small binary, automatic Let's Encrypt certificates, works the
same on all three OSes.

- Linux: install from the official repo (see caddyserver.com/docs/install)
- macOS: `brew install caddy`
- Windows: `winget install Caddy.Caddy` or download from caddyserver.com

Create a `Caddyfile` next to wherever you run caddy from:

```
vidium.example.com {
    reverse_proxy localhost:3000
}
```

Then `caddy run` (or install it as a service: `sudo systemctl enable --now caddy`
on Linux, `brew services start caddy` on macOS, `nssm install Caddy` on Windows).
Caddy obtains and renews the HTTPS certificate automatically - the only thing
it needs is for the DNS to point at your machine first.

**DNS**: at your registrar, point an A record (`vidium.example.com`) at your
machine's public IP (or a CNAME to a hostname that resolves there). If you are
hosting at home, forward ports 80 and 443 on your router to the machine, and if
your ISP changes your IP consider a dynamic-DNS hostname.

Self-hosting has one nice bonus: the resolve chain runs from your own IP, and
the upstream is friendlier to residential IPs than to datacenter ranges.

## 5. Updating

```bash
cd vidium
git pull
pm2 restart vidium        # or: sudo systemctl restart vidium / nssm restart Vidium
```

(Or unzip a new build over the folder and restart.) Sessions live in server
memory, so a restart drops any active sessions - viewers just reload the page.
Restart at a quiet moment.

## Troubleshooting

- "All servers failed" - the upstream rate-limited you. Wait 60s and hit Retry
  (the button re-runs the whole chain).
- Playlist loads but no segments - stream JWT expired (4h) or your subnet
  changed. Reload the page; it re-runs the chain.
- Playback works for others but not from a datacenter/VPN IP - expected; the
  upstream cuts datacenter IPs after a few requests. Play from normal
  connections.
- `curl http://localhost:3000/health` is the quickest "is it alive" check;
  `/resolve?type=tv&id=105248&season=1&episode=1` is the debugging endpoint
  for the chain itself.

## Routes

| Route | Meaning |
|---|---|
| `/tv/{tmdbId}/{season}/{episode}` | TV episode player |
| `/movie/{tmdbId}` | Movie player |
| `/health` | aliveness probe (200 "ok", CORS-open, no side effects) |
| `/resolve?type=tv\|movie&id=...&season=&episode=` | Resolution JSON (used by the page, also handy for debugging) |

The same page also supports:
- hash routes `#/tv/123/1/2` and `#/movie/123`
- query routes `?type=tv&id=123&season=1&episode=2`
- injected demo data: `?data=<base64 resolve JSON>` (fresh mint, short-lived)
- a remote resolver: `?resolve=<server base url>` (looks for `{base}/resolve?...`)
- mock mode: `?mock=1` - public test streams so every feature works anywhere

## Features

- Custom player UI: dark, quiet, no upstream branding
- Server switcher with automatic failover (a dying server hops to the next one and keeps your position)
- Audio fix suite - built for the Edgerunners 5.1 downmix bug (dialogue right ear, music left):
  - Stereo / Mono / Swap L-R channel modes
  - Continuous balance slider
  - Loudness boost (0x to 10x with a soft limiter so nothing clips)
  - Audio sync offset (-1000ms to +1000ms)
- Subtitles: every language track the source provides (SRT), custom renderer
  with size, background and sync controls; English auto-selected when present
- Skip intro (TV only): real intro times per episode from TheIntroDB
  (community-verified, fetched client-side from api.theintrodb.org, no key -
  the button even waits out cold opens using the intro's start time); falls back
  to the 85s conf default, learns the true intro end automatically if you rewind
  right after a skip, and long-press the video to set your own marker (always
  wins)
- Controls: ±10s (buttons, J/L keys, arrows), speed 0.25x-2x, quality (Auto +
  every rendition the stream offers), fullscreen, picture-in-picture
- Info screen (loading): customizable from layout.conf `[idle_screen]` -
  eyebrow text ("YOU'RE WATCHING" / anything / hidden), description and meta
  chips toggleable, backdrop dim, subtle backdrop drift and text fade
- Pause screen: a NORMAL pause - the frame freezes exactly where it is and
  the title/description overlay fades in over it (never the artwork preload
  screen). After 15 seconds paused the dim eases in gently. Configurable via
  layout.conf `[pause_info]`: enabled / delay / show_episode_overview / show_rating
- Progress: remembers where you stopped, offers "Resume from 0:52" on revisit,
  auto-advances to the next episode when one ends
- Keyboard: space/K play, arrows seek, up/down volume, F fullscreen, M mute,
  S subtitles, C audio panel
- Mobile: double-tap left/right to ±10s, responsive layout

## Customization

Everything user-facing is configured in `client/layout.conf`: brand name,
accent color, `[idle_screen]` look, control toggles, skip-intro defaults.
Edit and restart; no build step.

## How the resolution chain works

Reverse-engineered from the vidsrc stack (all from your own server, no upstream iframes):

1. `vs_src.php` on tvserver-1 hands back a fresh upstream shell URL (rotating host) plus its `?vs=` token
2. Shell page -> `playerUrl`
3. Player page -> single-use `apiToken` (IP-bound, ~2 min TTL)
4. `data.vidsrc.sh/api.php?...&stream_urls&api_token=...` -> encrypted stream URLs + a per-5-minute-window WASM decryptor
5. WASM (ChaCha20) decrypts three mirror playlist URLs
6. `generate.php` on the stream host -> 4-hour stream JWT (browser fetches this itself, so the token is bound to the viewer's own subnet)
7. `mirror?token=...` -> master m3u8 (360p / 720p / 1080p, avc1 + AAC)

Notes for operators:
- `/generate.php` rate-limits hard (nginx 429). The client retries with backoff.
- The stream JWT is bound to a /24 subnet and lasts 4 hours; because the
  BROWSER fetches its own token (CORS is open, `*`), this works from home
  connections. Datacenter IPs get cut off quickly by the upstream - host your
  server wherever you like, but expect playback itself from residential IPs.
- `stream_urls` are single-use per mint; the resolver re-runs the chain per
  episode switch.

## Structure

```
client/          the player page (index.html + app.js + style.css + modules/)
  modules/       subtitles / audiofix / skipintro / pstore / router / uikit
server/          zero-dependency Node server
  vidsrc-resolve.js   the full resolution chain as a module
  resolve-cli.js      node resolve-cli.js tv 105248 1 1 | movie 155
gh-pages/        the wake screen (only needed for free hosts that sleep -
                 see README-deploy.md; not required when self-hosting)
```

## Verified

- Unit tests: node player-modules/test.js (all 6 modules, 10 assertions)
- Live chain: Edgerunners s1e1 (tv 105248), One Piece s1e1 (tv 37854), The
  Dark Knight (movie 155) - all resolve ok with real playlist fetches
- Real-browser QA: playback, server switching, failover, subtitles, skip
  intro, seek, speed, quality, audio fix modes, progress resume - all
  exercised in a real Chrome session
- Upstream blocks datacenter IPs after a few requests, so full-stream
  playback was QA'd from residential-style flows; the player itself plays
  any reachable HLS source (mock streams verified in-browser)

Deploying to a free host like Render instead (with the sleep/wake screen and
custom domains)? That is covered in README-deploy.md.
