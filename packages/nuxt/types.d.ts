/// <reference types="nitropack" />
export * from './dist/index'

import type { SchemaDefinition } from 'nuxt/schema'

declare global {
  const defineNuxtConfig: typeof import('nuxt/config')['defineNuxtConfig']
  const defineNuxtSchema: (schema: SchemaDefinition) => SchemaDefinition
}

declare module 'nitropack' {
  interface NitroRouteConfig {
    ssr?: boolean
    noScripts?: boolean
  }
  interface NitroRouteRules {
    ssr?: boolean
    noScripts?: boolean
  }
}
