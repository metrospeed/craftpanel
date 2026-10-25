# Notes for agents working on CraftPanel

## Bump the version with every change

Each PR that changes the panel must bump the version, in the same PR:

- New feature: minor bump (1.1.0 → 1.2.0).
- Bug fix or small tweak: patch bump (1.1.0 → 1.1.1).

Run `npm version <minor|patch> --no-git-tag-version`. It updates both `package.json` and `package-lock.json` (don't edit them by hand).

The version is what the panel shows in Settings and the sidebar. Installs without a recorded commit also compare it with GitHub to decide whether an update is available (`src/updater.js`).
