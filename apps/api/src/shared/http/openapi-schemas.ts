import type { SwaggerTransform, SwaggerTransformObject } from '@fastify/swagger'
import { openApiComponents } from '@kchs/contracts'
import {
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
} from 'fastify-type-provider-zod'

/**
 * Схемы zod → JSON Schema спецификации OpenAPI (ADR-0188). Рекурсивные схемы контрактов
 * описаны именованными компонентами (`openApiComponents`), операции ссылаются на них.
 */
export function openApiSchemaTransforms(): {
  transform: SwaggerTransform
  transformObject: SwaggerTransformObject
} {
  const schemaRegistry = openApiComponents()
  const withComponents = createJsonSchemaTransformObject({ schemaRegistry })
  const transformObject: SwaggerTransformObject = (input) => {
    const document = withComponents(input) as {
      components?: { schemas?: Record<string, Record<string, unknown>> }
    }
    // `$id` вида `#/components/schemas/…` и `$schema` компонента — следы преобразования zod:
    // адрес компонента — его место в документе, диалект задаёт спецификация 3.1
    for (const schema of Object.values(document.components?.schemas ?? {})) {
      delete schema.$id
      delete schema.$schema
    }
    return document as ReturnType<SwaggerTransformObject>
  }
  return { transform: createJsonSchemaTransform({ schemaRegistry }), transformObject }
}
