import { computed, defineComponent, h, provide, reactive, onMounted, nextTick, Suspense, Transition, watch, getCurrentInstance, shallowRef } from 'vue'
import type { VNode, KeepAliveProps, TransitionProps, Ref } from 'vue'
import { RouterView } from 'vue-router'
import { defu } from 'defu'
import type { RouteLocationNormalized, RouteLocationNormalizedLoaded, RouteLocation } from 'vue-router'

import type { RouterViewSlotProps } from './utils'
import { generateRouteKey, wrapInKeepAlive } from './utils'
import { useNuxtApp } from '#app/nuxt'
import { _wrapIf } from '#app/components/utils'
// @ts-ignore
import { appPageTransition as defaultPageTransition, appKeepalive as defaultKeepaliveConfig } from '#build/nuxt.config.mjs'

export default defineComponent({
  name: 'NuxtPage',
  inheritAttrs: false,
  props: {
    name: {
      type: String
    },
    transition: {
      type: [Boolean, Object] as any as () => boolean | TransitionProps,
      default: undefined
    },
    keepalive: {
      type: [Boolean, Object] as any as () => boolean | KeepAliveProps,
      default: undefined
    },
    route: {
      type: Object as () => RouteLocationNormalized
    },
    pageKey: {
      type: [Function, String] as unknown as () => string | ((route: RouteLocationNormalizedLoaded) => string),
      default: null
    }
  },
  setup (props, { attrs }) {
    const nuxtApp = useNuxtApp()

    const vnode: Ref<VNode| null> = shallowRef(null)

    const instance = getCurrentInstance()!

    // forward the exposed data from the route component
    watch(vnode, async (vnode) => {
      // await 2 ticks - one for this component and another for the RouteProvider's nextTick
      await nextTick()
      await nextTick()
      if (vnode && vnode.component && vnode.component.exposed) {
        instance.exposed = vnode.component.exposed
      } else {
        instance.exposed = null
      }
      instance.parent?.update()
    })

    return () => {
      return h(RouterView, { name: props.name, route: props.route, ...attrs }, {
        default: (routeProps: RouterViewSlotProps) => {
          if (!routeProps.Component) { return }

          const key = generateRouteKey(routeProps, props.pageKey)
          const done = nuxtApp.deferHydration()

          const hasTransition = !!(props.transition ?? routeProps.route.meta.pageTransition ?? defaultPageTransition)
          const transitionProps = hasTransition && _mergeTransitionProps([
            props.transition,
            routeProps.route.meta.pageTransition,
            defaultPageTransition,
            { onAfterLeave: () => { nuxtApp.callHook('page:transition:finish', routeProps.Component) } }
          ].filter(Boolean))

          return _wrapIf(Transition, hasTransition && transitionProps,
            wrapInKeepAlive(props.keepalive ?? routeProps.route.meta.keepalive ?? (defaultKeepaliveConfig as KeepAliveProps), h(Suspense, {
              onPending: () => nuxtApp.callHook('page:start', routeProps.Component),
              onResolve: () => { nextTick(() => nuxtApp.callHook('page:finish', routeProps.Component).finally(done)) }
            }, {
              default: () => {
                vnode.value = h(RouteProvider, { key, routeProps, pageKey: key, hasTransition } as {})
                return vnode.value
              }
            })
            )).default()
        }
      })
    }
  }
})

function _toArray (val: any) {
  return Array.isArray(val) ? val : (val ? [val] : [])
}

function _mergeTransitionProps (routeProps: TransitionProps[]): TransitionProps {
  const _props: TransitionProps[] = routeProps.map(prop => ({
    ...prop,
    onAfterLeave: _toArray(prop.onAfterLeave)
  }))
  // @ts-ignore
  return defu(..._props)
}

const RouteProvider = defineComponent({
  name: 'RouteProvider',
  // TODO: Type props
  // eslint-disable-next-line vue/require-prop-types
  props: ['routeProps', 'pageKey', 'hasTransition'],
  setup (props) {
    // Prevent reactivity when the page will be rerendered in a different suspense fork
    // eslint-disable-next-line vue/no-setup-props-destructure
    const previousKey = props.pageKey
    // eslint-disable-next-line vue/no-setup-props-destructure
    const previousRoute = props.routeProps.route

    // Provide a reactive route within the page
    const route = {} as RouteLocation
    for (const key in props.routeProps.route) {
      (route as any)[key] = computed(() => previousKey === props.pageKey ? props.routeProps.route[key] : previousRoute[key])
    }

    provide('_route', reactive(route))

    const vnode: Ref<VNode| null> = shallowRef(null)

    // forward the exposed data from the route component
    const instance = getCurrentInstance()!
    watch(vnode, async (vnode) => {
      await nextTick()
      if (vnode && vnode.component && vnode.component.exposed) {
        instance.exposed = vnode.component.exposed
      } else {
        instance.exposed = null
      }
    })

    if (process.dev && process.client && props.hasTransition) {
      onMounted(() => {
        nextTick(() => {
          if (['#comment', '#text'].includes(vnode.value?.el?.nodeName)) {
            const filename = (vnode.value?.type as any).__file
            console.warn(`[nuxt] \`${filename}\` does not have a single root node and will cause errors when navigating between routes.`)
          }
        })
      })
    }

    return () => {
      vnode.value = h(props.routeProps.Component)
      return vnode.value
    }
  }
})
