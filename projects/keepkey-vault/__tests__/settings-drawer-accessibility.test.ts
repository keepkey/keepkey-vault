import {expect,test} from 'bun:test'
test('Settings stays accessible and preserves saved multisig across late replies, failed refresh and reopen',()=>{
 const run=Bun.spawnSync([process.execPath,new URL('./support/settings-drawer-accessibility.tsx',import.meta.url).pathname],{cwd:new URL('../',import.meta.url).pathname,stdout:'pipe',stderr:'pipe',timeout:30000})
 if(run.exitCode)throw new Error(run.stderr.toString())
 const result=JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
 const hidden={role:null,modal:null,hidden:'true',visibility:'hidden'}
 expect(result.before).toEqual(hidden)
 expect(result.opened).toEqual({role:'dialog',modal:'true',hidden:'false',visibility:'visible'})
 expect(result.closed).toEqual(hidden)
 expect(result.features).toEqual({walletConnectFeature:false,afterOldReplies:{toggle:'true',navigation:'true'},afterFailedRefresh:'true',afterReopen:'true'})
})
