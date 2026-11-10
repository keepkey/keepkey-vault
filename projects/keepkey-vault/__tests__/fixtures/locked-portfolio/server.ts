/** Actual App and device hook; child feature screens are isolated placeholders. */
import { createServer, transformWithEsbuild } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
const appFile = resolve(import.meta.dir, '../../../src/mainview/App.tsx')
const stubs = {
  name: 'locked-portfolio-ui-isolation', enforce: 'pre' as const,
  resolveId(id: string) { if (id.startsWith('virtual:locked-portfolio/')) return '\0' + id },
  async load(id: string) {
    if (!id.startsWith('\0virtual:locked-portfolio/')) return
    const names = new URLSearchParams(id.split('?')[1] || '').get('names')?.split(',') || []
    let source = "import React, { useEffect, useRef } from 'react';\n"
    for (const n of names) {
      if (n === 'Dashboard') source += `export function Dashboard(p) { const id=useRef(++window.__portfolioRenders); useEffect(()=>{p.onLoaded?.()},[]); return <div data-testid="portfolio" data-instance={id.current} data-watch-only={!!p.watchOnly}>Portfolio<button onClick={()=>window.__deviceAction++}>Send</button></div> }\n`
      else if (n === 'SplashScreen') source += `export function SplashScreen(p) {return <div data-testid="splash">{p.statusText}{p.children}</div>}\n`
      else if (n === 'OobSetupWizard') source += `export function OobSetupWizard(){return <div data-testid="setup">Setup</div>}\n`
      else if (n === 'DeviceGrid') source += `export function DeviceGrid(p){useEffect(()=>{p.onReady?.()},[]);return <div>Wallets</div>}\n`
      else if (n === 'TopNav') source += `export function TopNav(p){return <nav data-testid="nav" data-connected={!!p.connected}>Vault</nav>}\n`
      else if (n === 'useOnline') source += 'export const useOnline=()=>true;\n'
      else if (n === 'useBtcNodeStatus') source += 'export const useBtcNodeStatus=()=>null;\n'
      else if (n === 'useBtcMultisigEnabled') source += 'export const useBtcMultisigEnabled=()=>false;\n'
      else if (n === 'useLatestBalances') source += 'export const useLatestBalances=()=>[];\n'
      else source += `export const ${n}=()=>null;\n`
    }
    // Compile the isolated child stubs before Vite performs import analysis.
    return (await transformWithEsbuild(source, "locked-stubs.tsx", { loader: "tsx", jsx: "automatic" })).code
  },
  transform(source: string, id: string) {
    if (id.split('?')[0] !== appFile) return
    return source.replace(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g, (statement, bindings, path) => {
      const component = path.startsWith('./components/') && !path.startsWith('./components/device/')
      const hook = ['./hooks/useOnline','./hooks/useBtcNodeStatus','./hooks/useBtcMultisigEnabled','./lib/commandBus'].includes(path)
      if (!component && !hook) return statement
      const names = bindings.split(',').map((n: string)=>n.trim()).filter((n: string)=>!n.startsWith('type ')).map((n: string)=>n.split(/\s+as\s+/)[0])
      return `import {${names.join(',')}} from "virtual:locked-portfolio/${path.split('/').pop()}?names=${names.join(',')}&file=.tsx"`
    })
  },
}
const vite=await createServer({configFile:false,plugins:[stubs,react({include:/\.[jt]sx?(?:\?|$)/})],root:import.meta.dir,server:{host:'127.0.0.1',port:Number(process.env.LOCK_UI_QA_PORT||5208),strictPort:true,fs:{allow:[resolve(import.meta.dir,'../../../..')]}}})
await vite.listen()
console.log('Locked portfolio UI fixture ready')
