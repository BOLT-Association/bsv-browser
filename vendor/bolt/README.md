# vendor/bolt

`bolt.js` is generated: the BOLT handler for a WebView host (the token logic of b017, the page
script, the trusted-side service and the token store), bundled from the ChainBrowsers repository
(`packages/bolt`, entry `src/rn.js`). `@bsv/sdk` is left as an import, so this app's own SDK is used.

Do not edit it. To update it, in ChainBrowsers:

    cd packages/bolt && npm run bundle:rn -- ../../browsers/bsv-browser/vendor/bolt/bolt.js

`bolt.d.ts` is written by hand and describes only what the app uses (`utils/bolt/boltService.ts`,
`utils/webview/documentStartScript.ts`).
