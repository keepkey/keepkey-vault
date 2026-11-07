import { beforeAll, expect, test } from 'bun:test'
let ui:any
beforeAll(()=>{
 const run=Bun.spawnSync([process.execPath,new URL('./support/monero-node-ui.tsx',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe',timeout:60000})
 if(run.exitCode!==0)throw Error(run.stderr.toString())
 ui=JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
},60000)
test('own node is the preferred connection; size, free space and storage location are visible',()=>{
 expect(ui.preferred).toBe('local');expect(ui.initialText).toContain('recommended')
 expect(ui.initialText).toContain('Storage used: 2 GiB');expect(ui.initialText).toContain('Free space: 140 GiB')
 expect(ui.initialText).toContain('/Volumes/SSD/monero');expect(ui.detailsClosed).toBe(true)
})
test('Start becomes Stop with block progress; changing folders is disabled while running',()=>{
 expect(ui.started.button).toBe('Stop node');expect(ui.started.text).toContain('20 / 100 · 20.0%');expect(ui.started.folderDisabled).toBe(true)
 expect(ui.newLocation).toBe('/Volumes/Other/monero')
})
test('remote node is explicit, remains editable across polling, and requires a valid URL',()=>{
 expect(ui.remoteDraftSurvives).toBe('remote');expect(ui.remoteError).toContain('Use HTTPS')
 expect(ui.savedBeforeValid).toBe(0);expect(ui.savedRemote).toEqual(['save','remote','https://my-node.example'])
})
test('the asset page keeps node details collapsed and distinguishes full sync',()=>{
 expect(ui.compact).toEqual({summary:'Your node: Fully synced',closed:true,selectors:0})
})
