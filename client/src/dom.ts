// Маленький типізований помічник для створення DOM-елементів.
// el('input', { maxLength: 16 }) повертає HTMLInputElement, і TypeScript перевіряє,
// що в input справді є властивість maxLength (а в div — ні).
type Props<K extends keyof HTMLElementTagNameMap> = Omit<Partial<HTMLElementTagNameMap[K]>, 'style'> & {
  style?: string // інлайн-стиль рядком (у DOM style — об'єкт CSSStyleDeclaration)
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K>,
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props) {
    const { style, ...rest } = props
    Object.assign(node, rest)
    if (style) node.setAttribute('style', style)
  }
  for (const child of children) node.append(child)
  return node
}
