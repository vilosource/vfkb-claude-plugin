# Vendored dependencies

The release gate is otherwise stdlib-only. This is its single dependency, and it
exists because five rounds of adversarial review showed that a hand-rolled
"which text is visible?" scanner cannot be made correct: visibility is a
*rendering* property, and every hand-written approximation leaked in one
direction (a disclosure hidden in a list-nested code fence) or over-rejected in
the other (an `<img>` badge line silently blocking an honest release).

## marked

| | |
|---|---|
| version | 18.0.6 |
| license | MIT (see `marked.LICENSE`) |
| source | https://registry.npmjs.org/marked/-/marked-18.0.6.tgz |
| file | `lib/marked.esm.js`, copied verbatim (renamed `.mjs` so Node loads it as ESM) |
| sha256 | `35398f546525d5e79a8f2f8738635d3ecbd277618cba2ada874e9d27dc9e88f0` |
| npm integrity | `sha512-MrV5puXBfuiy6wl6DLaq3BtIJQAJToAd5zt/ZKhRfGRAuFPALE7/4Y7jnxRQoEgK/pBgurGqLyAuRgZ2xOjr6w==` |

`release-gate.mjs` verifies that sha256 on every run. A vendored blob nobody can
check is its own trust problem — if the file is edited, the gate goes red.

Refresh:

    npm pack marked@<version> --registry=https://registry.npmjs.org
    tar xzf marked-<version>.tgz
    cp package/lib/marked.esm.js scenarios/vendor/marked.esm.mjs
    cp package/LICENSE           scenarios/vendor/marked.LICENSE
    sha256sum scenarios/vendor/marked.esm.mjs   # update this file AND release-gate.mjs
