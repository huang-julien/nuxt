import { pathToFileURL } from 'node:url'
import type { Component } from '@nuxt/schema'
import { parseURL } from 'ufo'
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import type { DocumentNode, ElementNode, Node as HtmlNode } from 'ultrahtml'
import { COMMENT_NODE, ELEMENT_NODE, parse as htmlParse, walk as htmlWalk, walkSync as htmlWalkSync } from 'ultrahtml'
import { basename, extname } from 'pathe'
import { pascalCase } from 'scule'

import { walk as estreeWalk } from 'estree-walker'
import type Acorn from 'acorn'
import type { ArrowFunctionExpression, CallExpression, Node as EstreeNode, Expression, FunctionDeclaration, Identifier, IfStatement, MemberExpression, Node, Program, Property, SimpleCallExpression, TemplateElement, TemplateLiteral } from 'estree'
import type { WalkerContext } from 'estree-walker/types/sync'
import { isVue } from '../core/utils'
import { isFunctionCallExpression } from './utils'
interface ServerOnlyComponentTransformPluginOptions {
  getComponents: () => Component[]
}

type AcornNode<N extends EstreeNode = EstreeNode> = N & { start: number, end: number }

enum NODE_TYPE {
  COMPONENT,
  FRAGMENT,
  TEMPLATE,
  ELEMENT,
  SLOT,
  // removed in build
  COMMENT,
  TEXT,
  // all invalid things
  NULL
}

type FRAGMENT_DECRIPTOR = {
  type: NODE_TYPE.FRAGMENT,
  // eslint-disable-next-line no-use-before-define
  children: NODE_DESCRIPTOR[],
  // eslint-disable-next-line no-use-before-define
  parentDescriptor: NODE_DESCRIPTOR | null
}

type SLOT_DESCRIPTOR = {
  type: NODE_TYPE.SLOT,
  // "any" need to be serialisable
  props?: Record<string, any>,
  for?: [string, string],
  name: string,
  // another tree -- fallback
  // eslint-disable-next-line no-use-before-define
  children: NODE_DESCRIPTOR[]

  // eslint-disable-next-line no-use-before-define
  parentDescriptor: COMPONENT_DESCRIPTOR
}

type TEMPLATE_DESCRIPTOR = {
  type: NODE_TYPE.TEMPLATE
  // eslint-disable-next-line no-use-before-define
  children: NODE_DESCRIPTOR[]
  // eslint-disable-next-line no-use-before-define
  parentDescriptor: ELEMENT_DESCRIPTOR | TEMPLATE_DESCRIPTOR | SLOT_DESCRIPTOR
}

type ELEMENT_DESCRIPTOR = {
  type: NODE_TYPE.ELEMENT
  // eslint-disable-next-line no-use-before-define
  children: NODE_DESCRIPTOR[]
  attrs: string
  name: string

  parentDescriptor: ELEMENT_DESCRIPTOR | TEMPLATE_DESCRIPTOR | SLOT_DESCRIPTOR
}

type INVALID_NODE = {
  type: NODE_TYPE.NULL
  // eslint-disable-next-line no-use-before-define
  parentDescriptor: NODE_DESCRIPTOR
}

type COMMENT_DESCRIPTOR = {
  type: NODE_TYPE.COMMENT,
  // no <!-- --> please, just the content
  content: string
  // eslint-disable-next-line no-use-before-define
  parentDescriptor: NODE_DESCRIPTOR
}

type COMPONENT_DESCRIPTOR = {
  type: NODE_TYPE.COMPONENT,
  // eslint-disable-next-line no-use-before-define
  children: NODE_DESCRIPTOR[],
  // eslint-disable-next-line no-use-before-define
  parentDescriptor: NODE_DESCRIPTOR
  // will be reinjected into the code, unmodified
  props: string
}

type TEXT_DESCRIPTOR = {
  type: NODE_TYPE.TEXT,
  content: string
}

type NODE_DESCRIPTOR = TEMPLATE_DESCRIPTOR | SLOT_DESCRIPTOR | ELEMENT_DESCRIPTOR | COMMENT_DESCRIPTOR | INVALID_NODE | TEXT_DESCRIPTOR | COMPONENT_DESCRIPTOR | FRAGMENT_DECRIPTOR

const SCRIPT_RE = /<script[^>]*>/g

const htmltags = [
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'audio',
  'b',
  

]

