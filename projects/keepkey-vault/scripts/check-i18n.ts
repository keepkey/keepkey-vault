/** Catalog integrity and explicit regression budget for untranslated legacy copy. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { SUPPORTED_LANGUAGES } from '../src/mainview/i18n/languages'
import { messageKey } from '../src/shared/message-key'

const root=path.resolve(import.meta.dir,'../src/mainview/i18n/locales')
const baselineFile=path.resolve(import.meta.dir,'i18n-baseline.json')
const errors:string[]=[],missing:Record<string,string[]>={}
const catalogs:Record<string,Record<string,Record<string,string>>>={}
const flat=(obj:any,prefix=''):Record<string,string>=>Object.fromEntries(Object.entries(obj).flatMap(([key,value])=>typeof value==='string'?[[prefix+key,value]]:value&&typeof value==='object'?Object.entries(flat(value,prefix+key+'.')):[[prefix+key,value as string]]))
const tokens=(value:string)=>[...value.matchAll(/{{\s*-?\s*([^},\s]+)[^}]*}}/g)].map(x=>x[1]).sort().join(',')
const namespaces=fs.readdirSync(path.join(root,'en')).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5))
const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])
for(const language of SUPPORTED_LANGUAGES) {
  catalogs[language]={}
  for(const namespace of namespaces) {
    const file=path.join(root,language,`${namespace}.json`)
    if(!fs.existsSync(file)){errors.push(`${language}/${namespace}: missing file`);continue}
    const source=fs.readFileSync(file,'utf8')
    try{catalogs[language][namespace]=flat(JSON.parse(source))}catch(error){errors.push(`${file}: ${error}`);continue}
    const ast=ts.parseJsonText(file,source)
    function visit(node:ts.Node) {
      if(ts.isObjectLiteralExpression(node)) {
        const keys=new Set<string>()
        for(const p of node.properties)if(p.name){const key=p.name.getText(ast);if(keys.has(key))errors.push(`${language}/${namespace}: duplicate ${key}`);keys.add(key)}
      }
      ts.forEachChild(node,visit)
    }
    visit(ast)
    for(const [key,value] of Object.entries(catalogs[language][namespace]))if(typeof value!=='string'||!value.trim())errors.push(`${language}/${namespace}:${key}: empty or non-string`)
  }
}
for(const language of SUPPORTED_LANGUAGES)for(const namespace of namespaces) {
  const english=catalogs.en[namespace]||{},local=catalogs[language][namespace]||{}
  for(const [key,value]of Object.entries(english)) {
    if(!(key in local)) { (missing[`${namespace}:${key}`]??=[]).push(language);continue }
    if(tokens(value)!==tokens(local[key]))errors.push(`${language}/${namespace}:${key}: interpolation mismatch`)
  }
  for(const [key,value]of Object.entries(local)) {
    if(!(key in english)) {
      const source=english[key.replace(/_(zero|two|few|many)$/,'_other')]
      if(source===undefined)errors.push(`${language}/${namespace}:${key}: unknown key`)
      else if(tokens(source)!==tokens(value))errors.push(`${language}/${namespace}:${key}: plural interpolation mismatch`)
    }
  }
  const families=[...new Set(Object.keys(english).filter(k=>/_one$/.test(k)).map(k=>k.slice(0,-4)))]
  for(const family of families)for(const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories)if(!local[`${family}_${category}`])errors.push(`${language}/${namespace}:${family}_${category}: missing plural form`)
}

// UI content keys must match their source so edited prose cannot reuse stale copy.
for(const [key,value]of Object.entries(catalogs.en.ui||{}))if(messageKey(value)!==key)errors.push(`en/ui:${key}: content key mismatch`)
const baselineData=fs.existsSync(baselineFile)?JSON.parse(fs.readFileSync(baselineFile,'utf8')):{}
const baseline:Record<string,string>=baselineData.missing||{}
for(const [key,languages]of Object.entries(missing))for(const language of languages)if(!(baseline[key]||'').split(',').includes(language))errors.push(`New untranslated string: ${language}/${key}`)
const sourceHashes: Record<string,string>={}
for(const [namespace,values]of Object.entries(catalogs.en))if(namespace!=='ui')for(const [key,value]of Object.entries(values)) {
  const id=`${namespace}:${key}`
  sourceHashes[id]=createHash('sha256').update(value).digest('hex')
  if(baselineData.sourceHashes?.[id] && baselineData.sourceHashes[id]!==sourceHashes[id])errors.push(`English source changed; check existing translations: ${id}`)
}
const rawUi = new Set<string>()
const sourceRoot=path.resolve(root,'../..')
for(const file of walk(sourceRoot).filter(f=>f.endsWith('.tsx')&&!/(__|\.test\.|\/logo\/)/.test(f))) {
  const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  function visit(node:ts.Node) {
    let text:string|undefined
    if(ts.isJsxText(node))text=node.text.replace(/\s+/g,' ').trim()
    if(ts.isJsxAttribute(node)&&/^(title|placeholder|aria-label|alt|label|helperText)$/.test(node.name.getText(ast))&&node.initializer&&ts.isStringLiteral(node.initializer))text=node.initializer.text
    if(text&&/[A-Za-z]{2}/.test(text)&&!/^(?:https?:|\/|[A-Z0-9_./:#-]{1,14}$)/.test(text))rawUi.add(`${path.relative(sourceRoot,file)}:${messageKey(text)}`)
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='uiText'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])) {
      if(catalogs.en.ui?.[messageKey(node.arguments[0].text)]!==node.arguments[0].text)errors.push(`UI source missing from English catalog: ${path.relative(sourceRoot,file)}:${node.arguments[0].text}`)
      // A JS string is not JSX text: React prints '&times;' literally. Use the character itself.
      if(/&[a-zA-Z]+;|&#[0-9]+;/.test(node.arguments[0].text))errors.push(`HTML entity in UI string (renders literally): ${path.relative(sourceRoot,file)}:${node.arguments[0].text}`)
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
}
for(const id of rawUi)if(!(baselineData.rawUi||[]).includes(id))errors.push(`New hardcoded UI text: ${id}`)
const inlineCheck=Bun.spawnSync([process.execPath,path.join(import.meta.dir,'sync-i18n.ts'),'--check'],{stdout:'pipe',stderr:'pipe'})
if(inlineCheck.exitCode!==0)errors.push(inlineCheck.stderr.toString()||'Inline default extraction failed')
if(process.argv.includes('--write-baseline')) {
  // Explicit maintenance operation; never invoked by CI or sync-i18n.
  const structuralErrors=errors.filter(e=>!e.startsWith('New untranslated string:')&&!e.startsWith('New hardcoded UI text:')&&!e.startsWith('English source changed;'))
  if(structuralErrors.length){console.error(structuralErrors.join('\n'));process.exit(1)}
  fs.writeFileSync(baselineFile,JSON.stringify({description:'Known untranslated content. English fallback is intentional until translated; never copy English into target catalogs to hide debt.',sourceHashes,rawUi:[...rawUi].sort(),missing:Object.fromEntries(Object.entries(missing).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v.join(',')]))},null,2)+'\n')
}else if(errors.length){console.error(errors.slice(0,100).join('\n'));console.error(`${errors.length} i18n errors`);process.exit(1)}
console.log(JSON.stringify({languages:SUPPORTED_LANGUAGES.length,namespaces:namespaces.length,englishKeys:Object.values(catalogs.en).reduce((n,x)=>n+Object.keys(x).length,0),knownUntranslatedPairs:Object.values(missing).reduce((n,x)=>n+x.length,0),missingByLanguage:Object.fromEntries(SUPPORTED_LANGUAGES.map(l=>[l,Object.values(missing).filter(v=>v.includes(l)).length]))}))
