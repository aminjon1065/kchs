/**
 * Поля стиля — общие с сервером тайлов: одно определение в контракте LayerStyle
 * (ADR-0064, ADR-0065), чтобы тайл нёс ровно те поля, что читает стиль.
 */
export {
  LAYER_CLUSTER_COUNT_FIELD as CLUSTER_COUNT_FIELD,
  layerStyleTileFields as styleTileFields,
  layerTemplateFields as templateFields,
} from '@kchs/contracts'
