import type { VNode, RendererNode } from 'vue'
import { nextTick, h, Fragment, defineComponent, createStaticVNode, computed, ref, watch, getCurrentInstance, Teleport, onMounted, createVNode } from 'vue'

import { debounce } from 'perfect-debounce'
import { hash } from 'ohash'
import { appendHeader } from 'h3'
import { useHead } from '@unhead/vue'
import { randomUUID } from 'uncrypto'
// eslint-disable-next-line import/no-restricted-paths
import type { NuxtIslandResponse } from '../../core/runtime/nitro/renderer'
import { useNuxtApp } from '#app/nuxt'
import { useRequestEvent } from '#app/composables/ssr'

const pKey = '_islandPromises'
const SSR_UID_RE = /nuxt-ssr-component-uid="([^"]*)"/

export default defineComponent({
  name: 'NuxtIsland',
  props: {
    name: {
      type: String,
      required: true
    },
    props: {
      type: Object,
      default: () => undefined
    },
    context: {
      type: Object,
      default: () => ({})
    }
  },
  async setup (props, { slots }) {
    const nuxtApp = useNuxtApp()
    const hashId = computed(() => hash([props.name, props.props, props.context]))
    const instance = getCurrentInstance()!
    const event = useRequestEvent()
    const mounted = ref(false)
    const key = ref(0)
    onMounted(() => { mounted.value = true })
    const html = ref<string>(process.client ? getFragmentHTML(instance.vnode?.el ?? null).join('') ?? '<div></div>' : '<div></div>')
    const uid = ref<string>(html.value.match(SSR_UID_RE)?.[1] ?? randomUUID())
    function setUid () {
      uid.value = html.value.match(SSR_UID_RE)?.[1] as string
    }
    const cHead = ref<Record<'link' | 'style', Array<Record<string, string>>>>({ link: [], style: [] })
    useHead(cHead)
    const slotProps = computed(() => {

      return {}
    })

    function _fetchComponent () {
      const url = `/__nuxt_island/${props.name}:${hashId.value}`
      if (process.server && process.env.prerender) {
        // Hint to Nitro to prerender the island component
        appendHeader(event, 'x-nitro-prerender', url)
      }
      // TODO: Validate response
      return $fetch<NuxtIslandResponse>(url, {
        params: {
          ...props.context,
          props: props.props ? JSON.stringify(props.props) : undefined,
          slotsName: JSON.stringify(Object.keys(slots))
        }
      })
    }

    async function fetchComponent () {
      nuxtApp[pKey] = nuxtApp[pKey] || {}
      if (!nuxtApp[pKey][uid.value]) {
        nuxtApp[pKey][uid.value] = _fetchComponent().finally(() => {
          delete nuxtApp[pKey]![uid.value]
        })
      }
      const res: NuxtIslandResponse = await nuxtApp[pKey][uid.value]
      cHead.value.link = res.head.link
      cHead.value.style = res.head.style
      html.value = res.html
      key.value++
      if (process.client) {
        // must await next tick for Teleport to work correctly with static node re-rendering
        await nextTick()
      }
      setUid()
    }

    if (process.client) {
      watch(props, debounce(fetchComponent, 100))
    }

    if (process.server || !nuxtApp.isHydrating) {
      await fetchComponent()
    }
    return () => {
      // bypass hydration
      if (!mounted.value && process.client && !html.value) {
        html.value = getFragmentHTML(instance.vnode.el).join('')
        setUid()
        return [getStaticVNode(instance.vnode)]
      }
      const nodes = [createVNode(Fragment, {
        key: key.value
      }, [h(createStaticVNode(html.value, 1))])]
      if (uid.value) {
        for (const slot in slots) {
          nodes.push(createVNode(Teleport, { to: process.client ? `[nuxt-ssr-component-uid='${uid.value}'] [ssr-slot-name='${slot}']` : `uid=${uid.value};slot=${slot}` }, {
            default: () => [slots[slot]?.()]
          }))
        }
      }
      return nodes
    }
  }
})

// TODO refactor with https://github.com/nuxt/nuxt/pull/19231
function getStaticVNode (vnode: VNode) {
  const fragment = getFragmentHTML(vnode.el)

  if (fragment.length === 0) {
    return null
  }
  return createStaticVNode(fragment.join(''), fragment.length)
}

function getFragmentHTML (element: RendererNode | null) {
  if (element) {
    if (element.nodeName === '#comment' && element.nodeValue === '[') {
      return getFragmentChildren(element)
    }
    return [element.outerHTML]
  }
  return []
}

function getFragmentChildren (element: RendererNode | null, blocks: string[] = []) {
  if (element && element.nodeName) {
    if (isEndFragment(element)) {
      return blocks
    } else if (!isStartFragment(element)) {
      blocks.push(element.outerHTML)
    }

    getFragmentChildren(element.nextSibling, blocks)
  }
  return blocks
}

function isStartFragment (element: RendererNode) {
  return element.nodeName === '#comment' && element.nodeValue === '['
}

function isEndFragment (element: RendererNode) {
  return element.nodeName === '#comment' && element.nodeValue === ']'
}
