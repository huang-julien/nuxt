import { defineComponent, h } from 'vue'
import NuxtIsland from '#app/components/nuxt-island'
// @ts-expect-error vfs 
import * as componentTrees from "#build/component-trees.mjs"

export const createServerComponent = (name: string) => {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup (_props, { attrs, slots }) {
      return () => h(NuxtIsland, {
        name,
        props: attrs
      }, slots)
    }
  })
}
