/** Extract static inline defaults and reuse existing translations without inventing coverage. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import safety from './i18n-safety-translations.json'
import additional from './i18n-additional-translations.json'
import firmware from './i18n-firmware-translations.json'
import { messageKey } from '../src/shared/message-key'

const app = path.resolve(import.meta.dir, '..')
const root = path.join(app, 'src/mainview/i18n/locales')
const write = process.argv.includes('--write')
const walk = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)])
const languages=fs.readdirSync(root)
const catalogs: Record<string,Record<string,any>>={}
for(const language of languages) catalogs[language]=Object.fromEntries(walk(path.join(root,language)).filter(f=>f.endsWith('.json')).map(file=>[path.basename(file,'.json'),JSON.parse(fs.readFileSync(file,'utf8'))]))
const literal=(node:ts.Node|undefined):string|undefined => node && (ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))?node.text:undefined
const set=(obj:any,key:string,value:string) => { const keys=key.split('.');const leaf=keys.pop()!;for(const k of keys)obj=obj[k]??=( {} );if(obj[leaf]===undefined)obj[leaf]=value }
const flat=(obj:any,prefix=''):Record<string,string> => Object.fromEntries(Object.entries(obj).flatMap(([key,v])=>typeof v==='string'?[[prefix+key,v]]:Object.entries(flat(v,prefix+key+'.'))))
let extracted=0,reused=0
for(const file of walk(path.join(app,'src/mainview')).filter(f=>/\.(ts|tsx)$/.test(f)&&!f.includes('/locales/')&&!/\.test\./.test(f))) {
  const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true)
  const bindings=new Map<ts.Node,Map<string,string>>()
  function scope(node:ts.Node):ts.Node { let n=node;while(n.parent&&!ts.isFunctionLike(n)&&!ts.isSourceFile(n))n=n.parent;return n }
  function bind(node:ts.Node) {
    if(ts.isVariableDeclaration(node)&&ts.isObjectBindingPattern(node.name)&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==='useTranslation') {
      const arg=node.initializer.arguments[0]
      const ns=literal(arg)||(arg&&ts.isArrayLiteralExpression(arg)?literal(arg.elements[0]):undefined)||'common'
      const owner=scope(node),map=bindings.get(owner)||new Map()
      for(const b of node.name.elements)if((b.propertyName?.getText(ast)||b.name.getText(ast))==='t')map.set(b.name.getText(ast),ns)
      bindings.set(owner,map)
    }
    ts.forEachChild(node,bind)
  }
  bind(ast)
  const fileNamespaces=[...new Set([...bindings.values()].flatMap(v=>[...v.values()]))]
  const resolve=(node:ts.Node,name:string) => { for(let p:ts.Node|undefined=node;p;p=p.parent)if(bindings.get(p)?.has(name))return bindings.get(p)!.get(name) }
  function visit(node:ts.Node) {
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t') {
      const key=literal(node.arguments[0]);let ns=resolve(node,'t')||(fileNamespaces.length===1?fileNamespaces[0]:undefined)
      let value=literal(node.arguments[1])
      for(const arg of node.arguments.slice(1))if(ts.isObjectLiteralExpression(arg))for(const prop of arg.properties)if(ts.isPropertyAssignment(prop)) {
        const name=prop.name.getText(ast).replace(/["']/g,'')
        if(name==='ns')ns=literal(prop.initializer)||ns
        if(name==='defaultValue')value=literal(prop.initializer)
      }
      if(key&&value!==undefined&&ns) {
        const colon=key.indexOf(':'),namespace=colon<0?ns:key.slice(0,colon),localKey=colon<0?key:key.slice(colon+1)
        if(!catalogs.en[namespace])throw new Error(`Unknown namespace ${namespace}`)
        if(!(localKey in flat(catalogs.en[namespace]))) {set(catalogs.en[namespace],localKey,value);extracted++}
      }
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
}

for (const language of languages) {
  const values = safety[language as keyof typeof safety]
  if (!Array.isArray(values) || values.length !== safety.keys.length) throw new Error(`Incomplete safety translations: ${language}`)
  safety.keys.forEach((key,index) => {
    const [ns,localKey] = key.split(':')
    const keys=localKey.split('.'),leaf=keys.pop()!
    let obj=catalogs[language][ns]
    for(const k of keys)obj=obj[k]??={}
    obj[leaf]=values[index]
  })
}

for (const [source, values] of Object.entries(additional.messages)) {
  if (values.length !== additional.languages.length) throw new Error(`Incomplete translation: ${source}`)
  additional.languages.forEach((language,index) => { (catalogs[language].ui??={})[messageKey(source)] = values[index] })
}

for (const language of languages.filter(l=>l!=='en')) {
  const values=firmware[language as keyof typeof firmware]
  if (!Array.isArray(values)||values.length!==firmware.keys.length) throw new Error(`Incomplete firmware translations: ${language}`)
  firmware.keys.forEach((key,index) => { catalogs[language].setup.firmware.installWipe[key]=values[index] })
}

for(const language of languages.filter(l=>l!=='en')) {
  const memory=new Map<string,Set<string>>()
  for(const [ns,english] of Object.entries(catalogs.en)) {
    const local=flat(catalogs[language][ns]||{})
    for(const [key,source] of Object.entries(flat(english)))if(local[key]&&local[key]!==source) {
      if(!memory.has(source))memory.set(source,new Set())
      memory.get(source)!.add(local[key])
    }
  }
  for(const [ns,english] of Object.entries(catalogs.en)) {
    const target=catalogs[language][ns]??={}
    const existing=flat(target)
    for(const [key,source] of Object.entries(flat(english)))if(!(key in existing)) {
      const matches=memory.get(source)
      if(matches?.size===1) {set(target,key,[...matches][0]);reused++}
    }
  }
}

// These display keys belonged to an older one-time signing flow. The live UI
// uses deviceBlindSign*/solanaOpaque*; retaining contradictory translations is unsafe.
for(const language of languages)for(const key of ['blindSignBody','blindSignCaveat','blindSignTitle','blindSignEnable'])delete catalogs[language].swap[key]

