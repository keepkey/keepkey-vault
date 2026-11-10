// Actual Dashboard cache race regression; in-memory fixture only. Run after server.ts.
import fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { expect } = await import(process.env.PLAYWRIGHT_TEST_MODULE || '@playwright/test')
const base=`http://127.0.0.1:${process.env.CORE_QA_PORT || 5201}`
const out=process.env.CORE_QA_EVIDENCE || '.'
const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE,headless:true})
const page=await browser.newPage({viewport:{width:1280,height:900}})
let release, pending
const errors=[],calls=[]
page.on('pageerror',error=>errors.push(error.stack||error.message))
await page.route('**/*',async route=>{
 const req=route.request(),url=req.url()
 if(!url.startsWith(base)) return req.resourceType()==='image'?route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'}):route.abort()
 if(url.endsWith('/__test_rpc')&&req.method()==='POST'){
  const packet=req.postDataJSON();calls.push(packet.method)
  if(packet.method==='getCachedBalances'){
   const res=await route.fetch(),reply=await res.json()
   return pending=new Promise(resolve=>release=()=>resolve(route.fulfill({response:res,json:reply})))
  }
 }
 return route.continue()
})
try{
 await page.goto(base+'/?page=dashboard')
 await expect.poll(()=>typeof release).toBe('function')
 await page.evaluate(()=>window.__fixturePush('balance-updated',{chainId:'bitcoin',symbol:'BTC',balance:'7',balanceUsd:455000,nativeBalanceUsd:455000,priceUsd:65000,address:'bc1qSynthetic',tokens:[],syncState:'confirmed',updatedAt:Date.now()}))
 await expect(page.getByText('7.0000 BTC',{exact:true})).toBeVisible()
 const before=await page.locator('body').innerText()
 release();await pending
 await expect(page.getByText('7.0000 BTC',{exact:true})).toBeVisible()
 await expect(page.getByText('0.250000 BTC',{exact:true})).toHaveCount(0)
 const after=await page.locator('body').innerText()
 fs.mkdirSync(out,{recursive:true})
 fs.writeFileSync(out+'/dashboard-cache-race-results.json',JSON.stringify({newerPushPreserved:true,before,after,errors,calls,realProfile:false},null,2))
 console.log(JSON.stringify({newerPushPreserved:true,errors,calls},null,2))
}catch(error){console.log('PROOF ERROR',error.stack);console.log((await page.locator('body').innerText()).slice(0,7000));process.exitCode=1}
finally{await browser.close()}
