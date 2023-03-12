<template>
  <Suspense @resolve="onResolve">
    <ErrorComponent v-if="error" :error="error" />
    <IslandRenderer v-else-if="islandContext" :context="islandContext" />
    <AppComponent v-else />
  </Suspense>
</template>

<script setup>
import { defineAsyncComponent, onErrorCaptured, onServerPrefetch, provide, getCurrentInstance } from 'vue'
import  cacheTest,{ setTest, nuxtAppSet, nuxtappCache  } from '#app/components/cachetest'
import { callWithNuxt } from '#app/nuxt'
import { isNuxtError, showError, useError } from '#app/composables/error'
import { useRoute } from '#app/composables/router'
import AppComponent from '#build/app-component.mjs'
const vm = getCurrentInstance()
cacheTest.push(vm.appContext.app.$nuxt)
setTest.add(vm.appContext.app.$nuxt)
console.log(setTest.size, cacheTest.length, 'array -- set of nuxt app of the current instance in nuxt-root')
const nuxtApp = useNuxtApp()
nuxtappCache.push(nuxtApp)
nuxtAppSet.add(nuxtApp)
console.log( nuxtappCache.length, nuxtAppSet.size, 'array -- set of nuxt app instance in nuxt-root')


const ErrorComponent = defineAsyncComponent(() => import('#build/error-component.mjs').then(r => r.default || r))
const IslandRenderer = process.server
  ? defineAsyncComponent(() => import('./island-renderer').then(r => r.default || r))
  : () => null

const onResolve = nuxtApp.deferHydration()

// Inject default route (outside of pages) as active route
provide('_route', useRoute())

// vue:setup hook
const results = nuxtApp.hooks.callHookWith(hooks => hooks.map(hook => hook()), 'vue:setup')
if (process.dev && results && results.some(i => i && 'then' in i)) {
  console.error('[nuxt] Error in `vue:setup`. Callbacks must be synchronous.')
}

// error handling
const error = useError()
onErrorCaptured((err, target, info) => {
  nuxtApp.hooks.callHook('vue:error', err, target, info).catch(hookError => console.error('[nuxt] Error in `vue:error` hook', hookError))
  if (process.server || (isNuxtError(err) && (err.fatal || err.unhandled))) {
    const p = callWithNuxt(nuxtApp, showError, [err])
    onServerPrefetch(() => p)
  }
})

// Component islands context
const { islandContext } = process.server && nuxtApp.ssrContext
</script>
