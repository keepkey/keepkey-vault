// The OpenAPI spec served at /spec/swagger.json and rendered by /docs.
// Imported, not read from disk: the packaged backend is one bundled file, so a swagger.json next to it never existed and
// /docs showed no endpoints (audit v6 D1). The bundler inlines this import.
import swaggerSpec from './swagger.json'

let serialized: string | null = null

/** The spec as JSON text, serialized once. */
export function swaggerJson(): string {
  if (!serialized) serialized = JSON.stringify(swaggerSpec)
  return serialized
}
