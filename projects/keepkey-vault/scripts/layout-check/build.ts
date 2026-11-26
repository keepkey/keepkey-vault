// Bundles src/entry.tsx (the real dialogs, a scripted RPC instead of Bun) into out/.
const D = import.meta.dir
const maps = [
  { filter: /(^|\/)lib\/rpc$/, file: D + '/src/fake-rpc.ts' },
  { filter: /hooks\/useEvmAddresses$/, file: D + '/src/fake-evm.ts' },
  { filter: /hooks\/useDeviceState$/, file: D + '/src/fake-device.ts' },
]
const r = await Bun.build({ entrypoints: [D + '/src/entry.tsx'], outdir: D + '/out', target: 'browser', format: 'iife', naming: { entry: 'app.[ext]', asset: '[name].[ext]' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'fakes', setup(b) { for (const m of maps) b.onResolve({ filter: m.filter }, a => a.importer.startsWith(D + '/src/') ? undefined : ({ path: m.file })) } }] })
if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1) }
await Bun.write(D + '/out/index.html', '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css">'
  // An offscreen WebKit view never advances CSS animations: show their end state.
  + '<style>*,*::before,*::after{animation:none!important;transition:none!important}'
  // Nor does it honour backface-visibility (no compositing): the device's back face
  // (stage child 2, rotateY 180) would paint over the front. The app is composited.
  + '.kk-sd-stage>:nth-child(2){visibility:hidden}</style></head><body><div id="root"></div><script src="app.js"></script></body></html>')
console.log('built', r.outputs.length)
