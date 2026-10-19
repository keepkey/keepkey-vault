/** Verify hardware evidence using the installed Sparrow application's library.
 * jimage extract --dir /tmp/sparrow-classes /path/to/Sparrow/runtime/lib/modules
 * SPARROW_CLASSES=/tmp/sparrow-classes SPARROW_JDK=/path/to/jdk \
 *   bun scripts/test-btc-multisig-sparrow.ts EVIDENCE_DIR p2wsh
 * No USB, seeds, networking or broadcasts. */
import { readdirSync } from 'node:fs'
import { delimiter, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const classes=process.env.SPARROW_CLASSES,jdk=process.env.SPARROW_JDK,dir=process.argv[2],type=process.argv[3]
if(!classes||!jdk||!dir||!['p2wsh','p2sh-p2wsh','p2sh'].includes(type))throw Error('Set SPARROW_CLASSES and SPARROW_JDK; pass EVIDENCE_DIR and script type')
const root=resolve(dir),cp=[root,...readdirSync(classes).map(n=>join(classes,n))].join(delimiter)
execFileSync(join(jdk,'bin','javac'),['-cp',cp,'-d',root,join(dirname(fileURLToPath(import.meta.url)),'SparrowMultisigCheck.java')],{stdio:'inherit'})
execFileSync(join(jdk,'bin','java'),['-cp',cp,'SparrowMultisigCheck',root,type],{stdio:'inherit'})
