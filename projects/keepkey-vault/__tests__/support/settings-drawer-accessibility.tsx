import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost/'})
for (const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','getComputedStyle','localStorage']) (globalThis as any)[key]=key==='window'?dom.window:(dom.window as any)[key]
;(window as any).matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
mock.module('../../src/mainview/lib/rpc',()=>({rpcRequest:async()=>({}),onRpcMessage:()=>()=>{}}))
const React=await import('react');const {act}=React;const {createRoot}=await import('react-dom/client');const {ChakraProvider,defaultSystem}=await import('@chakra-ui/react')
await import('../../src/mainview/i18n/index')
const {DeviceSettingsDrawer}=await import('../../src/mainview/components/DeviceSettingsDrawer')
const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
let close=()=>{}
function Host(){const [open,setOpen]=React.useState(false);close=()=>setOpen(false);return <><button onClick={()=>setOpen(true)}>Open settings</button><DeviceSettingsDrawer open={open} onClose={()=>setOpen(false)} deviceState={{state:'disconnected'} as any}/></>}
await act(async()=>{root.render(<ChakraProvider value={defaultSystem}><Host/></ChakraProvider>)})
function snapshot(){const panel=container.querySelector('[aria-label="Settings"]') as HTMLElement;return {role:panel?.getAttribute('role'),modal:panel?.getAttribute('aria-modal'),hidden:panel?.getAttribute('aria-hidden'),visibility:panel?getComputedStyle(panel).visibility:null}}
const before=snapshot()
await act(async()=>{container.querySelector('button')!.click()})
const opened=snapshot()
await act(async()=>{close()})
const closed=snapshot()
await act(async()=>{root.unmount()})
console.log(JSON.stringify({before,opened,closed}))