const pluralMessages: Record<string,Record<string,Record<string,string>>>={
  ru:{
    tokenCount:{few:'{{count}} токена',many:'{{count}} токенов',other:'{{count}} токена'},
    showFiltered:{few:'Показать {{count}} отфильтрованных токена',many:'Показать {{count}} отфильтрованных токенов',other:'Показать {{count}} отфильтрованного токена'},
    hideFiltered:{few:'Скрыть {{count}} отфильтрованных токена',many:'Скрыть {{count}} отфильтрованных токенов',other:'Скрыть {{count}} отфильтрованного токена'},
    tokensCount:{few:'+{{count}} токена',many:'+{{count}} токенов',other:'+{{count}} токена'},
  },
  pl:{
    tokenCount:{few:'{{count}} tokeny',many:'{{count}} tokenów',other:'{{count}} tokena'},
    showFiltered:{few:'Pokaż {{count}} odfiltrowane tokeny',many:'Pokaż {{count}} odfiltrowanych tokenów',other:'Pokaż {{count}} odfiltrowanego tokena'},
    hideFiltered:{few:'Ukryj {{count}} odfiltrowane tokeny',many:'Ukryj {{count}} odfiltrowanych tokenów',other:'Ukryj {{count}} odfiltrowanego tokena'},
    tokensCount:{few:'+{{count}} tokeny',many:'+{{count}} tokenów',other:'+{{count}} tokena'},
  },
}
for(const language of languages)for(const [ns,english] of Object.entries(catalogs.en)) {
  const families=[...new Set(Object.keys(flat(english)).filter(k=>/_(one|other)$/.test(k)).map(k=>k.replace(/_(one|other)$/,'')))]
  for(const family of families) {
    const local=catalogs[language][ns],values=flat(local)
    for(const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
      const explicit=pluralMessages[language]?.[family]?.[category]
      if(explicit)set(local,`${family}_${category}`,explicit)
      else if(!values[`${family}_${category}`]&&values[`${family}_other`])set(local,`${family}_${category}`,values[`${family}_other`])
    }
  }
}
let changed=0
for(const [language,namespaces] of Object.entries(catalogs))for(const [ns,data]of Object.entries(namespaces)) {
  const file=path.join(root,language,`${ns}.json`)
  const original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):undefined
  const indentation=original && /^\t+"/m.test(original) ? '\t' : 2
  const next=JSON.stringify(data,null,indentation)+'\n'
  if(original===undefined||JSON.stringify(JSON.parse(original))!==JSON.stringify(data)) {
    if(write)fs.writeFileSync(file,next)
    changed++
  }
}
console.log(JSON.stringify({write,extracted,reused,changed}))
if (process.argv.includes('--check') && extracted > 0) {
  console.error('Static inline translation defaults are missing from English catalogs. Run i18n:sync --write and translate the new keys.')
  process.exit(1)
}
