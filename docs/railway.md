# Hosting on Railway (for Clara)

Railway runs the server 24/7, so Clara connects to a public address and your own PC only needs mGBA and OBS.
Railway is paid after the trial credit (roughly $5 a month on the Hobby plan). The free alternative is a tunnel, see the README.

The repo already has a `Dockerfile` and `railway.json`, so there is nothing to build by hand.

## 1. Put the project on GitHub
Railway deploys from a GitHub repo. Make a **private** repo and push the `Project` folder to it
(`.env`, `local/` and the database are already ignored, so no secrets go up).

## 2. Create the service
1. railway.com, then **New Project**, then **Deploy from GitHub repo**, and pick the repo.
2. Railway finds the Dockerfile and builds it. The first build takes a couple of minutes.

## 3. Add a volume (so the dex survives redeploys)
Service, **Settings**, **Volumes**, add one with the mount path `/data`.

## 4. Set variables (Service, Variables)
| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD` | the one in your local `.env`, or a new one |
| `OVERLAY_KEY` | same idea |
| `ZOE_TOKEN` | same idea |
| `CLARA_TOKEN` | same idea |
| `TCP_PORT` | `9000` |
| `COUNT_EXISTING_PROGRESS` | `false` for a clean start |
| `TWITCH_CHANNEL`, `TWITCH_BOT_NAME`, `TWITCH_BOT_TOKEN` | later, when chat is set up |

Do not set `PORT`. Railway sets it for the web side itself.

## 5. Open the two doors (Service, Settings, Networking)
1. **Generate Domain** for the web side. You get `something.up.railway.app`.
2. **TCP Proxy**, internal port `9000`. Railway shows an address like `something.proxy.rlwy.net:15140`.

Then add two more variables from those:
- `PUBLIC_URL` = `https://something.up.railway.app`
- `PUBLIC_TCP_HOST` = `something.proxy.rlwy.net` and `PUBLIC_TCP_PORT` = `15140`

Railway redeploys. These are what Clara's setup page writes into her script.

## 6. Use it
- Admin: `https://<your domain>/admin/`. The setup and overlay links are shown there.
- Clara: send her **her setup link** from the admin page. It hands her a ready-made script.
- You: use the overlay link from the admin page in OBS, and give your own mGBA the Zoe script from your setup link
  (replace `local/zoe-pinball-pals.lua`).
- The launcher `.bat` is no longer needed for streams, only for local testing.

## 7. Check
Healthcheck: `https://<your domain>/healthz` should say `{"ok":true}`. Then load the scripts and watch both dots go green.
Test the TCP side on its own: Clara's console should print "Connected as Clara!".

## Moving your test data
Local data does not carry over. That is fine: use **Reset everything** on the admin page before the first real stream.
