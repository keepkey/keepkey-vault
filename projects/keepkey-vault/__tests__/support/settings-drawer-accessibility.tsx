import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost/'})
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','Event','CustomEvent','MouseEvent','getComputedStyle','localStorage']) (globalThis as any)[key]=key==='window'?dom.window:(dom.window as any)[key]
;(window as any).matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let settings = { btcMultisigEnabled: false, walletConnectEnabled: true, pioneerServers: [], disabledNetworks: [], evmSimulationRpcUrls: {} }
let holdSettings = false, failSettings = false
const pendingReads: (() => void)[] = []
mock.module('../../src/mainview/lib/rpc',()=>({rpcRequest:async(method:string,params:any)=>{
  if (method === 'getAppSettings') {
    if (failSettings) throw new Error('Temporary settings read failure')
    const snapshot = { ...settings }
    if (holdSettings) return new Promise(resolve => pendingReads.push(() => resolve(snapshot)))
    return snapshot
  }
  if (method === 'setBtcMultisigEnabled') { settings = { ...settings, btcMultisigEnabled: params.enabled }; return { ...settings } }
  return {}
},onRpcMessage:()=>()=>{}}))
const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');const {ChakraProvider,defaultSystem}=await import('@chakra-ui/react')
await import('../../src/mainview/i18n/index')
const {DeviceSettingsDrawer}=await import('../../src/mainview/components/DeviceSettingsDrawer')
const {useBtcMultisigEnabled}=await import('../../src/mainview/hooks/useBtcMultisigEnabled')
const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
let close=()=>{}
function Host(){const [open,setOpen]=React.useState(false);const multisig=useBtcMultisigEnabled();close=()=>setOpen(false);return <><button onClick={()=>setOpen(true)}>Open settings</button><output data-multisig={multisig}/><DeviceSettingsDrawer open={open} onClose={()=>setOpen(false)} deviceState={{state:'disconnected'} as any}/></>}
await act(async()=>{root.render(<ChakraProvider value={defaultSystem}><Host/></ChakraProvider>)})
function snapshot(){const panel=container.querySelector('[aria-label="Settings"]') as HTMLElement;return {role:panel?.getAttribute('role'),modal:panel?.getAttribute('aria-modal'),hidden:panel?.getAttribute('aria-hidden'),visibility:panel?getComputedStyle(panel).visibility:null}}
const before=snapshot()
holdSettings = true
await act(async()=>{container.querySelector('button')!.click()})
const opened=snapshot()
await act(async()=>{window.dispatchEvent(new Event('keepkey-settings-changed'))})
const featuresButton = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Feature Flags')!
await act(async()=>{featuresButton.click()})
const multisigSwitch = () => container.querySelector('[role="switch"][aria-label="Multisig"]') as HTMLButtonElement
const walletConnectFeature = container.querySelector('[data-feature-icon="walletconnect"]') !== null
await act(async()=>{multisigSwitch().click()})
await act(async()=>{for (const resolve of pendingReads.splice(0)) resolve()})
const afterOldReplies = { toggle: multisigSwitch().getAttribute('aria-checked'), navigation: container.querySelector('output')!.getAttribute('data-multisig') }
holdSettings = false; failSettings = true
await act(async()=>{window.dispatchEvent(new Event('keepkey-settings-changed'))})
const afterFailedRefresh = container.querySelector('output')!.getAttribute('data-multisig')
failSettings = false
await act(async()=>{close()})
const closed=snapshot()
await act(async()=>{container.querySelector('button')!.click()})
const afterReopen = multisigSwitch().getAttribute('aria-checked')
await act(async()=>{root.unmount()})
console.log(JSON.stringify({before,opened,closed,features:{walletConnectFeature,afterOldReplies,afterFailedRefresh,afterReopen}}))
