# LinuxServer EmulatorJS Overlay

This directory builds a small overlay image on top of `lscr.io/linuxserver/emulatorjs:latest`.

The running server uses the LinuxServer container, whose management backend is separate from the browser-only EmulatorJS package in this repository. The overlay keeps the same base image and replaces the small set of helper-app files needed for local fixes and admin UI tweaks.

## Changes

### Faster IPFS Art Download Failures

The art downloader retries failed IPFS downloads by reconnecting to a hardcoded default peer. If that peer is unreachable, `ipfs.swarm.connect()` rejects and the backend process exits before the normal retry/error path can finish.

This overlay catches and logs that peer reconnect failure, then lets the downloader continue retrying the asset.

It also makes failed IPFS assets move on faster:

- `IPFS_DOWNLOAD_TIMEOUT` defaults to `7000` ms instead of the upstream 20 seconds.
- `IPFS_DOWNLOAD_ATTEMPTS` defaults to `2`.
- `IPFS_RECONNECT_DEFAULT_PEER` defaults to disabled. Set it to `true` to retry the hardcoded default peer.

### Admin UI Styling

The overlay also replaces the LinuxServer helper app's admin assets in `/emulatorjs/public`:

- `public/index.html`
- `public/css/index.css`
- `public/js/index.js`

The admin UI now has a more modern responsive layout, refreshed buttons/cards/lists, and a light/dark theme toggle that is saved in browser `localStorage`.

The popup modal was updated to be responsive and user-resizable. It uses viewport-aware sizing, minimum dimensions, scrolling content, and a visible bottom-right resize indicator.

### Frontend Search And Favorites

The overlay also replaces the LinuxServer helper app's frontend menu assets in `/emulatorjs/frontend`:

- `frontend/index.html`
- `frontend/css/index.css`
- `frontend/js/index.js`

The game browser now has top-left Search and Favorites controls. Search builds a browser-side catalog from the configured console JSON files, so it can find games across consoles without changing ROM metadata.

Advanced search filters include console, logo artwork status, preview video status, and favorites-only.

Favorites are stored in browser `localStorage` using the console path and game name. Games can be toggled from the visible game list with the heart button, and the Favorites control opens a separate popup with the full saved list and per-game remove buttons.

The frontend also has a Profile login popup that uses the same `/profile` endpoint as the file browser. Logging in pulls the server profile, and logged-in users can manually pull or push from that popup.

Favorites are included in profile sync as `.emulatorjs-favorites.json` inside the pushed profile zip. Pull restores that file into browser `localStorage`, while save/state files continue to use the existing `RetroArch` IndexedDB profile storage. A companion `.emulatorjs-favorites-sync.json` file tracks favorite add/remove timestamps so stale browser pushes merge with the server instead of overwriting newer favorites.

Profile push is best-effort automatic while logged in: changing favorites queues a push, and the frontend also pushes every five minutes while the page is active. Browser games do not expose one reliable cross-core "save happened" event, so the periodic sync covers normal in-game saves and quicksaves without trying to hook every emulator core separately.

### File Browser Styling

The overlay replaces the LinuxServer helper app's file browser assets:

- `frontend/filebrowser.html`
- `frontend/css/filebrowser.css`
- `frontend/js/filebrowser.js`

The file browser now shares the modern admin styling and dark-mode toggle. Its existing profile Pull/Push buttons also include favorites in the profile zip.

The file browser is treated as an admin surface. Profile logins now include a `role` of `admin` or `user`; if no admin role exists yet, the first existing profile is promoted to `admin` so older installs remain accessible. Set `EMULATORJS_ADMIN_FALLBACK_USER` to choose a specific bootstrap admin profile during migration. Non-admin users do not see the file-browser icon on the main screen, and `/filebrowser.html` shows an admin login gate instead of the file browser.

On a fresh install with no profiles, `/admin/` and `/filebrowser.html` show a first-run setup form for creating the initial admin profile. The setup endpoint is disabled as soon as any profile exists.

File deletion now requires a confirmation dialog. The file browser also includes User Management for admins, including role changes, simple user creation, and an option to require login before showing the main game browser.

### Frontend Cache Policy

The overlay replaces `/etc/nginx/site-confs/default` to make the frontend shell less sticky in normal browser sessions. The root document, `index.html`, `filebrowser.html`, the active frontend CSS, and the active frontend JS files are served with no-cache headers, while larger ROM, artwork, video, and emulator assets keep the default static-file behavior.

The frontend and admin HTML also use versioned CSS/JS URLs so new overlay builds force browsers to request the updated entrypoint files.

### Nextcloud Archive Backup Memory Guard

Nextcloud archive backups build ZIP files in memory. Before creating archive ZIPs, the backup job checks the runtime memory limit and reserves one shared archive budget for the whole run. By default the budget is 75% of the detected memory limit. A separate single-ZIP limit defaults to 3.5 GiB to avoid Node/JSZip Buffer allocation failures. Archive scopes that individually exceed either limit, or that would push the cumulative selected archive input over the shared budget, are skipped and reported through the backup activity log, webhook, and Influx pipeline.

Normal Docker installs should be detected from the container cgroup limit. If Docker is running inside another container or VM and cannot see the outer memory cap, set `NEXTCLOUD_ARCHIVE_MEMORY_LIMIT_BYTES` on the EmulatorJS container, or set `NEXTCLOUD_ARCHIVE_MEMORY_LIMIT_FILE` to a readable file containing either a byte value or Linux `MemTotal` text such as `/proc/meminfo`. Set `NEXTCLOUD_ARCHIVE_BUDGET_BYTES` only if you want to override the computed 75% budget directly. Set `NEXTCLOUD_ARCHIVE_SINGLE_LIMIT_BYTES` only if you want to override the 3.5 GiB single-ZIP guard.

## Build

From the repository root:

```sh
docker build -t your-registry/emulatorjs:custom docker/linuxserver-overlay
```

Use the resulting image in place of `lscr.io/linuxserver/emulatorjs:latest` in the server compose file.
