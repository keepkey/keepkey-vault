// Run from the repository root with bun. Uses installed packages, no device or network.
import fs from 'node:fs'
import i18next from '../../../projects/keepkey-vault/node_modules/i18next'
import { formatFiat } from '../../../projects/keepkey-vault/src/shared/fiat'
import { formatBalance } from '../../../projects/keepkey-vault/src/mainview/lib/formatting'

const localeRoot = 'projects/keepkey-vault/src/mainview/i18n/locales'
const resources = Object.fromEntries(fs.readdirSync(localeRoot).map(lang => [lang,
  Object.fromEntries(fs.readdirSync(`${localeRoot}/${lang}`).filter(x=>x.endsWith('.json')).map(file=>[
    file.slice(0,-5), JSON.parse(fs.readFileSync(`${localeRoot}/${lang}/${file}`,'utf8')),
  ])),
]))
const i18n=i18next.createInstance()
await i18n.init({resources,lng:'en',fallbackLng:'en',defaultNS:'common',interpolation:{escapeValue:false}})
const languageChecks=[]
for(const lang of Object.keys(resources)) {
  await i18n.changeLanguage(lang)
  languageChecks.push({lang,cancel:i18n.t('cancel'),customFee:i18n.t('customFeeHint',{ns:'send'}),
    missingWarning:i18n.t('firmware.installWipe.wipeTitle',{ns:'setup',defaultValue:'This will wipe the device'}),
    plurals:[1,2,5,21].map(count=>({count,category:new Intl.PluralRules(lang).select(count),asset:i18n.t('tokenCount',{ns:'asset',count}),showFiltered:i18n.t('showFiltered',{ns:'asset',count}),dashboard:i18n.t('tokensCount',{ns:'dashboard',count})})),
    storedBlindSignCaveat:i18n.t('blindSignCaveat',{ns:'swap'}),
  })
}
const currencyChecks=(['USD','EUR','BRL','JPY'] as const).map(currency=>({inputUsd:100,currency,output:formatFiat(100,currency,'en-US')}))
const balanceChecks=['0.1234','12.34','1234.56'].map(value=>({value,locale:'de-DE',output:formatBalance(value,'de-DE')}))
const inputChecks=['0,5','1,5','1.234,56','1\u202f234,56'].map(input=>({input,parseFloat:parseFloat(input)}))
const usdInputCheck={input:'1,5',pricePerUnitUsd:100,cryptoAmountFromSendFormHandler:(parseFloat('1,5')/100).toPrecision(8)}
const result={scope:'Isolated calls to installed i18next with all catalogs preloaded, and production formatting helpers; does not exercise Vite lazy-loading or the UI. USD input check reproduces the handler arithmetic.',languageChecks,currencyChecks,balanceChecks,inputChecks,usdInputCheck}
fs.writeFileSync('docs/handoffs/i18n-audit-20261104/runtime-results.json',JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({currencyChecks,balanceChecks,inputChecks,ru:languageChecks.find(x=>x.lang==='ru'),pl:languageChecks.find(x=>x.lang==='pl')},null,2))
