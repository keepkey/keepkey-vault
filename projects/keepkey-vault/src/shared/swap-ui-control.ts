/** An in-flight operation and its submitted receipt own their inputs. API
 * callers must close the receipt and open a new swap before editing again. */
export function blocksSwapUiCommand(phase: string | undefined, command: string): boolean {
  return ['approving', 'signing', 'broadcasting', 'submitted'].includes(phase || '')
    && ['open', 'set', 'requote', 'advance', 'confirm'].includes(command)
}
