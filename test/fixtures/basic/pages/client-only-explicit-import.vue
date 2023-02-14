
<template>
  <div>
    <ClientOnlyScript class="client-only-script" foo="bar" />
    <LazyClientOnlySetupScript class="lazy-client-only-script-setup" foo="hello" />
    <TreeShakeThis />
    <ClientOnly>
      <DontTreeshakeThis />
    </ClientOnly>
    <DontTreeshakeThis />
  </div>
</template>

<script setup lang="ts">
import { ClientOnlyScript, LazyClientOnlySetupScript } from '#components'

const TreeShakeThis = defineAsyncComponent(() => import('./../components/ClientOnlyScript.client.vue'))

const DontTreeshakeThis = defineAsyncComponent(() => import('./../components/SugarCounter.vue'))
</script>
