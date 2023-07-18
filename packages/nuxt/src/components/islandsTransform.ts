import { pathToFileURL } from 'node:url'
import type { Component } from '@nuxt/schema'
import { parseURL } from 'ufo'
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import type { ElementNode, Node as HtmlNode } from 'ultrahtml'
import { COMMENT_NODE, ELEMENT_NODE, parse, walk } from 'ultrahtml'
import { basename, extname } from 'pathe'
import { pascalCase } from 'scule'

import { walk as estreeWalk,  } from 'estree-walker'
import type Acorn from 'acorn'
import type { ArrowFunctionExpression, CallExpression, Node as EstreeNode, Expression, FunctionDeclaration, Identifier, MemberExpression, Node, Program, Property, SimpleCallExpression, TemplateElement, TemplateLiteral } from 'estree'
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
  children : NODE_DESCRIPTOR[],
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

export const islandsTransform = createUnplugin((options: ServerOnlyComponentTransformPluginOptions) => {
  return {
    name: 'server-only-component-transform',
    enforce: 'pre',
    transformInclude (id) {
      const components = options.getComponents()
      const islands = components.filter(component =>
        component.island || (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client'))
      )
      const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return islands.some(c => c.filePath === pathname)
    },
    async transform (code, id) {
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

function isBinding (attr: string): boolean {
  return attr.startsWith(':')
}

function getBindings (bindings: Record<string, string>, vfor?: [string, string]): string {
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

    transformInclude (id) {
      const components = options.getComponents()
      const islands = components.filter(component =>
        component.island || (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client'))
      )
      const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return islands.some(c => c.filePath === pathname)
    },

    async transform (code, id) {
      debugger
      const ast = this.parse(code) as Acorn.Node & Program
      const s = new MagicString(code)
      const ssrRenderFunction = ast.body.find(node => node.type === 'FunctionDeclaration' && ['_sfc_render', '_ssrRender', '_sfc_ssrRender'].includes(node.id?.name as string))

      try {
        if (ssrRenderFunction) {
          let isLastNodeClosed = false
          let currentNode: NODE_DESCRIPTOR = {
            type: NODE_TYPE.FRAGMENT,
            children: [], 
            parentDescriptor: null
          }
          const tree = currentNode

          /**
           * this function analyze the received string and can close a node
           */
          function htmlToTree (node: TemplateLiteral) {
            // SimpleCallExpression is used because we don't expect a NewExpression
            const templateComposition = [...node.expressions, ...node.quasis].sort((_a, _b) => {
              const a = _a as AcornNode<Expression|TemplateElement>
              const b = _b as AcornNode<Expression|TemplateElement>
              return a.start - b.start
            }) as Array<AcornNode<SimpleCallExpression>|AcornNode<TemplateElement>>
            const part = templateComposition.map(node => node.type === 'CallExpression' ? `\${${code.slice(node.start, node.end)}}` : node.value.raw).join('')

            // split the string between all tags
            const splitted = part.matchAll(TAG_CONTENT_RE)

            if (part === '<!--[-->' || part === '<!--]-->') {
              if (currentNode && 'children' in currentNode) {
                currentNode.children.push({
                  type: NODE_TYPE.COMMENT,
                  content: part === '<!--]-->' ? ']' : '[',
                  parentDescriptor: currentNode
                })
              }
            }
            debugger
            console.log(splitted)
            for (const part of splitted) {
              const [full, tagContent, content] = part

              if (!tagContent) { throw new Error('Parsing error: could not parse a tag from the content') }

              const splitTagAndAttrs = tagContent.match(/([a-z|-]*)(.*)?/)

              if (!splitTagAndAttrs) { throw new Error('Parsing error: could not parse a tag from its attributes') }
              const [_fullTagContent, tagName, attrs] = splitTagAndAttrs
              const isClosingTag = full.startsWith('</')

              if (isClosingTag) {
                if (isLastNodeClosed) {
                  currentNode = (currentNode as ELEMENT_DESCRIPTOR).parentDescriptor
                }
                isLastNodeClosed = true
              } else {
                const isNewChildrenNode = !isLastNodeClosed
                isLastNodeClosed = false
                if (!currentNode || !('children' in currentNode)) { throw new Error('Parsing error: could not parse a tag from its parent') }

                const descriptor: NODE_DESCRIPTOR = {
                  type: NODE_TYPE.ELEMENT,
                  name: tagName,
                  attrs,
                  children: [],
                  parentDescriptor: isNewChildrenNode ? currentNode : currentNode.parentDescriptor
                }

                if (isNewChildrenNode) {
                  currentNode.children.push(descriptor)
                  if (content) {
                    currentNode.children.push({
                      type: NODE_TYPE.TEXT,
                      content
                    })
                  }
                } else if (content) {
                  currentNode.parentDescriptor.children.push({
                    type: NODE_TYPE.TEXT,
                    content
                  })
                }
              }
            }
          }

          /**
           * ssrComponent to tree
           *
           * @param expression {SimpleCallExpression} `ssrRenderComponent` call expression
           */
          function componentToTree (expression: SimpleCallExpression) {
            const [_, propsAst, childrenAst] = expression.arguments
            const descriptor: COMPONENT_DESCRIPTOR = {
              type: NODE_TYPE.COMPONENT,
              children: [],
              props: code.slice((propsAst as AcornNode).start, (propsAst as AcornNode).end),
              parentDescriptor: currentNode
            }

            currentNode = descriptor

            if (childrenAst.type === 'ObjectExpression') {
              for (const slotName in childrenAst.properties) {
                // _withCtx((_, _push, _parent, _scopeId) => { push() })
                const slotAst = childrenAst.properties[slotName] as Property

                if (slotAst.value.type === 'CallExpression') {
                  const slotFnAst = slotAst.value.arguments[0] as ArrowFunctionExpression
                  componentChildrenToTree(slotName, slotFnAst)
                } else if ((slotAst.value.type === 'ArrowFunctionExpression')) {
                  componentChildrenToTree(slotName, slotAst.value)
                }
              }
            }
          }

          function componentChildrenToTree (slotName: string, fnAst: ArrowFunctionExpression | FunctionDeclaration) {
            if (currentNode.type !== NODE_TYPE.COMPONENT) {
              throw new Error('Somehting went wrong when converting a component into a tree')
            }

            const slotDescriptor: SLOT_DESCRIPTOR = {
              type: NODE_TYPE.SLOT,
              children: [],
              name: slotName,
              parentDescriptor: currentNode
            }

            currentNode.children.push(slotDescriptor)

            currentNode = slotDescriptor

            estreeWalk(fnAst.body, {
              enter: (_node) => {
                const node = _node as unknown as AcornNode<Node>
                // we only analyze sfc render function from vue compiler which prepends a _
                if (isFunctionCallExpression(node, '_push')) {
                  pushFunctionToTree(node as SimpleCallExpression)
                }
              }
            })

            currentNode = slotDescriptor.parentDescriptor
          }

          /**
           * analyze a push function
           */
          function pushFunctionToTree (node: SimpleCallExpression) {
            // push only have a single argument
            const arg = node.arguments[0]

            // -> `<div>${_ssrRender()}</div>`
            if (arg.type === 'TemplateLiteral') {
              htmlToTree(arg)
            } else if (arg.type === 'CallExpression') {
              // never seen a NewExpression
              componentToTree(node as SimpleCallExpression)
            }
          }

          estreeWalk(ast, {
            enter: (_node) => {
              const node = _node as AcornNode<EstreeNode>
              // we only analyze sfc render function from vue compiler which prepends a _
              if (isFunctionCallExpression(node, '_push')) {
                pushFunctionToTree(node)
              }
            }
          })
          console.log(tree, id)
          debugger
        }
      } catch (e) {
        console.log(e, id)
        debugger
      }
    }
  }
})
