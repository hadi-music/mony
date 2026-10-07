# MONY

Pay-yourself-first for irregular income. Log a payment, get the exact transfers, tick them off.

Plain HTML/CSS/JS, no build step. Data lives only in the browser (localStorage), so back up from Splits → Data.

## Deploy (GitHub Pages)
1. Push the contents of this folder to a repo (root of the repo or a `/docs` folder).
2. Repo → Settings → Pages → deploy from that branch/folder.
3. Open the URL on your phone in Safari → Share → Add to Home Screen.

## Updating
Bump `VERSION` in `sw.js` on every deploy, or phones keep serving the cached old files. The new version loads on the second launch after the deploy.

## Icons
`node icons/make-icons.mjs` regenerates the PNGs (the 40/10/15/35 donut).
