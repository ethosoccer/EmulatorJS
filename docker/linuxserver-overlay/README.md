# LinuxServer EmulatorJS Overlay

This directory builds a small overlay image on top of `lscr.io/linuxserver/emulatorjs:latest`.

The running server uses the LinuxServer container, whose management backend is separate from the browser-only EmulatorJS package in this repository. The overlay keeps the same base image and replaces only `/emulatorjs/index.js`.

## Fix

The art downloader retries failed IPFS downloads by reconnecting to a hardcoded default peer. If that peer is unreachable, `ipfs.swarm.connect()` rejects and the backend process exits before the normal retry/error path can finish.

This overlay catches and logs that peer reconnect failure, then lets the downloader continue retrying the asset.

It also makes failed IPFS assets move on faster:

- `IPFS_DOWNLOAD_TIMEOUT` defaults to `7000` ms instead of the upstream 20 seconds.
- `IPFS_DOWNLOAD_ATTEMPTS` defaults to `2`.
- `IPFS_RECONNECT_DEFAULT_PEER` defaults to disabled. Set it to `true` to retry the hardcoded default peer.

## Build

From the repository root:

```sh
docker build -t ethosoccer/emulatorjs:ipfs-retry-fix docker/linuxserver-overlay
```

Use the resulting image in place of `lscr.io/linuxserver/emulatorjs:latest` in the server compose file.
