# Deploying the Melodi web app

```
phone / browser ──► app.getmelodi.xyz   Cloudflare Pages: the web app / PWA (free)
        │
        └─────────► api.getmelodi.xyz   Cloudflare Tunnel ──► your VPS
                                         melodi-server in Docker (search, yt-dlp,
                                         song relay + shared cache)
```

- **GitHub Actions** build both on every push to `main`:
  - `.github/workflows/web.yml` publishes the web app to Cloudflare Pages.
  - `.github/workflows/server.yml` publishes `ghcr.io/nixxane/melodi-server`.
- **The VPS** pulls the server image and runs it next to `cloudflared`. No
  ports are opened and there are no certificates to manage.

Do these once, in order. Everything is free except the VPS.

## 1. Put the domain on Cloudflare

The tunnel needs `getmelodi.xyz`'s DNS on Cloudflare.

- If it's already there, skip this.
- If not: add the site in the Cloudflare dashboard (free plan) and change the
  nameservers at your registrar to the two Cloudflare gives you.

The GitHub Pages site keeps working: copy its existing DNS records over, which
Cloudflare offers to do for you.

## 2. Create the tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
   → **Cloudflared**. Name it `melodi`.
2. Copy the **token** (the long string after `--token`). It goes in `.env` below.
3. **Public hostname**: `api.getmelodi.xyz` → service **HTTP** → `melodi:8080`.
   That's the port *inside* Docker's network, so it never clashes with other
   apps on the VPS. The only port on the VPS itself is `127.0.0.1:8737`, for
   checking from the VPS: `curl localhost:8737/api/health`.

## 3. Run the server on the VPS

You need Docker with the compose plugin
(`curl -fsSL https://get.docker.com | sh` on Debian/Ubuntu).

```sh
mkdir -p ~/melodi && cd ~/melodi
# copy deploy/compose.yml and deploy/.env.example here, then:
cp .env.example .env
openssl rand -hex 32          # paste as MELODI_SECRET in .env
nano .env                     # also paste TUNNEL_TOKEN
docker compose up -d
docker compose logs -f melodi # wait for "yt-dlp: /data/bin/yt-dlp"
```

Check it: <https://api.getmelodi.xyz/api/health> should say `ok`.

**First time only:** GitHub makes new packages private. Either open
github.com/nixxane → **Packages → melodi-server → Package settings → Change
visibility → Public**, or run `docker login ghcr.io` on the VPS with a
token that can read packages.

**ARM server (Hetzner CAX)?** Change `platforms` in
`.github/workflows/server.yml` to `linux/arm64`.

## 4. Publish the web app

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Direct upload**,
   project name `melodi`. Upload anything to create it; GitHub Actions replaces it.
2. **Custom domains** → add `app.getmelodi.xyz`.
3. Create an API token: **My Profile → API Tokens → Create token → "Edit
   Cloudflare Workers" template**, or a custom token with *Account → Cloudflare
   Pages → Edit*.
4. In the GitHub repository, **Settings → Secrets and variables → Actions**:
   - Secrets: `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` (shown on
     the dashboard's right side).
   - Variables: `MELODI_API_URL` = `https://api.getmelodi.xyz`
5. **Actions → Web app → Run workflow** (later pushes deploy by themselves).

Open <https://app.getmelodi.xyz>. On a phone:

- **iPhone:** Safari → Share → **Add to Home Screen**.
- **Android:** Chrome → ⋮ → **Install app**.

## Updating

- **Web app:** pushing to `main` redeploys. Installed apps pick it up the next
  time they open.
- **Server:** pushing to `main` builds a new image. Then, on the VPS:
  ```sh
  cd ~/melodi && docker compose pull && docker compose up -d
  ```
- **yt-dlp** updates itself every few hours inside the container.

## When something breaks

| Symptom | Fix |
| --- | --- |
| Songs won't start; logs say "confirm you're not a bot" | YouTube is blocking the VPS IP. Export cookies from a throwaway YouTube account (`cookies.txt`), copy them in with `docker compose cp cookies.txt melodi:/data/cookies.txt`, set `MELODI_YTDLP_ARGS=--cookies /data/cookies.txt` in `.env`, then `docker compose up -d`. A residential proxy (`--proxy …`) is the other option. |
| Every song link fails after a restart | `MELODI_SECRET` isn't set in `.env`. |
| The web app says it can't reach the server | Check `MELODI_ALLOWED_ORIGINS` matches the app's address exactly, and that `/api/health` answers. |
| Disk filling up | Lower `MELODI_CACHE_GB`. |

All server settings are in [crates/melodi-server/README.md](../crates/melodi-server/README.md).
