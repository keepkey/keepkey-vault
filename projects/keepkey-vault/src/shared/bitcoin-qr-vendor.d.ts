declare module 'process/browser' {
  const process: { env: Record<string, string | undefined>; nextTick: (callback: (...args: any[]) => void, ...args: any[]) => void }
  export default process
}