export const islandsTransform = createUnplugin((options: ServerOnlyComponentTransformPluginOptions) => {
  return {
    name: 'server-only-component-transform',
    enforce: 'pre',
    transformInclude(id) {
      const components = options.getComponents()
      const islands = components.filter(component =>
        component.island || (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client'))
      )
      const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return islands.some(c => c.filePath === pathname)
    },
    async transform(code, id) {
      if (!code.includes('<slot ')) { return }
      const template = code.match(/<template>([\s\S]*)<\/template>/)
      if (!template) { return }

      const s = new MagicString(code)

      s.replace(SCRIPT_RE, (full) => {
        return full + '\nimport { vforToArray as __vforToArray } from \'#app/components/utils\''
      })

      const ast = parse(template[0])
      await walk(ast, (node) => {
        if (node.type === ELEMENT_NODE && node.name === 'slot') {
          const { attributes, children, loc, isSelfClosingTag } = node
          const slotName = attributes.name ?? 'default'
          let vfor: [string, string] | undefined
          if (attributes['v-for']) {
            vfor = attributes['v-for'].split(' in ').map((v: string) => v.trim()) as [string, string]
            delete attributes['v-for']
          }
          if (attributes.name) { delete attributes.name }
          if (attributes['v-bind']) {
            attributes._bind = attributes['v-bind']
            delete attributes['v-bind']
          }
          const bindings = getBindings(attributes, vfor)

          if (isSelfClosingTag) {
            s.overwrite(loc[0].start, loc[0].end, `<div style="display: contents;" nuxt-ssr-slot-name="${slotName}" ${bindings}/>`)
          } else {
            s.overwrite(loc[0].start, loc[0].end, `<div style="display: contents;" nuxt-ssr-slot-name="${slotName}" ${bindings}>`)
            s.overwrite(loc[1].start, loc[1].end, '</div>')

            if (children.length > 1) {
              // need to wrap instead of applying v-for on each child
              const wrapperTag = `<div ${vfor ? `v-for="${vfor[0]} in ${vfor[1]}"` : ''} style="display: contents;">`
              s.appendRight(loc[0].end, `<div nuxt-slot-fallback-start="${slotName}"/>${wrapperTag}`)
              s.appendLeft(loc[1].start, '</div><div nuxt-slot-fallback-end/>')
            } else if (children.length === 1) {
              if (vfor && children[0].type === ELEMENT_NODE) {
                const { loc, name, attributes, isSelfClosingTag } = children[0]
                const attrs = Object.entries(attributes).map(([attr, val]) => `${attr}="${val}"`).join(' ')
                s.overwrite(loc[0].start, loc[0].end, `<${name} v-for="${vfor[0]} in ${vfor[1]}" ${attrs} ${isSelfClosingTag ? '/' : ''}>`)
              }

              s.appendRight(loc[0].end, `<div nuxt-slot-fallback-start="${slotName}"/>`)
              s.appendLeft(loc[1].start, '<div nuxt-slot-fallback-end/>')
            }
          }
        }
      })

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: s.generateMap({ source: id, includeContent: true })
        }
      }
    }
  }
})

function isBinding(attr: string): boolean {
  return attr.startsWith(':')
}

function getBindings(bindings: Record<string, string>, vfor?: [string, string]): string {
  if (Object.keys(bindings).length === 0) { return '' }
  const content = Object.entries(bindings).filter(b => b[0] !== '_bind').map(([name, value]) => isBinding(name) ? `${name.slice(1)}: ${value}` : `${name}: \`${value}\``).join(',')
  const data = bindings._bind ? `mergeProps(${bindings._bind}, { ${content} })` : `{ ${content} }`
  if (!vfor) {
    return `:nuxt-ssr-slot-data="JSON.stringify([${data}])"`
  } else {
    return `:nuxt-ssr-slot-data="JSON.stringify(__vforToArray(${vfor[1]}).map(${vfor[0]} => (${data})))"`
  }
}

/**
 * this plugin transforms all components server side to add the ability to render a tree
 */
