import {expect,test} from 'bun:test'
test('the closed Settings drawer leaves the main page accessible and cannot claim modal focus',()=>{
 const run=Bun.spawnSync([process.execPath,new URL('./support/settings-drawer-accessibility.tsx',import.meta.url).pathname],{cwd:new URL('../',import.meta.url).pathname,stdout:'pipe',stderr:'pipe',timeout:30000})
 if(run.exitCode)throw new Error(run.stderr.toString())
 const result=JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
 const hidden={role:null,modal:null,hidden:'true',visibility:'hidden'}
 expect(result.before).toEqual(hidden)
 expect(result.opened).toEqual({role:'dialog',modal:'true',hidden:'false',visibility:'visible'})
 expect(result.closed).toEqual(hidden)
})
