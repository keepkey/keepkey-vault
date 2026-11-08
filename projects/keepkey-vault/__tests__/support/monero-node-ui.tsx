import { JSDOM } from 'jsdom'
const dom = new JSDOM('<html><body></body></html>', {url:'http://localhost/'})
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','getComputedStyle','localStorage']) (globalThis as any)[key]=key==='window'?dom.window:(dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
window.matchMedia ??= (()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})) as any
const React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client')
const {ChakraProvider,defaultSystem}=await import('@chakra-ui/react')
await import('../../src/mainview/i18n/index')
const {MoneroNodePanel}=await import('../../src/mainview/components/MoneroNodePanel')
const {validateMoneroNode}=await import('../../src/bun/monero-settings')
let settings:any={moneroDaemonUrl:'http://127.0.0.1:18081',moneroRestoreHeight:0,moneroNodeMode:'local'}
let node:any={available:true,state:'stopped',dataDir:'/Volumes/SSD/monero',logPath:'/Volumes/SSD/monero/node.log',rpcUrl:settings.moneroDaemonUrl,pruned:true,diskBytes:2*1024**3,freeBytes:140*1024**3,reserveBytes:25*1024**3,estimatedBytes:105*1024**3,height:null,targetHeight:null,percent:null,peers:null}
let failRemote=false
const calls:any[]=[],client={settings:async()=>settings,status:async()=>node,
 save:async(next:any)=>{validateMoneroNode(next);if(failRemote&&next.mode==='remote')throw Error('Could not reach a Monero mainnet node');calls.push(['save',next.mode,next.daemonUrl]);return settings={...settings,moneroNodeMode:next.mode,moneroDaemonUrl:next.daemonUrl}},
 start:async()=>{calls.push(['start']);return node={...node,state:'syncing',height:20,targetHeight:100,percent:20}},
 stop:async()=>{calls.push(['stop']);return node={...node,state:'stopped'}},
 configure:async(path:string)=>{calls.push(['folder',path]);return node={...node,dataDir:path}}}
const c=document.createElement('div');document.body.appendChild(c);const root=createRoot(c)
const wait=()=>new Promise(r=>setTimeout(r,25))
async function render(compact=false){await act(async()=>{root.render(React.createElement(ChakraProvider,{value:defaultSystem},React.createElement(MoneroNodePanel,{key:compact?'asset':'settings',client,compact})));await wait()});await act(wait)}
async function refresh(){await act(async()=>{window.dispatchEvent(new Event('keepkey-settings-changed'));await wait()})}
async function click(selector:string){const e=c.querySelector(selector);if(!e)throw Error(selector);await act(async()=>{e.dispatchEvent(new MouseEvent('click',{bubbles:true}));await wait()})}
async function type(selector:string,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(c.querySelector(selector),value);c.querySelector(selector)!.dispatchEvent(new Event('input',{bubbles:true}));await wait()})}
const text=()=>c.textContent?.replace(/\s+/g,' ').trim()??''
const out:any={}
await render();out.preferred=(c.querySelector('select')as HTMLSelectElement).value;out.initialText=text();out.detailsClosed=!c.querySelector('details')!.open
await click('[data-node-toggle]');out.started={text:text(),folderDisabled:(c.querySelector('[data-node-folder]')as HTMLInputElement).disabled,button:c.querySelector('[data-node-toggle]')!.textContent}
await click('[data-node-toggle]');await type('[data-node-folder]','/Volumes/Other/monero');await click('[data-node-folder-save]');out.newLocation=c.querySelector('[data-node-location]')!.textContent
await act(async()=>{const select=c.querySelector('select')as HTMLSelectElement;select.value='remote';select.dispatchEvent(new Event('change',{bubbles:true}));await wait()})
await refresh();out.remoteDraftSurvives=(c.querySelector('select')as HTMLSelectElement).value
await type('input[aria-label="Monero daemon URL"]','http://unsafe.example');await click('[data-node-remote-connect]');out.remoteError=text();out.savedBeforeValid=calls.filter(v=>v[0]==='save').length
await type('input[aria-label="Monero daemon URL"]','https://my-node.example');await click('[data-node-remote-connect]');out.savedRemote=calls.at(-1)
settings={...settings,moneroNodeMode:'local',moneroDaemonUrl:'http://127.0.0.1:18081'};node={...node,state:'ready',height:100,targetHeight:100,percent:100};await refresh();await render(true)
out.compact={summary:c.querySelector('summary')!.textContent,closed:!c.querySelector('details')!.open,selectors:c.querySelectorAll('select').length}
node={...node,state:'syncing',height:20,targetHeight:100,percent:20};await refresh()
const savesBefore=calls.filter(v=>v[0]==='save').length
await click('[data-node-use-remote]')
out.remoteShortcut={url:(c.querySelector('input[aria-label="Monero daemon URL"]')as HTMLInputElement).value,saves:calls.filter(v=>v[0]==='save').length-savesBefore,privacy:text().includes('sees your IP address')}
failRemote=true;await click('[data-node-remote-connect]');out.failedShortcut={mode:c.querySelector('[data-node-connection]')!.textContent,error:text().includes('Could not reach'),editing:!!c.querySelector('[data-node-remote-connect]')}
failRemote=false;await click('[data-node-remote-connect]');out.connectedShortcut={mode:c.querySelector('[data-node-connection]')!.textContent,url:settings.moneroDaemonUrl,localStillRunning:node.state==='syncing',stops:calls.filter(v=>v[0]==='stop').length,localDetails:c.querySelector('summary')!.textContent,editing:!!c.querySelector('[data-node-remote-connect]')}
await click('[data-node-change]')
await act(async()=>{const select=c.querySelector('select[aria-label="Monero connection"]')as HTMLSelectElement;select.value='local';select.dispatchEvent(new Event('change',{bubbles:true}));await wait()})
out.returnToLocal=settings.moneroDaemonUrl
// Local status must not prevent the independently configured remote from appearing.
settings={...settings,moneroNodeMode:'remote',moneroDaemonUrl:'https://remote.example'}
client.status=async()=>{throw Error('RPC request timed out: moneroNodeStatus')}
await refresh()
out.remoteWithStatusFailure={mode:c.querySelector('[data-node-connection]')?.textContent,hasChange:!(c.querySelector('[data-node-change]') as HTMLButtonElement).disabled,globalError:!!c.querySelector('[data-monero-node-panel] > [role=alert]')}
client.status=async()=>node;await refresh()
out.statusRecovered=!c.querySelector('[data-node-status-error]')
await act(async()=>root.unmount());console.log(JSON.stringify(out))
