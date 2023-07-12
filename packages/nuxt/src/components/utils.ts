import type { CallExpression, Node } from 'estree'

export function isFunctionCallExpression (node: Node, functionName: string): node is CallExpression {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === functionName
}
