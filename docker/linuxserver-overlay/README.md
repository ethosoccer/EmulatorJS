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

### Frontend Cache Policy

The overlay replaces `/etc/nginx/site-confs/default` to make the frontend shell less sticky in normal browser sessions. The root document, `index.html`, `css/index.css`, and `js/index.js` are served with no-cache headers, while larger ROM, artwork, video, and emulator assets keep the default static-file behavior.

The frontend and admin HTML also use versioned CSS/JS URLs so new overlay builds force browsers to request the updated entrypoint files.

## Build

From the repository root:

```sh
docker build -t ethosoccer/emulatorjs:ipfs-retry-fix docker/linuxserver-overlay
```

Use the resulting image in place of `lscr.io/linuxserver/emulatorjs:latest` in the server compose file.
