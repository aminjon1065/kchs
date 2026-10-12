import { describe, expect, it } from 'vitest'
import { childNamed, childText, decodeEntities, parseXml, textOf, XmlError } from './xml.js'

describe('разбор XML (ADR-0201)', () => {
  it('элементы, атрибуты, текст и CDATA; префиксы пространств имён отбрасываются', () => {
    const root = parseXml(
      '<?xml version="1.0"?><cap:alert xmlns:cap="urn:x"><cap:note a=\'1\' b="&lt;2&gt;">x &amp; y</cap:note><cap:d><![CDATA[<b>как есть</b>]]></cap:d><e/></cap:alert>',
    )
    expect(root.name).toBe('alert')
    const note = childNamed(root, 'note')
    expect(note?.attributes).toEqual({ a: '1', b: '<2>' })
    expect(textOf(note)).toBe('x & y')
    expect(childText(root, 'd')).toBe('<b>как есть</b>')
    expect(childNamed(root, 'e')).toMatchObject({ name: 'e', children: [] })
  })

  it('свои сущности документа не раскрываются: DOCTYPE пропускается целиком', () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<alert><note>&lol2;</note><secret>&xxe;</secret></alert>`
    const root = parseXml(bomb)
    expect(childText(root, 'note')).toBe('&lol2;')
    expect(childText(root, 'secret')).toBe('&xxe;')
  })

  it('числовые ссылки на символы — только допустимые символы XML', () => {
    expect(decodeEntities('&#1044;&#x0430; &#0; &#xD800; &bogus;')).toBe('Да &#0; &#xD800; &bogus;')
  })

  it('битый документ — понятная ошибка, а не зависание', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError)
    expect(() => parseXml('<a>')).toThrow(XmlError)
    expect(() => parseXml('просто текст')).toThrow(XmlError)
    const deep = `${'<a>'.repeat(100)}${'</a>'.repeat(100)}`
    expect(() => parseXml(deep)).toThrow(/вложенность/)
  })
})
