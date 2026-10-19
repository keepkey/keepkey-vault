/** Initialize the browser APIs required by the UR library before it is evaluated. */
import { Buffer } from 'buffer'
import browserProcess from 'process/browser'
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer
if (!(globalThis as any).process) (globalThis as any).process = browserProcess
