// Run from the repository root: node docs/handoffs/i18n-audit-20261104/audit.mjs
// Read-only source inspection; writes results.json beside this script.
import fs from 'node:fs'
import path from 'node:path'
import ts from '../../../projects/keepkey-vault/node_modules/typescript/lib/typescript.js'

const root = process.cwd()
const app = 'projects/keepkey-vault'
const localeRoot = `${app}/src/mainview/i18n/locales`
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
const flatten = (obj, prefix = '') => Object.fromEntries(Object.entries(obj).flatMap(([k,v]) => v && typeof v === 'object' ? Object.entries(flatten(v, `${prefix}${k}.`)) : [[`${prefix}${k}`,v]]))
const langs = fs.readdirSync(localeRoot).sort()
const namespaces = fs.readdirSync(`${localeRoot}/en`).filter(x => x.endsWith('.json')).map(x => x.slice(0,-5)).sort()
const catalogs = {}, duplicateKeys = [], parseErrors = [], nonStringValues = []
for (const lang of langs) {
  catalogs[lang] = {}
  for (const file of walk(`${localeRoot}/${lang}`).filter(x => x.endsWith('.json'))) {
    const source = fs.readFileSync(file, 'utf8')
    try { catalogs[lang][path.basename(file, '.json')] = flatten(JSON.parse(source)) }
    catch (e) { parseErrors.push({file, error: e.message}); continue }
    const ast = ts.parseJsonText(file, source)
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Set()
        for (const p of node.properties) if (p.name) {
          const key = p.name.text
          if (seen.has(key)) duplicateKeys.push({file, line: ast.getLineAndCharacterOfPosition(p.getStart(ast)).line + 1, key})
          seen.add(key)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const [key,value] of Object.entries(catalogs[lang][path.basename(file,'.json')])) if (typeof value !== 'string') nonStringValues.push({file,key,value})
  }
}
const tokens = s => [...String(s).matchAll(/{{\s*-?\s*([^},\s]+)(?:[^}]*?)}}/g)].map(x=>x[1]).sort()
const localeResults = langs.map(lang => {
  const missing = [], extra = [], empty = [], identicalToEnglish = [], interpolationMismatches = []
  for (const ns of namespaces) {
    const en = catalogs.en[ns], translated = catalogs[lang][ns] || {}
    for (const [key, value] of Object.entries(en)) {
      if (!(key in translated)) { missing.push(`${ns}:${key}`); continue }
      if (!String(translated[key]).trim()) empty.push(`${ns}:${key}`)
      if (lang !== 'en' && value === translated[key]) identicalToEnglish.push({key:`${ns}:${key}`, value})
      if (JSON.stringify(tokens(value)) !== JSON.stringify(tokens(translated[key]))) interpolationMismatches.push({key:`${ns}:${key}`, english:tokens(value), translated:tokens(translated[key]), value:translated[key]})
    }
    for (const key of Object.keys(translated)) if (!(key in en)) extra.push(`${ns}:${key}`)
  }
  const missingPluralForms=[]
  const categories=new Intl.PluralRules(lang).resolvedOptions().pluralCategories
  for(const ns of namespaces) {
    const families=new Set(Object.keys(catalogs.en[ns]).filter(k=>/_(one|other)$/.test(k)).map(k=>k.replace(/_(one|other)$/,'')))
    for(const family of families) for(const category of categories) if(!(`${family}_${category}` in (catalogs[lang][ns]||{}))) missingPluralForms.push(`${ns}:${family}_${category}`)
  }
  return {lang, namespaceCount:Object.keys(catalogs[lang]).length, keyCount:Object.values(catalogs[lang]).reduce((n,x)=>n+Object.keys(x).length,0), missing, extra, empty, identicalToEnglish, interpolationMismatches,missingPluralForms}
})