export const serverComponentTransform = createUnplugin((options: { chunks: Set<string>, getComponents: () => Component[] }) => {
  // parser regex -> parse tag + attributes + the content following until the next tag (closing or not)
  const TEMPLATE_SPLIT_RE = /(<([a-z]*)([^>]*)>([^<]*))/gm
  // split tag and content
  const TAG_CONTENT_RE = /<\/?([^>]*)>([^<]*)/gm
  // split the tag name and the attributes
  // note: it split expression such as `<input${_ssrRenderAttributes(...)}>`
  const TAG_ATTRS_RE = /(<([a-z]*)([^>]*)>)/gm

  return {
    name: 'nuxt:server:component:assets',

    enforce: 'post',

    transformInclude(id) {
      const components = options.getComponents()
      const islands = components.filter(component =>
        component.island || (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client'))
      )
      const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return islands.some(c => c.filePath === pathname)
    },

    async transform(code, id) {
      debugger
      const ast = this.parse(code) as Acorn.Node & Program
      const s = new MagicString(code)
      const ssrRenderFunction = ast.body.find(node => node.type === 'FunctionDeclaration' && ['_sfc_render', '_ssrRender', '_sfc_ssrRender'].includes(node.id?.name as string))

      try {
        if (ssrRenderFunction) {
          debugger

          const mainBuffer: string[] = []

          function handleIfElse(node: IfStatement): string[] {
            const buffer = []
            if (node.type === 'IfStatement') {
              buffer.push(
                `<v-if test="${getCodeSlice(code, node.test as AcornNode)}">`
              )

              estreeWalk(node, {
                enter(node) {
                  if (node.type === 'CallExpression') {
                    buffer.push(...handlePushFunction(node as SimpleCallExpression))
                    this.skip()
                  } else if (node.type === 'IfStatement') {
                    buffer.push(...handleIfElse(node as IfStatement))
                    this.skip()
                  }
                }
              })

              buffer.push(
                '</v-if>'
              )
            }

            return buffer
          }

          function handlePushFunction(node: SimpleCallExpression): string[] {
            const buffer: string[] = []
            if (node.type === 'CallExpression' && (node.callee as Identifier).name === '_push') {
              const [toPush] = node.arguments
              if (toPush.type === 'TemplateLiteral') {
                // SimpleCallExpression is used because we don't expect a NewExpression
                const templateComposition = [...toPush.expressions, ...toPush.quasis].sort((_a, _b) => {
                  const a = _a as AcornNode
                  const b = _b as AcornNode
                  return a.start - b.start
                })
                const part = templateComposition.map((_node) => {
                  const node = _node as AcornNode

                  return node.type === 'CallExpression' ? `\${${getCodeSlice(code, node)}}` : node.value.raw
                }).join('')

                buffer.push(part)
              } else if (toPush.type === 'CallExpression') {
                // SimpleExpression we don't expect any new expression in a push function
                const expression = toPush as AcornNode<SimpleCallExpression>

                buffer.push(`\${${getCodeSlice(code, expression)}}`)
              }
            }
            return buffer
          }

          function handleSsrRenderList(node: SimpleCallExpression): string[] {
            if (node.callee.type !== 'Identifier' || node.callee.name !== '_ssrRenderList') {
              throw new Error('handleSsrRenderList cannot transform non _ssrRenderList calls')
            }
            const buffer: string[] = []
            const [leftArg, _callback] = node.arguments as AcornNode[]
            // parse left right as in `for (const test in tests) {...}`
            const callback = _callback as ArrowFunctionExpression

            buffer.push(`<v-for left="${getCodeSlice(code, leftArg)}" right="${getCodeSlice(code, callback.params[0] as AcornNode)}">`)

            estreeWalk(callback.body, {
              enter(node) {
                if (node.type === 'CallExpression') {
                  if (node.callee.type === 'Identifier') {
                    if (node.callee.name === '_push') {
                      buffer.push(...handlePushFunction(node as SimpleCallExpression))
                      this.skip()
                    } else if (node.callee.name === '_ssrRenderList') {
                      buffer.push(...handleSsrRenderList(node as SimpleCallExpression))
                      this.skip()
                    }
                  }
                } else if (node.type === 'IfStatement') {
                  buffer.push(...handleIfElse(node as IfStatement))
                  this.skip()
                }
              }
            })

            buffer.push('</v-for>')
            return buffer
          }

          // reconstruct an html compatible string to be walked by ultrahtml
          estreeWalk(ast, {
            enter(node) {
              if (node.type === 'CallExpression') {
                if (node.callee.type === 'Identifier') {
                  if (node.callee.name === '_push') {
                    mainBuffer.push(...handlePushFunction(node as SimpleCallExpression))
                    this.skip()
                  } else if (node.callee.name === '_ssrRenderList') {
                    mainBuffer.push(...handleSsrRenderList(node as SimpleCallExpression))
                    this.skip()
                  }
                }
              } else if (node.type === 'IfStatement') {
                mainBuffer.push(...handleIfElse(node as IfStatement))
                this.skip()
              }
            }
          })
          console.log(mainBuffer, id)
          const html = mainBuffer.join('').replaceAll(/<(?!\/)([a-z]*)([^>]*)>/g, (_full, tag, content) => {
            // add space to <div${_ssrRenderAttrs(_attrs)}>
            return `<${tag} ${content}>`
          })

          const htmlAst = htmlParse(html) as DocumentNode



          console.log(htmlAst)
          debugger
        }
      } catch (e) {
        console.log(e, id)
        debugger
      }
    }
  }
})

function getCodeSlice(str: string, node: AcornNode) {
  return str.slice(node.start, node.end)
}

/**
 * all items of the buffer are rendered with a `_push` fn
 */
function htmlAstToRenderFunction(ast: DocumentNode) {
  const buffer = []
  const children = (ast.children ?? []) as HtmlNode[]

  for (const child of children) {
    switch (child.type) {
      case ELEMENT_NODE:
        buffer.push(...elementNodeToRender(child))
        break
    }
  }

  return buffer
}

function elementNodeToRender(ast: ElementNode): string[] {
  const buffer: string[] = []

  if()

  return buffer
}