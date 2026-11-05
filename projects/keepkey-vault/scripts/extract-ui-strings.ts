/** One-time/source-maintenance codemod. Preview by default; pass --write to apply. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { messageKey } from '../src/shared/message-key'

const app = path.resolve(import.meta.dir, '..')
const write = process.argv.includes('--write')
const walk = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
const messages: Record<string, string> = {}
const catalogFile = path.join(app, 'src/mainview/i18n/locales/en/ui.json')
if (fs.existsSync(catalogFile)) Object.assign(messages, JSON.parse(fs.readFileSync(catalogFile, 'utf8')))
let changed = 0, extracted = 0
for (const file of walk(path.join(app, 'src/mainview')).filter(f => f.endsWith('.tsx') && !/(__|\.test\.|\/logo\/)/.test(f))) {
  let source = fs.readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits: Array<{start: number; end: number; value: string}> = []
  const owners = new Set<ts.Block>()
  function component(node: ts.Node): ts.Block | undefined {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.isFunctionLike(n) && 'body' in n && n.body && ts.isBlock(n.body)) {
        const name = n.name?.getText(ast) || (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(ast) : '')
        if (/^[A-Z]/.test(name)) return n.body
      }
    }
  }
  const isProse = (value: string) => /[A-Za-z]{2}/.test(value) && !/^(?:https?:|\/|[A-Z0-9_./:#-]{1,14}$)/.test(value)
  function register(text: string) {
    const key = messageKey(text)
    if (messages[key] && messages[key] !== text) throw new Error(`Message key collision: ${text}`)
    messages[key] = text
    return JSON.stringify(text)
  }
  function replace(node: ts.Node, value: string, owner: ts.Block) {
    edits.push({start: node.getStart(ast), end: node.end, value})
    owners.add(owner); extracted++
  }
  function decode(text: string) {
    return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (_, entity: string) => {
      const entities: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'}
      return entities[entity] ?? String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : parseInt(entity.slice(1),10))
    })
  }
  // Match React's JSX whitespace folding; preserve explicit spaces around values.
  function jsxValue(text: string) {
    const lines = text.replace(/\r/g,'').split('\n')
    let value = ''
    const last = lines.reduce((last,line,i) => /[^ \t]/.test(line) ? i : last, 0)
    lines.forEach((line,i) => {
      let part = line.replace(/\t/g,' ')
      if (i) part=part.replace(/^ +/,'')
      if (i !== lines.length-1) part=part.replace(/ +$/,'')
      if(part) value+=part+(i!==last?' ':'')
    })
    return decode(value)
  }
  function visible(node: ts.Expression, owner: ts.Block) {
    if (ts.isStringLiteral(node) && isProse(node.text)) replace(node,`uiText(${register(node.text)})`,owner)
    else if (ts.isConditionalExpression(node)) { visible(node.whenTrue,owner); visible(node.whenFalse,owner) }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) visible(node.right,owner)
    // Templates containing expressions need semantic interpolation review; do not
    // turn arbitrary runtime strings, contract data or identifiers into UI copy.
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'uiText' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) register(node.arguments[0].text)
    const owner=component(node)
    if (owner) {
      if(ts.isJsxText(node)) {
        const value=jsxValue(node.text), trimmed=value.trim()
        if(isProse(trimmed)) {
          // JsxText getStart excludes leading whitespace; replace the full span.
          const prefix=value.startsWith(' ')?'{" "}':''
          const suffix=value.endsWith(' ')?'{" "}':''
          edits.push({start:node.pos,end:node.end,value:`${prefix}{uiText(${register(trimmed)})}${suffix}`})
          owners.add(owner);extracted++
        }
      }
      if(ts.isJsxAttribute(node) && /^(title|placeholder|aria-label|alt|label|helperText)$/.test(node.name.getText(ast)) && node.initializer && ts.isStringLiteral(node.initializer) && isProse(node.initializer.text)) replace(node.initializer,`{uiText(${register(decode(node.initializer.text))})}`,owner)
      if(ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent)||ts.isJsxFragment(node.parent))) visible(node.expression,owner)
    }
    ts.forEachChild(node,visit)
  }
  visit(ast)
  if (!edits.length) continue
  for(const owner of owners) {
    const hasTx=owner.statements.some(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(ast)==='uiText'))
    if(!hasTx) edits.push({start:owner.getStart(ast)+1,end:owner.getStart(ast)+1,value:'\n  const uiText = useUiTranslation()\n'})
  }
  for(const e of edits.sort((a,b)=>b.start-a.start)) source=source.slice(0,e.start)+e.value+source.slice(e.end)
  if(!source.includes('import { useUiTranslation }')) {
    let relative=path.relative(path.dirname(file),path.join(app,'src/mainview/i18n/ui')).replaceAll('\\','/')
    if(!relative.startsWith('.')) relative=`./${relative}`
    source=`import { useUiTranslation } from ${JSON.stringify(relative)}\n${source}`
  }
  if(write) fs.writeFileSync(file,source)
  changed++
}
if(write) fs.writeFileSync(catalogFile,JSON.stringify(Object.fromEntries(Object.entries(messages).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n')
console.log(JSON.stringify({write,changed,extracted,catalogMessages:Object.keys(messages).length}))