const sourceFiles = walk(`${app}/src`).filter(x => /\.(ts|tsx)$/.test(x) && !/\.(test|spec)\./.test(x) && !x.endsWith('.d.ts'))
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
const sourceResults = [], calls = [], dynamicCalls = [], hardcodedCandidates = [], formattingCalls = [], backendTextCandidates = [],unresolvedTCalls=[]
for (const file of sourceFiles) {
  const source = fs.readFileSync(file,'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const location = node => ({file,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1})
  const bindings = new Map()
  function scope(node) { while(node && !ts.isFunctionLike(node) && !ts.isSourceFile(node)) node=node.parent; return node }
  function bindingsVisit(node) {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast)==='useTranslation') {
      let ns = literal(node.initializer.arguments[0])
      if (!ns && node.initializer.arguments[0] && ts.isArrayLiteralExpression(node.initializer.arguments[0])) ns=literal(node.initializer.arguments[0].elements[0])
      ns ||= 'common'
      const owner=scope(node), map=bindings.get(owner)||new Map()
      for(const b of node.name.elements) if ((b.propertyName?.text || b.name.text)==='t') map.set(b.name.text,ns)
      bindings.set(owner,map)
    }
    ts.forEachChild(node,bindingsVisit)
  }
  bindingsVisit(ast)
  const resolve = (node,name) => { for(let p=node;p;p=p.parent) if(bindings.get(p)?.has(name)) return bindings.get(p).get(name) }
  let fileCalls=0, fileHardcoded=0
  const addCandidate = (node,value,kind) => {
    value=value.replace(/\s+/g,' ').trim()
    if (!/[a-zA-Z]{2}/.test(value)) return
    hardcodedCandidates.push({...location(node),kind,value}); fileHardcoded++
  }
  function visibleLiterals(node) {
    const value=literal(node)
    if (value!==undefined) addCandidate(node,value,'jsx-expression')
    else if (ts.isConditionalExpression(node)) { visibleLiterals(node.whenTrue); visibleLiterals(node.whenFalse) }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) visibleLiterals(node.right)
    else if (ts.isTemplateExpression(node)) {
      const fragments=[node.head.text,...node.templateSpans.map(x=>x.literal.text)].join('${…}')
      addCandidate(node,fragments,'jsx-template')
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name=node.expression.getText(ast), localName=ts.isIdentifier(node.expression)?node.expression.text:undefined
      const bound=localName?resolve(node,localName):undefined
      const isT=!!bound || /^(?:i18n|i18next)\.t$/.test(name)
      if(!isT && localName==='t') unresolvedTCalls.push({...location(node),expression:node.getText(ast)})
      if (isT) {
        fileCalls++
        const key=literal(node.arguments[0])
        if(key===undefined) dynamicCalls.push({...location(node),expression:node.getText(ast)})
        else {
          let ns=bound||'common', defaultValue=literal(node.arguments[1]), hasDefault=!!node.arguments[1] && (ts.isStringLiteral(node.arguments[1]) || ts.isTemplateExpression(node.arguments[1]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[1])), count=false, options
          options=node.arguments.find((a,i)=>i>0 && ts.isObjectLiteralExpression(a))
          if(options) for(const p of options.properties) if(ts.isPropertyAssignment(p)) {
            if(p.name.getText(ast).replace(/["']/g,'')==='ns') ns=literal(p.initializer)||ns
            if(p.name.getText(ast).replace(/["']/g,'')==='defaultValue') { defaultValue=literal(p.initializer); hasDefault=true }
            if(p.name.getText(ast).replace(/["']/g,'')==='count') count=true
          }
          const colon=key.indexOf(':'), resolvedNs=colon<0?ns:key.slice(0,colon), resolvedKey=colon<0?key:key.slice(colon+1)
          const en=catalogs.en[resolvedNs]||{}, exists=resolvedKey in en || (count && Object.keys(en).some(k=>k.startsWith(`${resolvedKey}_`)))
          calls.push({...location(node),key:`${resolvedNs}:${resolvedKey}`,exists,hasDefault, ...(defaultValue===undefined?{}:{defaultValue}),count})
        }
      }
      if (/\.(toLocaleString|toLocaleDateString|toLocaleTimeString)$/.test(name) || /^Intl\./.test(name)) formattingCalls.push({...location(node),expression:node.getText(ast)})
    }
    if (file.includes('/mainview/')) {
      if (ts.isJsxText(node)) addCandidate(node,node.text,'jsx-text')
      if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent)||ts.isJsxFragment(node.parent))) visibleLiterals(node.expression)
      if (ts.isJsxAttribute(node) && /^(title|placeholder|aria-label|alt|label|helperText)$/.test(node.name.getText(ast)) && node.initializer) {
        const value=literal(node.initializer)
        if(value!==undefined) addCandidate(node,value,`attribute:${node.name.getText(ast)}`)
      }
    }
    if (!file.includes('/mainview/') && ts.isPropertyAssignment(node) && /^(message|title|label|description|subtitle|detail|warning)$/.test(node.name.getText(ast).replace(/["']/g,''))) {
      const value=literal(node.initializer)
      if(value && /[a-zA-Z]{2}/.test(value)) backendTextCandidates.push({...location(node),field:node.name.getText(ast),value})
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
  sourceResults.push({file,translationCalls:fileCalls,hardcodedCandidates:fileHardcoded})
}
const results={
  scope:{app,sourceFiles:sourceFiles.length,source:'current working tree, including uncommitted changes',languages:langs,namespaces,limits:['Hardcoded text and English-identical values are review candidates, including legitimate brands, units and technical text.','Static key resolution covers lexically bound useTranslation aliases and i18n.t; dynamic keys require separate review.','Does not certify linguistic accuracy, visual layout, native runtime behavior, device firmware translations or external dapp content.']},
  catalogs:{parseErrors,duplicateKeys,nonStringValues,englishKeyCount:Object.values(catalogs.en).reduce((n,x)=>n+Object.keys(x).length,0),locales:localeResults},
  source:{files:sourceResults,staticCalls:calls.length,missingEnglishKeys:calls.filter(x=>!x.exists),dynamicCalls,unresolvedTCalls,hardcodedCandidates,formattingCalls,backendTextCandidates},
}
fs.writeFileSync(path.join(root,'docs/handoffs/i18n-audit-20261104/results.json'),JSON.stringify(results,null,2)+'\n')
console.log(JSON.stringify({englishKeys:results.catalogs.englishKeyCount,locales:localeResults.map(x=>({lang:x.lang,keys:x.keyCount,missing:x.missing.length,extra:x.extra.length,empty:x.empty.length,identical:x.identicalToEnglish.length,interpolation:x.interpolationMismatches.length})),duplicates:duplicateKeys,parseErrors,sourceFiles:sourceFiles.length,staticCalls:calls.length,missingEnglishCalls:results.source.missingEnglishKeys.length,dynamicCalls:dynamicCalls.length,hardcodedCandidates:hardcodedCandidates.length,backendTextCandidates:backendTextCandidates.length,topHardcodedFiles:sourceResults.filter(x=>x.hardcodedCandidates).sort((a,b)=>b.hardcodedCandidates-a.hardcodedCandidates).slice(0,20)},null,2))
