import { describe, expect, it } from 'vitest'
import { type PanelLayer, panelBlocks } from './layer-panel.js'

const layer = (id: string, group: string | null): PanelLayer => ({
  entry: { layerId: id, visible: true, opacity: 1, group },
  layer: null,
  missing: false,
})

describe('дерево слоёв карты (ADR-0160)', () => {
  it('соседние слои одной группы — один узел, остальные — сами по себе', () => {
    const blocks = panelBlocks([
      layer('a', 'Реки'),
      layer('b', 'Реки'),
      layer('c', null),
      layer('d', 'Дороги'),
      layer('e', 'Реки'),
    ])
    expect(
      blocks.map((block) =>
        block.kind === 'layer'
          ? block.item.entry.layerId
          : `${block.name}:${block.items.map(({ item }) => item.entry.layerId).join('')}`,
      ),
    ).toEqual(['Реки:ab', 'c', 'Дороги:d', 'Реки:e'])
    // Индексы — позиции в панели: первая и последняя строки для «Выше»/«Ниже»
    const last = blocks[3]
    expect(last?.kind === 'group' ? last.items[0]?.index : null).toBe(4)
  })
})
