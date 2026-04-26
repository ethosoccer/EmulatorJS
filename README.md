<div align="center">

<img width="300" src="docs/Logo-light.png#gh-dark-mode-only" alt="EmulatorJS Dark Mode Logo">
<img width="300" src="docs/Logo.png#gh-light-mode-only" alt="EmulatorJS Light Mode Logo">

<br>

Self-hosted **JavaScript** emulation for various systems.

[![License: GPLv3][Badge License]][Link License]
[![Website][Badge Website]][Link Website]
[![Usage Docs][Badge Usage]][Link Usage]
[![Configurator][Badge Configurator]][Link Configurator]
[![Live Demo][Badge Demo]][Link Demo]
[![Contributors][Badge Contributors]][Link Contributors]

Join our Discord server:

[![Discord Badge](https://invidget.switchblade.xyz/6akryGkETU)](https://discord.gg/6akryGkETU)

</div>

---

## Getting Started

## This Fork Adds

This fork is tailored for a self-hosted EmulatorJS deployment with a browser-facing game library, profile sync, admin tooling, and operational logging.

### Frontend experience
- Search, favorites, and back navigation in console views
- Per-console filtering that scales to large libraries using virtualized game lists
- Save-state and ROM download actions directly from the game browser
- Default fallback video support from `data/main/videos/default.mp4` when a game-specific preview video is missing
- Profile popup with game save browsing, save version history, and version-aware downloads
- Automatic push-to-server when local save data changes while a user is logged in

### Profiles and sync
- Frontend login/logout with admin and user roles
- Push/pull profile sync from the browser UI
- Sync history preservation so pushes do not delete prior saves/configs; older versions are retained in history instead of being silently removed
- Password reset request webhook support
- Password change flows for admins and non-admin users

### Admin and file browser
- Modernized admin/file browser styling with light/dark mode support
- Resizable responsive modal windows across the admin UI
- User management, role management, and optional login gate for the main frontend
- Protected admin and file browser surfaces with admin-only access
- Safer destructive actions, including confirmations for ROM/file deletion paths

### ROM management improvements
- Preferred scan region per system
- Scan flags for previously reviewed ROMs
- Scan only new items vs scan all items
- Shared scan queue with cancel support across ROM scans, art downloads, and default file updates
- Running scans dashboard in the admin UI to reopen progress or cancel active work
- Searchable ROM identification workflow
- Accessible color changes for identified vs missing artwork states
- GoodTools-aware parsing of ROM names, including region/version/quality flags and smarter auto-linking for multi-region or multi-version sets
- Variant grouping on the frontend so region/version siblings appear as one game with a chooser modal for exact launches or favorites

### Security and observability
- Hardened auth/session behavior for public exposure
- Login attempt throttling and stricter origin checks on sensitive routes
- Webhook notifications for login attempts, successful logins, password reset requests, and game launches
- New admin `Logs` view with 90-day local retention by default
- Optional simultaneous forwarding of the same activity events to InfluxDB v2

### Deployment notes
This fork includes a Docker-based deployment overlay in [`docker/linuxserver-overlay`](docker/linuxserver-overlay) for the self-hosted setup used in this project.

### GoodTools naming support
This fork understands common [GoodTools](https://segaretro.org/GoodTools) naming conventions and uses them throughout ROM scanning, art downloads, and the frontend variant picker. The code meanings are based on GoodTools references from Sega Retro and Game Tech Wiki's [standard code list](https://emulation.gametechwiki.com/index.php/GoodTools#Standard_codes).

Common regions recognized by the scan pipeline and frontend include:
- `U` / `USA`
- `E` / `Europe`
- `J` / `Japan`
- `W` / `World`
- `UE` / `USA, Europe`
- `G` / `Germany`
- `F` / `France`
- `S` / `Spain`
- `I` / `Italy`
- `A` / `Australia`
- `Asia`, `Korea`, `China`, `Hong Kong`
- `PD` / `Public Domain`
- `Unl` / `Unlicensed`

Common GoodTools codes currently surfaced in the UI and scan logic:
- `[!]` verified good dump
- `[a]` alternate version
- `[b]` bad dump
- `[f]` fixed or patched dump
- `[h]` hack
- `[o]` overdump
- `[p]` pirate release
- `[t]` trained release
- `[T+...]` translation patch
- `[M#]` multilanguage release
- `(V1.0)` / `(V1.1)` style version tags
- `Beta`, `Alpha`, `Proto`, `Sample`, `Demo`, `Promo`, `Kiosk`

The scan pipeline uses that metadata to:
- prefer the configured scan region when multiple matches exist
- treat version and region siblings as one frontend game group with multiple launchable variants
- reuse downloaded art across sibling versions when the base title and region are the same
- expose code/tool-tip explanations such as `[!]` meaning a verified good dump

### Supported Systems
EmulatorJS supports a wide variety of legacy consoles and arcade machines. For the complete list of supported cores, please visit our [Cores Documentation](https://emulatorjs.org/docs4devs/cores).

### Versioning Guide
We use a specific versioning system to help you choose the right build for your needs:

1.  **Stable** - The most current release. Both code and cores are tested before release. Updated when new versions are released on GitHub. This is the default version on the Demo.
2.  **Latest** - Contains the latest code but uses stable cores. Updated whenever the `main` branch is updated. **This version will often be more broken than nightly**
3.  **Nightly** - Contains the latest code and the latest cores. Cores are updated daily. **This version is not recommended for production use as it is the main development branch.**

### CDN Integration
EmulatorJS provides a public CDN at `https://cdn.emulatorjs.org/`. You can access any version by setting the data path and loader.js accordingly.

```javascript
// Example Configuration
const EJS_pathToData = 'https://cdn.emulatorjs.org/<version>/data/';
// Replace <version> with: stable, latest, nightly, etc.
```

### Development
To run the project locally for development:

1.  Open a terminal in the root directory.
2.  Install dependencies:
    ```sh
    npm i
    ```
3.  Start the server/minification:
    ```sh
    npm run start
    ```
4.  Open `http://localhost:8080/` to view the demo.

> **Note:** Minify your script files before deploying to a production server to optimize load times and bandwidth. See [Minification Docs](minify/README.md).

---

## Community & Support

### 3rd Party Integrations
EmulatorJS is built as a library/plugin, not a standalone website (therefore, no Docker container). For projects that utilize EmulatorJS, check out our [3rd Party Integration List](https://emulatorjs.org/docs/3rd-party).

### Issues & Reporting
If you encounter an issue, please open an [Issue](https://github.com/EmulatorJS/EmulatorJS/issues) on GitHub. Include as many details as possible, including your browser console logs.

> **When reporting bugs, please specify the version you are using (Stable/Latest/Nightly).**

### Support the Project
This project is free and ad-free. The demo page may show occasional ads to help with hosting costs, but you can support development directly via [Patreon][Link Patreon].

---

## Star History

<a href="https://star-history.com/#EmulatorJS/EmulatorJS&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=EmulatorJS/EmulatorJS&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=EmulatorJS/EmulatorJS&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=EmulatorJS/EmulatorJS&type=Date" />
 </picture>
</a>

<!-- Link Definitions -->
[Badge License]: https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge&logo=opensourceinitiative
[Badge Website]: https://img.shields.io/badge/Website-736e9b?style=for-the-badge
[Badge Usage]: https://img.shields.io/badge/Usage-2478b5?style=for-the-badge
[Badge Configurator]: https://img.shields.io/badge/Config-992cb3?style=for-the-badge
[Badge Demo]: https://img.shields.io/badge/Demo-528116?style=for-the-badge
[Badge Contributors]: https://img.shields.io/badge/Contributors-54b7dd?style=for-the-badge
[Discord Badge]: https://invidget.switchblade.xyz/6akryGkETU

[Link License]: LICENSE
[Link Website]: https://emulatorjs.org/
[Link Usage]: https://emulatorjs.org/docs/
[Link Configurator]: https://emulatorjs.org/editor
[Link Demo]: https://demo.emulatorjs.org/
[Link Contributors]: docs/contributors.md
[Link Issue]: https://github.com/emulatorjs/emulatorjs/issues
[Link Patreon]: https://patreon.com/EmulatorJS
